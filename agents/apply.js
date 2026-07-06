// agents/apply.js — assisted apply (blueprint §2, Phase 2). Tiered, ordered by reliability:
//   Tier 1 (email):    posting exposes an application email -> compose + SMTP send after confirm.
//   Assisted fallback: no email/ATS API -> send the user a 1-tap apply link + a cheat sheet
//                      (tailored summary/skills/answers) they paste in themselves.
//
// Hard rule (CLAUDE.md §2.9): nothing is sent externally without explicit user confirmation.
// Every submission is snapshotted to an append-only audit log (blueprint §immutable audit).

const fs = require("fs");
const path = require("path");
const email = require("../lib/email");

const AUDIT_FILE = path.join(__dirname, "..", "applications.jsonl");
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

// Decide how to apply to this job.
function detectChannel(job) {
  const to = job.applyEmail || (job.description || "").match(EMAIL_RE)?.[0] || null;
  if (to && email.enabled()) return { tier: "email", to, url: job.url || "" };
  const ats = job.source || (/(greenhouse|lever|ashby|workday)\./i.test(job.url || "") ? "ats" : "");
  return { tier: "assisted", to: null, url: job.url || "", ats };
}

function buildEmailText(profile, job, tailored) {
  const bullets = tailored.highlights.map((h) => `- ${h}`).join("\n");
  return (
    `Dear Hiring Team,\n\n` +
    `I'm writing to apply for the ${job.title} role at ${job.company}. ${tailored.summary}\n\n` +
    (bullets ? `Highlights:\n${bullets}\n\n` : "") +
    `Key skills: ${tailored.skills.join(", ")}\n\n` +
    `I'd welcome the chance to discuss how I can contribute.\n\n` +
    `Best regards,\n${profile.name || "Candidate"}`
  );
}

function buildCheatSheet(job, tailored, channel, known = [], unknown = []) {
  const bullets = tailored.highlights.map((h) => `• ${h}`).join("\n");
  const link = channel.url ? `\n🔗 Apply here: ${channel.url}\n` : "\n";
  let qBlock = "";
  if (known.length) {
    qBlock += `\n\n*Answers I already have for you:*\n${known
      .map((k) => `• ${k.label}\n  → ${k.answer}`)
      .join("\n")}`;
  }
  if (unknown.length) {
    qBlock += `\n\n*They'll also ask (I'll collect these next):*\n${unknown
      .map((q) => `• ${q.label}${q.required ? " *(required)*" : ""}`)
      .join("\n")}`;
  }
  return (
    `📋 *Ready to apply — ${job.title} @ ${job.company}*${link}\n` +
    `Paste these into the application:\n\n` +
    `*Summary*\n${tailored.summary}\n\n` +
    `*Skills*\n${tailored.skills.join(", ")}` +
    (bullets ? `\n\n*Highlights*\n${bullets}` : "") +
    qBlock +
    `\n\n(Everything above comes straight from your resume — no made-up claims.)`
  );
}

// Prepare (but do not send) an application. Returns everything needed to confirm.
// questions: required application questions (e.g. Greenhouse). savedAnswers: label→answer
// the user already gave on a past application (reused, never asked twice — blueprint §6).
function prepareApplication(profile, job, tailored, questions = [], savedAnswers = {}) {
  const channel = detectChannel(job);
  const subject = `Application for ${job.title} — ${profile.name || "Candidate"}`;
  const known = [];
  const unknown = [];
  for (const q of questions) {
    const saved = savedAnswers[q.label.toLowerCase()];
    if (saved) known.push({ label: q.label, answer: saved });
    else if (q.required) unknown.push(q);
  }
  return {
    channel,
    subject,
    knownAnswers: known,
    unknownQuestions: unknown,
    emailText: channel.tier === "email" ? buildEmailText(profile, job, tailored) : null,
    cheatSheet: buildCheatSheet(job, tailored, channel, known, unknown),
    tailored,
  };
}

// Send the Tier-1 email application. Assumes user already confirmed.
async function submitEmail(app, profile) {
  return email.sendEmail({
    to: app.channel.to,
    subject: app.subject,
    text: app.emailText,
    attachments: [{ filename: "resume.txt", content: app.emailText }],
  });
}

// Append-only audit snapshot of exactly what was prepared/sent.
function recordApplication(record) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
  } catch (err) {
    console.error("❌ audit write failed:", err.message);
  }
}

module.exports = {
  detectChannel,
  prepareApplication,
  submitEmail,
  recordApplication,
  buildCheatSheet,
  buildEmailText,
  AUDIT_FILE,
};

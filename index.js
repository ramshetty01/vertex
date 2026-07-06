// WhatsApp Job Bot — Step 3: real matching wired in
// Run: node index.js
// .env needs: NVIDIA_API_KEY + messaging provider vars (see lib/messaging.js)
//   MESSAGING_PROVIDER=kapso (official, no cap) | wwebjs (testing) | twilio (9/day cap)
//
// Flow: AWAITING_RESUME -> (ack instantly, parse in background) -> CONFIRMING_PROFILE
//       -> intake (location/salary/notice) -> score jobs in background -> AWAITING_JOB_RESPONSE
//       -> job cards, 1/2/3 -> DONE
//
// All replies go out via the messaging gateway (REST), so the webhook just acks 200.

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { parseResume } = require("./agents/parser");
const editor = require("./agents/editor");
const matcher = require("./agents/matcher");
const { answerQuestion } = require("./agents/inquiry");
const { tailorResume, formatTailoredPreview } = require("./agents/tailor");
const { writeCoverLetter } = require("./agents/coverletter");
const applyAgent = require("./agents/apply");
const { fetchJobs, dedupe, jobKey } = require("./lib/jobs");
const ats = require("./lib/ats");
const payments = require("./lib/payments");
const checkout = require("./lib/checkout");
const store = require("./lib/store");
const messaging = require("./lib/messaging");

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
// Capture the raw JSON body too, so we can verify Razorpay webhook signatures.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, "public"))); // serves the checkout page

// Push an outbound message; never let a send failure crash the handler.
async function sendMessage(to, body) {
  try {
    await messaging.sendMessage(to, body);
  } catch (err) {
    console.error("❌ Failed to send message:", err.response?.data || err.message);
  }
}

// Push an interactive message (native buttons/list on Kapso; text fallback elsewhere).
async function sendInteractive(to, spec) {
  try {
    await messaging.sendInteractive(to, spec);
  } catch (err) {
    console.error("❌ Failed to send interactive:", err.response?.data || err.message);
  }
}

// Job-card reply buttons — ids match the tokens the handler expects (tap == type "1").
const JOB_BUTTONS = [
  { id: "1", title: "✅ Interested" },
  { id: "2", title: "❌ Not interested" },
  { id: "3", title: "💬 Ask about role" },
];
// After an inquiry answer: decide buttons only (asking again is just free text).
const INQUIRY_BUTTONS = [
  { id: "1", title: "✅ Interested" },
  { id: "2", title: "❌ Skip" },
];
// One-tap Not-Interested reasons (blueprint §7 feedback loop). ids map to feedback keys.
const SKIP_REASON_ROWS = [
  { id: "r_salary", title: "Salary too low" },
  { id: "r_location", title: "Wrong location" },
  { id: "r_role", title: "Wrong role" },
  { id: "r_company", title: "Not this company" },
  { id: "r_other", title: "Just not for me" },
];
const REASON_MAP = {
  r_salary: "salaryLow",
  r_location: "wrongLocation",
  r_role: "wrongRole",
  r_company: "company",
};

// UPLOAD_DIR can point at a mounted volume in prod (e.g. /data/resumes) so uploads
// survive redeploys; defaults to a local folder in dev.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "resumes");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- Per-user conversation state — in-memory working set, backed by SQLite (§2.7) ----
const users = new Map();

function getUser(from) {
  if (!users.has(from)) {
    const loaded = store.load(from); // survives restarts
    users.set(
      from,
      loaded || {
        id: from,
        state: "AWAITING_RESUME",
        resumePath: null,
        profile: null,
        intake: { locationPref: null, expectedSalaryLPA: null, noticePeriod: null },
        feedback: { salaryLow: 0, wrongLocation: 0, wrongRole: 0, company: 0 }, // Not-Interested reasons
        pendingSkip: null,  // job awaiting a skip-reason tap
        paid: false,        // paywall: unlocked after first payment
        pendingAction: null, // action to resume after payment { type, job }
        pendingApply: null,  // prepared application awaiting confirm { job, app }
        savedAnswers: {},   // custom-question relay: question label(lower) → answer (reused)
        relay: null,        // in-progress question relay { questions:[label], idx, job }
        applications: [],   // tracker: { title, company, tier, status, ts }
        matches: [],        // real scored jobs, filled in by the matcher
        currentJobIndex: 0,
        seenJobKeys: [],    // every job key ever shown — so proactive push only surfaces NEW ones
        pendingStatusIdx: null,  // application index being status-updated
        statusReturnState: null, // state to resume after a status check-in
      }
    );
  }
  return users.get(from);
}

// Write a user's current state to SQLite. Called after the handler and after each
// background operation that mutates state. No-op if the user was removed (restart).
function persist(from) {
  const u = users.get(from);
  if (u) store.save(from, u);
}

// Sample jobs — used as a fallback when Adzuna sourcing is unavailable (no keys / no
// results). Real jobs come from lib/jobs.js (Adzuna) via sourceJobsForUser().
const CANDIDATE_JOBS = [
  {
    title: "AI Automation Intern",
    company: "FlowStack",
    location: "Hyderabad (Hybrid)",
    salary: "₹25k/month stipend",
    description:
      "Looking for an intern to build AI automation workflows using Python and LLM APIs. " +
      "Experience with LangChain or agent frameworks a big plus. Build chatbots and " +
      "automate backend workflows. Students welcome, 0-1 years experience.",
  },
  {
    title: "Junior ML Engineer",
    company: "DataPeak",
    location: "Remote (India)",
    salary: "₹6-9 LPA",
    description:
      "Junior role building ML pipelines. Python, scikit-learn, model deployment. " +
      "1-2 years experience preferred but strong freshers considered.",
  },
  {
    title: "Prompt Engineer / LLM Application Developer",
    company: "NimbusAI",
    location: "Bengaluru (Hybrid)",
    salary: "₹5-8 LPA",
    description:
      "Build LLM-powered applications: RAG pipelines, agent workflows, chatbot products. " +
      "Python required, LangChain experience strongly preferred. 0-2 years.",
  },
];

function formatJobCard(job) {
  return (
    `💼 *${job.title}*\n` +
    `🏢 ${job.company}\n` +
    `📍 ${job.location}  |  💰 ${job.salary}\n\n` +
    `🎯 *Fit: ${job.fit}%* — ${job.strengths}` +
    (job.gaps && job.gaps !== "None significant" ? `\n⚠️ Gap: ${job.gaps}` : "")
  );
}

function formatProfileSummary(profile) {
  const skillList = (profile.skills || [])
    .map((s) => (s.years ? `${s.name} (${s.years} yrs)` : s.name))
    .slice(0, 6)
    .join(", ");
  return (
    `✅ Here's what I understood from your resume:\n\n` +
    `👤 ${profile.name || "Name not found"}\n` +
    `🛠 ${skillList || "No skills detected"}\n` +
    `📊 ~${profile.total_experience_years ?? "?"} yrs experience\n\n` +
    `Reply *ok* if that looks right, or tell me what to fix.`
  );
}

async function downloadResume(inbound, from) {
  const buf = await inbound.downloadMedia(); // provider-specific fetch (URL or in-message)
  const safeName = from.replace(/[^0-9]/g, "") + "-" + Date.now() + ".pdf";
  const filePath = path.join(UPLOAD_DIR, safeName);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// Parse a resume PDF in the background, then push the profile summary. Shared by the
// initial upload AND a re-upload during edit. Caller sends the instant ack (§2.6).
function startParse(user, from, inbound) {
  user.state = "PARSING";
  (async () => {
    try {
      user.resumePath = await downloadResume(inbound, from);
      console.log(`📎 Resume saved: ${user.resumePath}`);
      const profile = await parseResume(user.resumePath);
      user.profile = profile;
      console.log(`🧠 Parsed profile:`, JSON.stringify(profile));
      user.state = "CONFIRMING_PROFILE";
      await sendMessage(from, formatProfileSummary(profile));
    } catch (err) {
      console.error("❌ Parse error:", err.message);
      user.state = "AWAITING_RESUME";
      await sendMessage(
        from,
        err.message === "EMPTY_PDF"
          ? "😅 I couldn't read that PDF — it may be scanned or locked. Please send a regular PDF."
          : "Oops, something went wrong analyzing your resume. Please send it again."
      );
    } finally {
      persist(from);
    }
  })();
}

// Apply a free-text correction to the confirmed-but-unconfirmed profile, then re-show
// the summary for another confirm. Runs in the background (LLM ~10s) per §2.6.
function startEdit(user, from, correction) {
  const prev = user.profile;
  user.state = "EDITING_PROFILE";
  (async () => {
    try {
      const updated = await editor.applyCorrection(prev, correction);
      user.profile = updated;
      console.log(`✏️ Profile edited for ${from}:`, JSON.stringify(updated));
      user.state = "CONFIRMING_PROFILE";
      await sendMessage(from, formatProfileSummary(updated));
    } catch (err) {
      console.error("❌ Edit error:", err.message);
      user.profile = prev; // never lose the working profile
      user.state = "CONFIRMING_PROFILE";
      await sendMessage(
        from,
        "Hmm, I couldn't apply that change. Reply *ok* to keep your profile as-is, or try rephrasing the fix."
      );
    } finally {
      persist(from);
    }
  })();
}

// ---- Structured intake (blueprint Step 3) — the answers become matcher signals ----
// Twilio sandbox has no interactive buttons, so we use numbered text menus.
const INTAKE_Q = {
  location:
    "📍 First — where do you want to work?\n\n" +
    "Reply with a *city* (e.g. Hyderabad), or *remote*, or *any* if you're flexible.",
  salary:
    "💰 What's your *minimum expected salary* (in LPA)?\n\n" +
    "Reply with a number (e.g. 6), or *skip*.",
};
// Notice period is a native list (ids reused by NOTICE_MAP; a tap sends the id).
const NOTICE_QUESTION = "📅 Last one — when can you start?";
const NOTICE_ROWS = [
  { id: "1", title: "Immediately" },
  { id: "2", title: "Within 15 days" },
  { id: "3", title: "Within 30 days" },
  { id: "4", title: "60+ days" },
];
const NOTICE_MAP = { "1": "Immediate", "2": "15 days", "3": "30 days", "4": "60+ days" };

// Build an Adzuna query from the profile (titles + top skills) and fetch real jobs.
// Falls back to the sample list if sourcing is unavailable (no keys / no results / error).
async function sourceJobsForUser(user) {
  const p = user.profile || {};
  // Build a concise keyword set: role words from titles (minus generic seniority terms)
  // + top skills. Used with Adzuna what_or (match ANY) for good recall; matcher filters.
  const GENERIC = new Set(["intern", "junior", "senior", "freelance", "project", "trainee", "the", "and"]);
  const titleWords = (p.titles || [])
    .join(" ")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !GENERIC.has(w));
  const skills = (p.skills || []).map((s) => s.name).slice(0, 3);
  // Skills first (stronger Adzuna terms), capped short — long niche queries return nothing.
  const query = [...new Set([...skills, ...titleWords])].slice(0, 4).join(" ").trim() || "software";
  const loc = user.intake.locationPref;
  const location = loc && !["any", "remote"].includes(loc.toLowerCase()) ? loc : "";

  const pool = [];
  // Adzuna (aggregator)
  try {
    const jobs = await fetchJobs(query, { location, broad: true });
    console.log(`🔎 Adzuna: ${jobs.length} jobs (query: "${query}")`);
    pool.push(...jobs);
  } catch (err) {
    console.log(`🔎 Adzuna unavailable (${err.message}).`);
  }
  // Direct ATS boards (Greenhouse/Lever) — free, fresh, filtered to the query
  if (ats.hasBoards()) {
    try {
      const atsJobs = ats.filterByQuery(await ats.fetchAtsJobs(), query, 6);
      console.log(`🔎 ATS boards: ${atsJobs.length} jobs after filter`);
      pool.push(...atsJobs);
    } catch (err) {
      console.log(`🔎 ATS unavailable (${err.message}).`);
    }
  }

  const merged = dedupe(pool).slice(0, 10);
  if (merged.length) return merged;
  console.log("🔎 No sourced jobs — using sample list.");
  return CANDIDATE_JOBS;
}

// Kick off background job scoring using profile + intake prefs, then push results.
function startMatching(user, from) {
  user.state = "MATCHING";
  (async () => {
    try {
      const candidates = await sourceJobsForUser(user);
      const prefs = { ...user.intake, feedback: user.feedback };
      const matches = await matcher.findMatches(user.profile, candidates, prefs, 75);
      user.matches = matches;
      user.currentJobIndex = 0;
      markSeen(user, matches); // remember these so proactive push won't repeat them
      console.log(`🎯 ${matches.length} match(es) ≥75% for ${from}`);

      if (matches.length === 0) {
        user.state = "DONE";
        await sendMessage(
          from,
          "I couldn't find any jobs above 75% fit for you right now 😕\n\n" +
            "I'll keep looking and message you the moment a strong match comes in!"
        );
      } else {
        user.state = "AWAITING_JOB_RESPONSE";
        await sendInteractive(from, {
          body: `Found ${matches.length} strong match(es)! Here's your first:\n\n` + formatJobCard(matches[0]),
          buttons: JOB_BUTTONS,
        });
      }
    } catch (err) {
      console.error("❌ Matching error:", err.message);
      user.state = "DONE";
      await sendMessage(
        from,
        "Oops, something went wrong finding your matches. Type *restart* to try again."
      );
    } finally {
      persist(from);
    }
  })();
}

// Record job keys as "shown" so the proactive matcher never re-pushes them.
// Bounded to the last 500 keys so the list can't grow without limit.
function markSeen(user, jobs) {
  if (!user.seenJobKeys) user.seenJobKeys = [];
  const set = new Set(user.seenJobKeys);
  for (const j of jobs) set.add(jobKey(j));
  user.seenJobKeys = Array.from(set).slice(-500);
}

// Proactive retention loop (blueprint §9): sweep every stored user who has finished
// onboarding and run out of matches, re-source + re-score jobs, and push any that are
// genuinely NEW (not seen before). Returns a summary for logging/admin.
//
// ⚠️ WhatsApp policy: a business-initiated message outside the user's 24h session
// window requires an approved message TEMPLATE. Within 24h (active pilot users) a
// plain message is fine. Template wiring is deferred until a template is approved;
// this engine produces the content and does the matching either way.
async function runProactiveMatches(pushFn = pushItem) {
  const summary = { swept: 0, pushed: 0, users: [] };
  for (const { id } of store.all()) {
    const user = getUser(id); // canonical in-memory object (lazy-loads from store)
    // Only nudge users who finished onboarding AND have nothing left to review.
    if (!user.profile || user.state !== "DONE") continue;
    summary.swept++;
    try {
      const candidates = await sourceJobsForUser(user);
      const prefs = { ...user.intake, feedback: user.feedback };
      const scored = await matcher.findMatches(user.profile, candidates, prefs, 75);
      const seen = new Set(user.seenJobKeys || []);
      const fresh = scored.filter((m) => !seen.has(jobKey(m)));
      if (!fresh.length) continue;

      const startIdx = user.matches.length;
      user.matches = user.matches.concat(fresh);
      user.currentJobIndex = startIdx; // point at the first new card
      user.state = "AWAITING_JOB_RESPONSE";
      markSeen(user, fresh);
      summary.pushed += fresh.length;
      summary.users.push(id);

      await pushFn(id, {
        interactive: {
          body:
            `🔔 ${fresh.length} new match${fresh.length > 1 ? "es" : ""} above 75% fit came in!\n\n` +
            formatJobCard(fresh[0]),
          buttons: JOB_BUTTONS,
        },
      });
    } catch (err) {
      console.error(`❌ Proactive match failed for ${id}:`, err.message);
    } finally {
      persist(id);
    }
  }
  console.log(`🔔 Proactive sweep: ${summary.pushed} new match(es) to ${summary.users.length}/${summary.swept} user(s)`);
  return summary;
}

// Advance past the current job and return an outbox item: the next job card as
// interactive buttons, or a plain-text wrap-up when the list is exhausted.
function advanceToNext(user) {
  user.currentJobIndex++;
  if (user.currentJobIndex < user.matches.length) {
    user.state = "AWAITING_JOB_RESPONSE";
    return { interactive: { body: formatJobCard(user.matches[user.currentJobIndex]), buttons: JOB_BUTTONS } };
  }
  user.state = "DONE";
  return {
    text:
      "🎉 That's all your matches for today — I'll ping you when new ones above 75% fit come in.\n\n" +
      "Send *restart* to try the demo again.",
  };
}

// Prepend an acknowledgement line to an outbox item.
function withAck(item, ack) {
  if (item.interactive) item.interactive.body = `${ack}\n\n━━━━━━━━━━\n${item.interactive.body}`;
  else item.text = `${ack}\n\n${item.text}`;
  return item;
}

// Record an Interested/Skip decision, advance, and return the combined reply.
function decideAndAdvance(user, job, interested) {
  const ack = interested
    ? `🚀 Great! I've noted your interest in *${job.title}* at ${job.company}.\n` +
      `(In the full version, I'd now prepare and submit your application.)`
    : `👍 Noted — skipping *${job.title}*.`;
  return withAck(advanceToNext(user), ack);
}

// Send an outbox item (text or interactive) directly — used outside the handler.
async function pushItem(to, item) {
  if (item.interactive) await sendInteractive(to, item.interactive);
  else await sendMessage(to, item.text);
}

const APPLY_BUTTONS = [
  { id: "1", title: "✅ Send it" },
  { id: "2", title: "✋ Skip" },
];

// Application status ladder (blueprint §119). Auto-detection (email/ATS) is external,
// so the user drives progress with one-tap "any update?" check-ins.
const STATUS_LADDER = ["Prepared", "Submitted", "Viewed", "Response", "Interview", "Closed"];
const STATUS_EMOJI = { Prepared: "📝", Submitted: "📨", Viewed: "👀", Response: "💬", Interview: "🎤", Closed: "📁" };
const statusRank = (s) => { const i = STATUS_LADDER.indexOf(s); return i < 0 ? 0 : i; };

// Applications the user can still update (everything not Closed), newest first.
function activeApplications(user) {
  return (user.applications || [])
    .map((a, idx) => ({ a, idx }))
    .filter(({ a }) => a.status !== "Closed")
    .reverse();
}

// Status choices ahead of the current one (you can only move forward), + Closed.
function statusPickRows(current) {
  return STATUS_LADDER.slice(statusRank(current) + 1).map((s) => ({
    id: `st_${s}`,
    title: `${STATUS_EMOJI[s] || ""} ${s}`.trim(),
  }));
}

// Application tracker / weekly-digest content (blueprint §9 retention loop).
function buildDigest(user) {
  const apps = user.applications || [];
  const remaining = Math.max(0, (user.matches || []).length - user.currentJobIndex);
  if (!apps.length && !remaining) {
    return "📊 No applications yet. Send your resume as a *PDF* to get matched with jobs!";
  }
  const submitted = apps.filter((a) => statusRank(a.status) >= statusRank("Submitted")).length;
  const interviews = apps.filter((a) => a.status === "Interview").length;
  const list = apps
    .slice(-8)
    .map((a) => `${STATUS_EMOJI[a.status] || "•"} ${a.title} @ ${a.company} — _${a.status}_`)
    .join("\n");
  return (
    `📊 *Your job search so far*\n\n` +
    `• Applications: *${apps.length}* (${submitted} submitted+${interviews ? `, ${interviews} interviewing` : ""})\n` +
    `• Matches still to review: *${remaining}*\n` +
    (list ? `\n${list}\n` : "") +
    `\n💡 Got news on any? Type *update* to log progress. Or *restart* for new matches.`
  );
}

// One concrete profile-improvement tip for the weekly digest (blueprint §119).
// Picks the most useful nudge from what's missing/stalled; always returns something.
function profileTip(user) {
  const p = user.profile || {};
  const skills = (p.skills || []).length;
  const apps = user.applications || [];
  const remaining = Math.max(0, (user.matches || []).length - user.currentJobIndex);
  if (!p.total_experience_years && !skills) return "Send an updated resume PDF — the more detail, the better your matches.";
  if (skills < 3) return "Add a few more skills to your profile (type *edit*) — it widens your matches.";
  if (!(user.intake && user.intake.locationPref)) return "Set a location preference (type *edit*) so I can prioritise nearby roles.";
  if (remaining > 0) return `You've *${remaining}* match${remaining > 1 ? "es" : ""} still to review — reply *restart* to see them.`;
  const stalledSubmitted = apps.some((a) => a.status === "Submitted");
  if (stalledSubmitted) return "Heard back from anyone? Type *update* to log interviews — it helps me tune your matches.";
  return "Keep your resume fresh — re-send a PDF anytime to refine your matches.";
}

// Weekly digest content = the tracker + a profile-improvement tip (retention heartbeat).
function buildWeeklyDigest(user) {
  return `🗓️ *Your weekly job update*\n\n` + buildDigest(user) + `\n\n💡 *Tip:* ${profileTip(user)}`;
}

// Push the weekly digest to every onboarded user who has something worth hearing
// (an application or matches still to review). Skips brand-new/empty users so we
// don't spam. Same 24h-template caveat as the proactive sweep (see DEPLOY.md §6).
async function runDigestPush(pushFn = (to, text) => sendMessage(to, text)) {
  const summary = { swept: 0, sent: 0 };
  for (const { id } of store.all()) {
    const user = getUser(id);
    if (!user.profile) continue;
    const apps = user.applications || [];
    const remaining = Math.max(0, (user.matches || []).length - user.currentJobIndex);
    if (!apps.length && !remaining) continue; // nothing useful to say yet
    summary.swept++;
    try {
      await pushFn(id, buildWeeklyDigest(user));
      summary.sent++;
    } catch (err) {
      console.error(`❌ Digest push failed for ${id}:`, err.message);
    }
  }
  console.log(`🗓️ Weekly digest: sent to ${summary.sent}/${summary.swept} user(s)`);
  return summary;
}

// Custom-question relay (blueprint §6): ask the job's unknown required questions one
// by one; each answer is saved to user.savedAnswers and reused on future applications.
async function startRelay(user, from, questions, job) {
  user.relay = {
    questions: questions.map((q) => q.label),
    idx: 0,
    job: { title: job.title, company: job.company },
  };
  user.state = "RELAY_QUESTIONS";
  await sendMessage(
    from,
    `📝 This role asks a couple of questions — your answers get *saved & reused* next time.\n\n` +
      `Q: ${questions[0].label}\n\n(Reply your answer, or *skip* / *done*.)`
  );
}

// Application rate limit (blueprint §46: "Rate-limit applications per user per day —
// quality over volume also improves response rates"). Counts actual submissions
// (user.applications, recorded at send time) in a rolling 24h window. 0 disables.
const APPLIES_PER_DAY = parseInt(process.env.APPLIES_PER_DAY || "10", 10);
function appliesInLast24h(user) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (user.applications || []).filter((a) => (a.ts || 0) >= cutoff).length;
}
const applyQuotaExceeded = (user) => APPLIES_PER_DAY > 0 && appliesInLast24h(user) >= APPLIES_PER_DAY;

// Interested → tailor a resume, prepare the application, and ask for one-tap confirm
// (CLAUDE.md §2.9: nothing goes out externally without explicit confirmation).
function startApply(user, from, job) {
  // Daily cap — refuse before spending LLM cost; let the user keep browsing.
  if (applyQuotaExceeded(user)) {
    user.state = "AWAITING_JOB_RESPONSE";
    (async () => {
      await sendMessage(
        from,
        `⏳ You've hit today's limit of *${APPLIES_PER_DAY} applications*. Quality beats volume — ` +
          `targeted applications get more responses. I'll have fresh matches for you tomorrow!\n\n` +
          `(You can still browse: reply *2* to skip or *3* to ask about this role.)`
      );
      persist(from);
    })();
    return;
  }
  user.state = "PREPARING_APPLY";
  (async () => {
    try {
      const tailored = await tailorResume(user.profile, job);
      const coverLetter = await writeCoverLetter(user.profile, job, tailored).catch(() => null);
      // Greenhouse exposes the required application questions — fetch them for the cheat sheet.
      let questions = [];
      if (job._ats && job._ats.platform === "greenhouse") {
        questions = await ats.fetchGreenhouseQuestions(job._ats.token, job._ats.id).catch(() => []);
      }
      const app = applyAgent.prepareApplication(user.profile, job, tailored, questions, user.savedAnswers, coverLetter);
      user.pendingApply = { job, app };
      user.state = "CONFIRM_APPLY";
      const how =
        app.channel.tier === "email"
          ? `I'll email this application to *${app.channel.to}* on your behalf.`
          : `I'll give you a 1-tap apply link + a copy-paste cheat sheet.`;
      await sendMessage(from, formatTailoredPreview(job, tailored));
      await sendInteractive(from, {
        body: `${how}\n\nSend the application?`,
        buttons: APPLY_BUTTONS,
      });
    } catch (err) {
      console.error("❌ Prepare-apply error:", err.message);
      user.state = "AWAITING_JOB_RESPONSE";
      await sendMessage(from, "Sorry, I couldn't prepare that application. Reply *1* to retry or *2* to skip.");
    } finally {
      persist(from);
    }
  })();
}

// Referral / growth loop — a forwardable pitch + a wa.me deep link to this bot.
// BOT_WA_NUMBER is the bot's public WhatsApp number (digits, e.g. 9198…); if unset,
// the message still works but without a tappable link.
const BOT_WA_NUMBER = (process.env.BOT_WA_NUMBER || "").replace(/\D/g, "");
function inviteMessage() {
  const pitch =
    "🤖 Found a WhatsApp bot that matches jobs to your resume and helps you apply — all in chat. " +
    "Send it your resume as a PDF to try it:";
  const link = BOT_WA_NUMBER
    ? `https://wa.me/${BOT_WA_NUMBER}?text=Hi`
    : "(reply to this chat and I'll share the number)";
  return `📣 *Know someone job-hunting? Forward this:*\n\n${pitch}\n${link}`;
}

// Paywall (blueprint §5): free to browse/skip; the first Interested/Inquire needs payment.
const requiresPayment = (user) => payments.enabled() && !user.paid;

// Send a payment link and park the user until Razorpay's webhook unlocks them.
function startPaywall(user, from, action) {
  user.pendingAction = action;
  user.state = "AWAITING_PAYMENT";
  (async () => {
    try {
      const { url } = await payments.createPaymentLink(from);
      await sendMessage(
        from,
        `🔓 You've got matches worth acting on! Unlock full access (apply + ask about roles) ` +
          `for *₹${payments.PLAN_PRICE_INR}/week*:\n\n${url}\n\n` +
          `Once you pay, I'll continue automatically. ✅ (Type *back* to keep browsing free.)`
      );
    } catch (err) {
      console.error("❌ Payment link error:", err.response?.data || err.message);
      user.state = "AWAITING_JOB_RESPONSE"; // don't trap the user if payments break
      user.pendingAction = null;
      await sendMessage(from, "Sorry, I couldn't start checkout right now. Please try again in a moment.");
    } finally {
      persist(from);
    }
  })();
}

// Called from the Razorpay webhook once payment is confirmed.
async function unlockAndResume(user, from) {
  user.paid = true;
  const action = user.pendingAction;
  user.pendingAction = null;
  await sendMessage(from, "✅ Payment received — you're unlocked! Continuing...");
  if (action && action.type === "interested") {
    startApply(user, from, action.job);
  } else if (action && action.type === "inquire") {
    user.state = "INQUIRING";
    await sendMessage(from, `❓ Ask me anything about *${action.job.title}* at ${action.job.company}.`);
  } else {
    user.state = "AWAITING_JOB_RESPONSE";
  }
  persist(from); // startApply persists again on its own completion
}

// ---- Core message handler — shared by every provider (webhook OR push client) ----
async function handleInbound(inbound) {
  const { from, text, numMedia, mediaType } = inbound;

  const user = getUser(from);
  const outbox = [];
  // reply accepts a plain string, or an outbox item { text } / { interactive }.
  const reply = (item) => outbox.push(typeof item === "string" ? { text: item } : item);
  const replyList = (body, button, rows) => outbox.push({ interactive: { body, list: { button, rows } } });
  console.log(`📩 [${user.state}] ${from}: ${text}${numMedia ? ` (+media: ${mediaType})` : ""}`);

  const cmd = text.toLowerCase();
  const inJobFlow = [
    "AWAITING_JOB_RESPONSE", "INQUIRING", "SKIP_REASON", "AWAITING_PAYMENT",
    "PREPARING_APPLY", "CONFIRM_APPLY", "RELAY_QUESTIONS",
  ].includes(user.state);
  try {
    // ----- Global commands — work from ANY state, checked before the state machine -----
    if (cmd === "restart") {
      users.delete(from);
      store.remove(from);
      reply("🔄 Restarted! Send me your resume as a PDF to begin. 📄");
    } else if (["menu", "help", "?", "commands"].includes(cmd)) {
      reply(
        "🧭 *What you can do:*\n\n" +
          "• *Send a PDF* — upload/update your resume\n" +
          "• *edit* — review & update your profile\n" +
          "• *status* — your applications & progress\n" +
          "• *update* — log progress on an application (viewed / interview…)\n" +
          "• *invite* — share the bot with a friend\n" +
          "• *back* — re-show the current job\n" +
          "• *restart* — start over\n\n" +
          "On a job card, tap *Interested* / *Not interested* / *Ask about role* (or reply 1/2/3)."
      );
    } else if (["invite", "share", "refer"].includes(cmd)) {
      reply(inviteMessage());
    } else if (["status", "digest", "applications", "progress"].includes(cmd)) {
      reply(buildDigest(user));
    } else if (["update", "updates", "log"].includes(cmd)) {
      // One-tap "any update?" check-in (blueprint §119): pick an application, then a new status.
      const active = activeApplications(user);
      if (!active.length) {
        reply("You've no open applications to update yet. Apply to a job first, then type *update*. 🙂");
      } else {
        user.statusReturnState = user.state; // resume here after the update
        user.state = "UPDATE_PICK_APP";
        replyList(
          "📮 Which application got an update?",
          "Pick one",
          active.slice(0, 10).map(({ a, idx }) => ({
            id: `app_${idx}`,
            title: `${a.title} @ ${a.company}`.slice(0, 24),
          }))
        );
      }
    } else if (cmd === "edit" || cmd === "edit profile") {
      if (!user.profile) {
        reply("You haven't sent a resume yet — send it as a *PDF* to begin. 📄");
      } else {
        // Editable review: type a fix ("add Docker", "name is Ramesh") OR resend a PDF.
        user.state = "CONFIRMING_PROFILE"; // current profile stays until a change is confirmed
        reply(
          formatProfileSummary(user.profile) +
            "\n\n✏️ Tell me what to fix (e.g. \"add Docker\", \"I have 3 yrs Python\"), " +
            "or send a new resume PDF. Reply *ok* when it looks right."
        );
      }
    } else if (cmd === "back" && inJobFlow && user.matches[user.currentJobIndex]) {
      user.state = "AWAITING_JOB_RESPONSE";
      user.pendingSkip = null;
      user.pendingAction = null;
      user.pendingApply = null;
      user.relay = null;
      reply({
        interactive: { body: formatJobCard(user.matches[user.currentJobIndex]), buttons: JOB_BUTTONS },
      });
    } else {
      switch (user.state) {
      // ---------- Stage 1: get the resume ----------
      case "AWAITING_RESUME": {
        if (numMedia > 0 && mediaType === "application/pdf") {
          reply("✅ Got your resume! Analyzing your profile... ⏳");
          startParse(user, from, inbound); // background parse, pushes summary when done
        } else if (numMedia > 0) {
          reply("That file type isn't supported yet — please send your resume as a *PDF*. 📄");
        } else {
          reply(
            "👋 Hi! I'm your job search assistant.\n\n" +
              "I'll find jobs that fit you and help you apply — all here on WhatsApp.\n\n" +
              "To get started, *send me your resume as a PDF*. 📄"
          );
        }
        break;
      }

      // ---------- Stage 1.5: parsing in progress ----------
      case "PARSING": {
        reply("Still analyzing your resume... ⏳ One moment!");
        break;
      }

      // ---------- Stage 2: confirm the parsed profile, then score real jobs ----------
      case "CONFIRMING_PROFILE": {
        // Re-uploading a resume here replaces the profile (edit-by-resend).
        if (numMedia > 0 && mediaType === "application/pdf") {
          reply("✅ Got your new resume! Re-analyzing... ⏳");
          startParse(user, from, inbound);
          break;
        }
        const confirmed = ["ok", "yes", "correct", "y", "👍"].includes(text.toLowerCase());
        if (confirmed) {
          // Profile confirmed — collect preferences before matching (blueprint Step 3).
          reply(
            "Perfect! A few quick questions so I only send jobs that actually fit.\n\n" +
              INTAKE_Q.location
          );
          user.state = "INTAKE_LOCATION";
        } else {
          // Anything else is a correction — apply it, re-show, re-confirm (§2.8: the
          // user is stating their own facts, so this is not fabrication).
          reply("✏️ Updating your profile with that... ⏳");
          startEdit(user, from, text);
        }
        break;
      }

      // ---------- Stage 2.1: applying a profile correction ----------
      case "EDITING_PROFILE": {
        reply("✏️ Still applying your change... ⏳ One moment!");
        break;
      }

      // ---------- Stage 2a: intake — location preference ----------
      case "INTAKE_LOCATION": {
        const t = text.toLowerCase();
        user.intake.locationPref = ["any", "anywhere", "flexible"].includes(t) ? "any" : text;
        reply(INTAKE_Q.salary);
        user.state = "INTAKE_SALARY";
        break;
      }

      // ---------- Stage 2b: intake — expected salary ----------
      case "INTAKE_SALARY": {
        if (["skip", "any", "no"].includes(text.toLowerCase())) {
          user.intake.expectedSalaryLPA = null;
        } else {
          const num = parseFloat(text.replace(/[^0-9.]/g, ""));
          user.intake.expectedSalaryLPA = Number.isFinite(num) ? num : null;
        }
        replyList(NOTICE_QUESTION, "Pick availability", NOTICE_ROWS);
        user.state = "INTAKE_NOTICE";
        break;
      }

      // ---------- Stage 2c: intake — notice period, then start matching ----------
      case "INTAKE_NOTICE": {
        if (!NOTICE_MAP[text]) {
          replyList("Please pick one:", "Pick availability", NOTICE_ROWS);
          break; // stay in INTAKE_NOTICE until valid
        }
        user.intake.noticePeriod = NOTICE_MAP[text];
        console.log(`📋 Intake for ${from}:`, JSON.stringify(user.intake));
        reply("Got it! Finding your best-fit jobs now... ⏳");
        startMatching(user, from);
        break;
      }

      // ---------- Stage 2.5: matching in progress ----------
      case "MATCHING": {
        reply("Still finding your best matches... ⏳ Almost there!");
        break;
      }

      // ---------- Stage 3: react to real job cards ----------
      case "AWAITING_JOB_RESPONSE": {
        const job = user.matches[user.currentJobIndex];

        if (text === "1") {
          if (requiresPayment(user)) startPaywall(user, from, { type: "interested", job });
          else startApply(user, from, job);
        } else if (text === "2") {
          user.pendingSkip = job;
          user.state = "SKIP_REASON";
          replyList(
            "👍 Skipping. Quick — why not this one? (helps me match you better)",
            "Pick a reason",
            SKIP_REASON_ROWS
          );
        } else if (text === "3") {
          if (requiresPayment(user)) {
            startPaywall(user, from, { type: "inquire", job });
          } else {
            user.state = "INQUIRING";
            reply(
              `❓ Ask me anything about *${job.title}* at ${job.company} — ` +
                `e.g. "is it remote?" or "what tech will I use?"\n\n` +
                `(Or reply *1* Interested / *2* Skip to decide.)`
            );
          }
        } else {
          reply("👇 Tap a button on the job card above (or reply *1*, *2*, or *3*).");
        }
        break;
      }

      // ---------- Paywall: waiting for Razorpay payment to complete ----------
      case "AWAITING_PAYMENT": {
        if (text === "2") {
          // Let them keep browsing for free — skip the current job.
          const job = user.pendingSkip || user.matches[user.currentJobIndex];
          user.pendingAction = null;
          reply(withAck(advanceToNext(user), "No problem — skipping for now."));
        } else {
          reply(
            "⏳ Waiting for your payment to complete. Tap the link I sent, " +
              "or type *back* to keep browsing free matches."
          );
        }
        break;
      }

      // ---------- Stage 3b: answering questions about the current job ----------
      case "INQUIRING": {
        const job = user.matches[user.currentJobIndex];

        if (text === "1") {
          reply(decideAndAdvance(user, job, true));
        } else if (text === "2") {
          user.pendingSkip = job;
          user.state = "SKIP_REASON";
          replyList(
            "👍 Skipping. Quick — why not this one? (helps me match you better)",
            "Pick a reason",
            SKIP_REASON_ROWS
          );
        } else {
          // Free-text question → ask the inquiry agent in the background (LLM call ~10s).
          reply("🔎 Checking the posting...");
          const question = text;
          (async () => {
            try {
              const { answer, answered } = await answerQuestion(job, question);
              const tail = answered
                ? ""
                : "\n\n(Want me to include this as a question with your application?)";
              await sendInteractive(from, {
                body: `💬 ${answer}${tail}\n\nDecide below, or ask another question.`,
                buttons: INQUIRY_BUTTONS,
              });
            } catch (err) {
              console.error("❌ Inquiry error:", err.message);
              await sendMessage(
                from,
                "Sorry, I couldn't look that up right now. Reply *1*, *2*, or ask again."
              );
            } finally {
              persist(from);
            }
          })();
        }
        break;
      }

      // ---------- Stage 3c: capture the skip reason, then advance ----------
      case "SKIP_REASON": {
        const job = user.pendingSkip || user.matches[user.currentJobIndex];
        const key = REASON_MAP[text]; // r_other / free text → no counter, still advances
        if (key) user.feedback[key]++;
        console.log(`📉 Skip reason from ${from}: ${text} | feedback=${JSON.stringify(user.feedback)}`);
        user.pendingSkip = null;
        reply(withAck(advanceToNext(user), "Thanks — noted 👍 I'll factor that in."));
        break;
      }

      // ---------- Stage 3d: tailoring resume / preparing application ----------
      case "PREPARING_APPLY": {
        reply("✍️ Still preparing your application... ⏳ One moment!");
        break;
      }

      // ---------- Stage 3e: confirm before sending the application (§2.9) ----------
      case "CONFIRM_APPLY": {
        if (!user.pendingApply) {
          user.state = "AWAITING_JOB_RESPONSE";
          reply("Reply *1* Interested, *2* Not interested, or *3* Ask about role.");
          break;
        }
        const { job, app } = user.pendingApply;
        if (text === "1") {
          user.pendingApply = null;
          reply("📨 Sending your application...");
          (async () => {
            try {
              if (app.channel.tier === "email") {
                await applyAgent.submitEmail(app, user.profile, user.resumePath);
                applyAgent.recordApplication({
                  from, job: { title: job.title, company: job.company },
                  tier: "email", to: app.channel.to, status: "submitted",
                });
                user.applications.push({ title: job.title, company: job.company, tier: "email", status: "Submitted", ts: Date.now() });
                await sendMessage(from, `✅ Applied to *${job.title}* at ${job.company} — emailed to ${app.channel.to}.`);
              } else {
                applyAgent.recordApplication({
                  from, job: { title: job.title, company: job.company },
                  tier: "assisted", url: app.channel.url, status: "prepared",
                });
                user.applications.push({ title: job.title, company: job.company, tier: "assisted", status: "Prepared", ts: Date.now() });
                await sendMessage(from, app.cheatSheet);
                await sendMessage(from, "👆 Tap the link and paste the above — you're the final submitter. ✅");
              }
            } catch (err) {
              console.error("❌ apply submit:", err.message);
              await sendMessage(from, "Sorry, sending failed — I've kept the details. You can try again shortly.");
            }
            // Relay any unknown required questions before moving on; else next job.
            if (app.unknownQuestions && app.unknownQuestions.length) {
              await startRelay(user, from, app.unknownQuestions, job);
            } else {
              await pushItem(from, advanceToNext(user));
            }
            persist(from);
          })();
        } else if (text === "2") {
          user.pendingApply = null;
          reply(withAck(advanceToNext(user), "No problem — skipped applying."));
        } else {
          reply("Reply *1* to send the application, or *2* to skip.");
        }
        break;
      }

      // ---------- Stage 3f: relay the job's required questions, saving answers ----------
      case "RELAY_QUESTIONS": {
        const r = user.relay;
        if (!r || !r.questions.length) {
          user.relay = null;
          user.state = "AWAITING_JOB_RESPONSE";
          reply("All set 👍 Reply *1*, *2*, or *3* on a job.");
          break;
        }
        const finish = () => {
          user.relay = null;
          return withAck(advanceToNext(user), "✅ Saved your answers — I'll reuse them next time.");
        };
        if (cmd === "done") {
          reply(finish());
          break;
        }
        if (cmd !== "skip") {
          user.savedAnswers[r.questions[r.idx].toLowerCase()] = text; // save the answer
        }
        r.idx++;
        if (r.idx < r.questions.length) {
          reply(`Saved 👍\n\nQ: ${r.questions[r.idx]}\n\n(Reply your answer, or *skip* / *done*.)`);
        } else {
          reply(finish());
        }
        break;
      }

      // ---------- Status check-in: which application (blueprint §119) ----------
      case "UPDATE_PICK_APP": {
        const m = /^app_(\d+)$/.exec(text);
        const idx = m ? parseInt(m[1], 10) : NaN;
        const app = user.applications && user.applications[idx];
        if (!app) {
          const active = activeApplications(user);
          replyList("Please pick one:", "Pick one", active.slice(0, 10).map(({ a, idx: i }) => ({
            id: `app_${i}`, title: `${a.title} @ ${a.company}`.slice(0, 24),
          })));
          break; // stay until a valid pick
        }
        user.pendingStatusIdx = idx;
        const rows = statusPickRows(app.status);
        if (!rows.length) {
          user.state = user.statusReturnState || "DONE";
          reply(`That application is already at *${app.status}* — nothing further to log. 👍`);
          break;
        }
        user.state = "UPDATE_PICK_STATUS";
        replyList(`Current: _${app.status}_. What's the new status for *${app.title}*?`, "Pick status", rows);
        break;
      }

      // ---------- Status check-in: set the new status ----------
      case "UPDATE_PICK_STATUS": {
        const idx = user.pendingStatusIdx;
        const app = user.applications && user.applications[idx];
        const m = /^st_(.+)$/.exec(text);
        const newStatus = m && STATUS_LADDER.includes(m[1]) ? m[1] : null;
        if (!app || !newStatus) {
          if (app) replyList("Please pick a status:", "Pick status", statusPickRows(app.status));
          else { user.state = user.statusReturnState || "DONE"; reply("Hmm, lost track of that one — type *update* to try again."); }
          break;
        }
        app.status = newStatus;
        app.updatedAt = Date.now();
        applyAgent.recordApplication({
          from, job: { title: app.title, company: app.company }, tier: app.tier, status: newStatus, event: "status_update",
        });
        user.pendingStatusIdx = null;
        user.state = user.statusReturnState || "DONE";
        user.statusReturnState = null;
        const cheer = newStatus === "Interview" ? " 🎉 Fingers crossed!" : newStatus === "Response" ? " Nice — they're engaging!" : "";
        reply(`${STATUS_EMOJI[newStatus] || "✅"} Updated *${app.title}* → *${newStatus}*.${cheer}\n\nType *status* to see all, or *update* to log another.`);
        break;
      }

      // ---------- Stage 4: out of jobs ----------
      case "DONE": {
        reply(
          "🎉 That's all the matches for now! I'll message you when new jobs above 75% fit come in.\n\n" +
            "Send *restart* to try the demo again."
        );
        break;
      }
      }
    }
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    reply("Oops, something went wrong on my side. Please try again.");
  }

  // Persist the (possibly mutated) user, then push replies.
  persist(from);
  for (const item of outbox) {
    if (item.interactive) await sendInteractive(from, item.interactive);
    else await sendMessage(from, item.text);
  }
}

// ---- Request providers (kapso, twilio): WhatsApp POSTs here ----
app.post(["/", "/webhook"], async (req, res) => {
  const inbound = messaging.parseInbound(req);
  if (!inbound) return res.sendStatus(200); // ignore non-message events (delivery receipts, etc.)
  res.sendStatus(200); // ack fast, then handle
  handleInbound(inbound).catch((e) => console.error("❌ handler:", e.message));
});

// ================= Razorpay Standard Web Checkout =================
// Public config for the frontend — KEY_ID only, never the secret.
app.get("/api/config", (_req, res) => res.json({ key_id: checkout.KEY_ID }));

// STEP 1 — create an order.
app.post("/api/create-order", async (req, res) => {
  try {
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isFinite(amount) || amount < 100) {
      return res.status(400).json({ error: "amount must be an integer >= 100 (paise)" });
    }
    const order = await checkout.createOrder({
      amount,
      currency: req.body.currency || "INR",
      receipt: req.body.receipt,
    });
    res.json({ order_id: order.id, amount: order.amount, currency: order.currency });
  } catch (err) {
    const status = err && err.statusCode === 401 ? 401 : 500;
    console.error("❌ create-order:", (err && (err.error || err.message)) || err);
    res.status(status).json({ error: status === 401 ? "razorpay auth failed" : "order creation failed" });
  }
});

// STEP 3 — verify the payment signature. Never mark paid unless it matches.
app.post("/api/verify-payment", (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, error: "missing fields" });
  }
  const ok = checkout.verifyPaymentSignature({
    order_id: razorpay_order_id,
    payment_id: razorpay_payment_id,
    signature: razorpay_signature,
  });
  if (!ok) return res.status(400).json({ verified: false, error: "signature mismatch" });
  console.log(`✅ Checkout verified: ${razorpay_payment_id} (order ${razorpay_order_id})`);
  res.json({ verified: true, payment_id: razorpay_payment_id });
});
// =================================================================

// ---- Razorpay payment webhook — unlocks the user once payment is confirmed ----
app.post("/razorpay-webhook", async (req, res) => {
  const sig = req.headers["x-razorpay-signature"];
  if (!payments.verifySignature(req.rawBody, sig)) {
    console.error("❌ Razorpay webhook: bad signature");
    return res.sendStatus(400);
  }
  res.sendStatus(200); // ack fast
  try {
    const { paid, waFrom } = payments.parseEvent(req.body);
    if (paid && waFrom && users.has(waFrom)) {
      console.log(`💰 Payment confirmed for ${waFrom}`);
      await unlockAndResume(users.get(waFrom), waFrom);
    }
  } catch (e) {
    console.error("❌ Razorpay webhook handling:", e.message);
  }
});

// Mask a WhatsApp id (PII) for admin views: keep country-ish prefix + last 3 digits.
function maskId(id) {
  const digits = String(id).replace(/\D/g, "");
  if (digits.length <= 5) return "***";
  return `${digits.slice(0, 2)}***${digits.slice(-3)}`;
}

// Guard shared by admin routes. Returns true if allowed; else writes the response.
function adminGuard(req, res) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) { res.status(503).json({ error: "ADMIN_TOKEN not set" }); return false; }
  const given = req.headers["x-admin-token"] || req.query.token;
  if (given !== token) { res.status(403).json({ error: "forbidden" }); return false; }
  return true;
}

// Admin dashboard page (static HTML; the token is entered at runtime, not embedded).
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ---- Admin: pilot observability (aggregate, PII-masked). For Wizard-of-Oz monitoring. ----
app.get("/admin/stats", (req, res) => {
  if (!adminGuard(req, res)) return;
  const rows = store.all();
  const byState = {};
  let paid = 0, totalApps = 0, submitted = 0, withProfile = 0;
  const users = [];
  for (const { id, user } of rows) {
    byState[user.state] = (byState[user.state] || 0) + 1;
    if (user.paid) paid++;
    if (user.profile) withProfile++;
    const apps = user.applications || [];
    totalApps += apps.length;
    submitted += apps.filter((a) => statusRank(a.status) >= statusRank("Submitted")).length;
    users.push({
      id: maskId(id),
      state: user.state,
      hasProfile: !!user.profile,
      paid: !!user.paid,
      matches: (user.matches || []).length,
      applications: apps.length,
    });
  }
  res.json({
    users: rows.length,
    withProfile,
    paid,
    byState,
    applications: { total: totalApps, submitted },
    detail: users.slice(0, 100),
  });
});

// ---- Admin: trigger a proactive match sweep (blueprint §9 retention loop) ----
// Guarded by ADMIN_TOKEN (X-Admin-Token header or ?token=). Refuses if unset so the
// endpoint is never open by default. Intended for a cron/scheduler to hit on a timer.
app.post("/admin/run-matches", async (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json({ started: true }); // ack immediately; sweep runs in the background
  runProactiveMatches().catch((e) => console.error("❌ proactive sweep:", e.message));
});

// ---- Admin: send the weekly digest to all active users (blueprint §119 heartbeat) ----
app.post("/admin/send-digest", async (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json({ started: true });
  runDigestPush().catch((e) => console.error("❌ digest push:", e.message));
});

// Webhook verification (Kapso/Meta may GET the endpoint with a challenge to confirm it)
app.get("/webhook", (req, res) =>
  res.status(200).send(req.query["hub.challenge"] || req.query.challenge || "ok")
);

// Health check
app.get("/", (_req, res) => res.send("Job bot is running ✅"));

// Only start the server + messaging client when run directly (not when imported for tests).
if (require.main === module) {
  messaging.init({
    onMessage: (inbound) =>
      handleInbound(inbound).catch((e) => console.error("❌ handler:", e.message)),
  });
  const PORT = process.env.PORT || 3000; // Railway/hosts inject PORT
  app.listen(PORT, () => console.log(`🚀 Job bot listening on port ${PORT}`));
}

module.exports = { handleInbound, getUser, users, buildDigest, buildWeeklyDigest, profileTip, runProactiveMatches, runDigestPush, appliesInLast24h, applyQuotaExceeded, APPLIES_PER_DAY };
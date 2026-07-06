// agents/coverletter.js — per-job cover letter (blueprint §26: "a tailored resume
// variant, a cover letter if required"). Sibling to agents/tailor.js.
//
// Uses ONLY facts in the CANDIDATE PROFILE — never invents skills, employers, or
// experience the candidate lacks (CLAUDE.md §2.8). Returns { text }. On any LLM/JSON
// failure it falls back to a safe template built purely from profile fields, so the
// apply flow always has a letter.

const { complete } = require("../lib/llm");

const SYSTEM_PROMPT =
  "You write a short, professional cover letter for a specific job, using ONLY facts present in the " +
  "CANDIDATE PROFILE and the tailored highlights provided. Rules:\n" +
  "- NEVER claim skills, tools, employers, titles, or years the candidate does not have. If the job wants " +
  "something absent from the profile, simply do not mention it — do not fake it.\n" +
  "- 120-180 words, 3 short paragraphs: (1) the role you're applying for and a one-line hook, " +
  "(2) 2-3 concrete strengths drawn from the profile that match the job, (3) a brief close.\n" +
  "- Address it to the hiring team. First person. Plain text, no markdown, no placeholders like [Company] — " +
  "use the real company name given.\n" +
  "- Do NOT invent metrics, dates, or achievements not in the profile.\n" +
  "Output ONLY the cover letter text — no preamble, no 'Here is', no subject line.";

async function writeCoverLetter(profile, job, tailored = {}) {
  const skills = (profile.skills || []).map((s) => s.name).filter(Boolean);
  const userContent =
    `CANDIDATE PROFILE:\nName: ${profile.name || "Candidate"}\n` +
    `Titles: ${(profile.titles || []).join(", ") || "—"}\n` +
    `Skills: ${skills.join(", ") || "—"}\n` +
    `Total experience (yrs): ${profile.total_experience_years ?? "—"}\n` +
    `Tailored highlights: ${(tailored.highlights || []).join(" | ") || "—"}\n` +
    `Tailored summary: ${tailored.summary || "—"}\n\n` +
    `TARGET JOB:\nTitle: ${job.title}\nCompany: ${job.company}\n` +
    `Description: ${(job.description || "").slice(0, 3000)}`;

  let text = "";
  try {
    text = (await complete(SYSTEM_PROMPT, userContent, "strong")).trim();
  } catch (_) {
    text = "";
  }

  // Strip a stray leading "Here is..." line if the model added one despite instructions.
  text = text.replace(/^\s*(here('| i)s|sure|certainly)[^\n]*\n+/i, "").trim();

  // Fallback template — pure profile facts, no fabrication.
  if (text.length < 60) {
    const strong = skills.slice(0, 4).join(", ");
    text =
      `Dear Hiring Team,\n\n` +
      `I'm writing to apply for the ${job.title} role at ${job.company}. ` +
      (tailored.summary
        ? `${tailored.summary} `
        : `I'm a ${(profile.titles || [])[0] || "professional"}${strong ? ` skilled in ${strong}` : ""}. `) +
      `I believe my background aligns well with what this role calls for.\n\n` +
      (strong ? `In particular, my experience with ${strong} maps directly to your needs. ` : "") +
      `I'd welcome the chance to discuss how I can contribute.\n\n` +
      `Best regards,\n${profile.name || "Candidate"}`;
  }

  return { text: text.slice(0, 2000) };
}

module.exports = { writeCoverLetter };

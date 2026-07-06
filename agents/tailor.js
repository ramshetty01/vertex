// agents/tailor.js — per-job resume tailoring (blueprint §6, Phase 2).
// Reorders and rephrases the candidate's REAL experience to mirror the job's
// language. NEVER fabricates skills, employers, or experience (CLAUDE.md §2.8).
//
// Returns: { summary, highlights: [string], skills: [string] }
// A code-side guard drops any skill not present in the profile, so the model
// cannot sneak in a keyword the candidate doesn't actually have.

const { completeJSON } = require("../lib/llm");

const SYSTEM_PROMPT =
  "You tailor a candidate's resume to a specific job. Use ONLY facts present in the CANDIDATE PROFILE. " +
  "Respond with ONLY valid JSON, no markdown. Rules:\n" +
  "- NEVER invent skills, employers, titles, tools, or experience that are not in the profile. " +
  "If the job wants something the candidate lacks, simply omit it — do not claim it.\n" +
  "- Reorder and rephrase the candidate's REAL experience to emphasize what matches the job, " +
  "mirroring the job's keywords where they genuinely apply.\n" +
  '- "summary": 2-3 sentence professional summary, first person implied, no fabrication.\n' +
  '- "highlights": 3-5 short resume bullet strings drawn from the profile, most job-relevant first.\n' +
  '- "skills": the candidate\'s skills (from the profile) ordered by relevance to this job. ' +
  "Do NOT add skills that are not in the profile.\n" +
  'Schema: {"summary": string, "highlights": [string], "skills": [string]}';

/**
 * profile: parsed profile JSON  |  job: { title, company, description }
 */
async function tailorResume(profile, job) {
  const userContent =
    `CANDIDATE PROFILE:\n${JSON.stringify(profile)}\n\n` +
    `TARGET JOB:\nTitle: ${job.title}\nCompany: ${job.company}\n` +
    `Description: ${(job.description || "").slice(0, 4000)}`;

  let result;
  try {
    result = await completeJSON(SYSTEM_PROMPT, userContent, "strong");
  } catch (_) {
    result = {}; // fall back to a straight-from-profile version below
  }

  // ---- No-fabrication guard: skills must exist in the profile ----
  const profileSkills = (profile.skills || []).map((s) => (s.name || "").trim()).filter(Boolean);
  const lower = profileSkills.map((s) => s.toLowerCase());
  const rawSkills = Array.isArray(result.skills) ? result.skills.map(String) : [];
  let skills = rawSkills.filter((s) => lower.includes(s.trim().toLowerCase()));
  if (!skills.length) skills = profileSkills.slice(0, 8); // fallback to real skills

  const summary =
    typeof result.summary === "string" && result.summary.trim()
      ? result.summary.trim().slice(0, 600)
      : `${profile.name || "Candidate"} — ${(profile.titles || [])[0] || "professional"} with experience in ${
          profileSkills.slice(0, 3).join(", ") || "relevant areas"
        }.`;

  const highlights = (Array.isArray(result.highlights) ? result.highlights : [])
    .map((h) => String(h).trim())
    .filter(Boolean)
    .slice(0, 5);

  return { summary, highlights, skills: skills.slice(0, 12) };
}

// Render the tailored resume to a WhatsApp-friendly text preview.
function formatTailoredPreview(job, t) {
  const hl = t.highlights.length ? "\n" + t.highlights.map((h) => `• ${h}`).join("\n") : "";
  return (
    `📄 *Tailored resume for ${job.title} @ ${job.company}*\n\n` +
    `*Summary*\n${t.summary}\n\n` +
    `*Key skills*\n${t.skills.join(", ")}` +
    (hl ? `\n\n*Highlights*${hl}` : "")
  );
}

module.exports = { tailorResume, formatTailoredPreview };

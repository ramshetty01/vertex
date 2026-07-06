// agents/editor.js — applies a user's free-text correction to a parsed profile.
// Closes the CONFIRMING_PROFILE dead-end: the bot said "tell me what to fix" but
// never applied the fix. Here the USER is explicitly stating a fact, so §2.8's
// no-fabrication rule is satisfied by design — we change ONLY what the user states,
// and invent nothing beyond it.
//
// Returns the full updated profile JSON (same schema as agents/parser.js):
//   { name, skills: [{name, years|null}], titles, total_experience_years, education, locations }

const { completeJSON } = require("../lib/llm");

const SYSTEM_PROMPT =
  "You edit a candidate's structured resume profile based on ONE free-text correction from the candidate. " +
  "The candidate is the authority on their own facts. Respond with ONLY valid JSON, no markdown. Rules:\n" +
  "- Start from the CURRENT PROFILE. Apply ONLY the change the CORRECTION explicitly states " +
  "(fix a name, add/remove/rename a skill, set skill years, fix total experience, add/remove a title, " +
  "fix a location, fix education). Keep every other field EXACTLY as-is.\n" +
  "- Invent NOTHING beyond what the correction says. Do not add skills, years, employers, or experience " +
  "the candidate did not mention. If the correction is vague, off-topic, or not an editable fact, return the " +
  "profile UNCHANGED.\n" +
  "- A skill's \"years\" stays null unless the candidate states a number for it.\n" +
  "- Return the COMPLETE profile (all fields), not just the changed part.\n" +
  'Schema: {"name": string, "skills": [{"name": string, "years": number|null}], ' +
  '"titles": [string], "total_experience_years": number, ' +
  '"education": [string], "locations": [string]}';

async function applyCorrection(profile, correction) {
  const userContent =
    `CURRENT PROFILE:\n${JSON.stringify(profile)}\n\n` +
    `CORRECTION FROM CANDIDATE: ${String(correction || "").slice(0, 500)}`;

  let result;
  try {
    result = await completeJSON(SYSTEM_PROMPT, userContent, "strong");
  } catch (_) {
    return profile; // LLM/JSON failure → never lose the existing profile
  }

  // Defensive merge — trust the correction only for well-formed fields, else keep old.
  const skills = Array.isArray(result.skills)
    ? result.skills
        .filter((s) => s && typeof s.name === "string" && s.name.trim())
        .map((s) => ({
          name: s.name.trim(),
          years: Number.isFinite(Number(s.years)) && s.years !== null ? Number(s.years) : null,
        }))
    : profile.skills || [];

  const titles = Array.isArray(result.titles)
    ? result.titles.map(String).map((t) => t.trim()).filter(Boolean)
    : profile.titles || [];

  const education = Array.isArray(result.education)
    ? result.education.map(String).filter(Boolean)
    : profile.education || [];

  const locations = Array.isArray(result.locations)
    ? result.locations.map(String).filter(Boolean)
    : profile.locations || [];

  const totalExp = Number(result.total_experience_years);

  return {
    ...profile,
    name: typeof result.name === "string" && result.name.trim() ? result.name.trim() : profile.name,
    skills,
    titles,
    education,
    locations,
    total_experience_years: Number.isFinite(totalExp) ? totalExp : profile.total_experience_years,
  };
}

module.exports = { applyCorrection };

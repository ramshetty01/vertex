// agents/parser.js — resume PDF -> structured profile JSON
// Refactored to use the shared LLM client in lib/llm.js

const fs = require("fs");
const pdfParse = require("pdf-parse");
const { completeJSON } = require("../lib/llm");

const SYSTEM_PROMPT =
  "You extract structured data from resumes. Respond with ONLY valid JSON, no markdown. " +
  "Today's date is 2026-07-05 (use it to compute durations from date ranges). Rules:\n" +
  '- "skills": technical skills only. "years" must be null unless the resume EXPLICITLY states years for that skill, or it is clearly computable from work-experience date ranges where that skill was used. NEVER guess.\n' +
  '- "titles": job/internship titles held at companies only (e.g. "AI Intern"). NEVER include project names, product names, or things the candidate built.\n' +
  '- "total_experience_years": sum ONLY of dated work/internship ranges, rounded to 1 decimal. Education and personal projects do not count.\n' +
  '- "education": one entry per degree/institution pair. Do not split dates or course names into separate entries.\n' +
  '- "locations": geographic city names ONLY (e.g. "Hyderabad"). If a candidate location is a company, employer, or "Self-Employed", EXCLUDE it. If no city is found, return [].\n' +
  'Schema: {"name": string, "skills": [{"name": string, "years": number|null}], ' +
  '"titles": [string], "total_experience_years": number, ' +
  '"education": [string], "locations": [string]}';

async function parseResume(filePath) {
  const pdfText = (await pdfParse(fs.readFileSync(filePath))).text;

  if (!pdfText || pdfText.trim().length < 50) {
    throw new Error("EMPTY_PDF"); // scanned/protected PDF with no extractable text
  }

  const profile = await completeJSON(SYSTEM_PROMPT, pdfText.slice(0, 8000), "strong");

  // Defensive cleanup — never trust LLM output blindly
  const junkLocation = /self-employed|remote|freelance|\d{4}/i;
  profile.locations = (profile.locations || []).filter((l) => !junkLocation.test(l));
  profile.skills = Array.isArray(profile.skills) ? profile.skills : [];
  profile.titles = Array.isArray(profile.titles) ? profile.titles : [];

  return profile;
}

module.exports = { parseResume };
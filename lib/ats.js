// lib/ats.js — free, public, read-only job ingestion from ATS job boards
// (Greenhouse + Lever). These expose jobs without any key (blueprint §3, secondary
// source: "direct ATS job-board feeds ... completely safe to use"). Application
// SUBMISSION still needs the employer's key, so we only READ here; applying stays
// email (Tier 1) or assisted (cheat-sheet). Greenhouse also exposes the required
// application questions, which we fetch lazily to power the cheat-sheet / relay.
//
// Env: GREENHOUSE_BOARDS (comma list of board tokens, e.g. "stripe,vercel")
//      LEVER_COMPANIES  (comma list of company slugs, e.g. "netflix,leverdemo")

const axios = require("axios");
const { stripHtml } = require("./jobs");

const GREENHOUSE_BOARDS = (process.env.GREENHOUSE_BOARDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const LEVER_COMPANIES = (process.env.LEVER_COMPANIES || "").split(",").map((s) => s.trim()).filter(Boolean);
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

const hasBoards = () => GREENHOUSE_BOARDS.length > 0 || LEVER_COMPANIES.length > 0;

// ---- Greenhouse ----
async function fetchGreenhouseBoard(token) {
  const base = `https://boards-api.greenhouse.io/v1/boards/${token}`;
  const [meta, list] = await Promise.all([
    axios.get(base, { timeout: 15000 }).catch(() => ({ data: {} })),
    axios.get(`${base}/jobs?content=true`, { timeout: 15000 }),
  ]);
  const company = (meta.data && meta.data.name) || token;
  const jobs = (list.data && list.data.jobs) || [];
  return jobs.map((j) => {
    const description = stripHtml(j.content);
    const emailMatch = description.match(EMAIL_RE);
    return {
      title: j.title,
      company,
      location: (j.location && j.location.name) || "",
      salary: "Not stated",
      description,
      url: j.absolute_url || "",
      source: "greenhouse",
      applyEmail: emailMatch ? emailMatch[0] : null,
      _ats: { platform: "greenhouse", token, id: j.id },
    };
  });
}

// Required application questions for one Greenhouse job (fetched lazily at apply time).
async function fetchGreenhouseQuestions(token, id) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}?questions=true`;
  const res = await axios.get(url, { timeout: 15000 });
  const qs = (res.data && res.data.questions) || [];
  return qs.map((q) => ({ label: q.label, required: !!q.required })).filter((q) => q.label);
}

// ---- Lever ----
async function fetchLeverCompany(company) {
  const url = `https://api.lever.co/v0/postings/${company}?mode=json`;
  const res = await axios.get(url, { timeout: 15000 });
  const posts = Array.isArray(res.data) ? res.data : [];
  return posts.map((p) => {
    const description = stripHtml(p.descriptionPlain || p.description || "");
    const emailMatch = description.match(EMAIL_RE);
    return {
      title: p.text || "",
      company: company.charAt(0).toUpperCase() + company.slice(1),
      location: (p.categories && p.categories.location) || "",
      salary: "Not stated",
      description,
      url: p.hostedUrl || p.applyUrl || "",
      source: "lever",
      applyEmail: emailMatch ? emailMatch[0] : null,
      _ats: { platform: "lever", company, id: p.id },
    };
  });
}

// Pull all configured ATS boards. Never throws — a failing board is skipped.
async function fetchAtsJobs() {
  const out = [];
  const tasks = [
    ...GREENHOUSE_BOARDS.map((t) => fetchGreenhouseBoard(t).catch((e) => (console.log(`ATS greenhouse ${t}: ${e.message}`), []))),
    ...LEVER_COMPANIES.map((c) => fetchLeverCompany(c).catch((e) => (console.log(`ATS lever ${c}: ${e.message}`), []))),
  ];
  for (const jobs of await Promise.all(tasks)) out.push(...jobs);
  return out;
}

// Light keyword filter so a board's full catalogue doesn't flood the matcher.
function filterByQuery(jobs, query, limit = 6) {
  const terms = (query || "").toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return jobs.slice(0, limit);
  const scored = jobs
    .map((j) => ({ j, hits: terms.filter((t) => j.title.toLowerCase().includes(t)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, limit).map((x) => x.j);
}

module.exports = { hasBoards, fetchAtsJobs, fetchGreenhouseBoard, fetchLeverCompany, fetchGreenhouseQuestions, filterByQuery };

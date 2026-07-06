// lib/jobs.js — job sourcing (blueprint §3: API-first, no scraping).
// Provider: Adzuna (has an India feed, free tier, legal structured data).
// Returns jobs normalized to the shape the matcher/cards expect:
//   { title, company, location, salary, description, url, source }
//
// Env: ADZUNA_APP_ID, ADZUNA_APP_KEY (free at https://developer.adzuna.com),
//      JOBS_COUNTRY (default "in"), JOBS_MAX (default 10).

const axios = require("axios");

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || "";
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY || "";
const JOBS_COUNTRY = (process.env.JOBS_COUNTRY || "in").toLowerCase();
const JOBS_MAX = parseInt(process.env.JOBS_MAX || "10", 10);

const hasCreds = () => !!(ADZUNA_APP_ID && ADZUNA_APP_KEY);

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Adzuna salary fields are annual in the country currency. For India, present LPA.
function formatSalary(min, max) {
  if (!min && !max) return "Not stated";
  if (JOBS_COUNTRY === "in") {
    const toLpa = (n) => (n / 100000).toFixed(n % 100000 === 0 ? 0 : 1);
    if (min && max) return `₹${toLpa(min)}–${toLpa(max)} LPA`;
    return `₹${toLpa(min || max)} LPA`;
  }
  if (min && max) return `${Math.round(min)}–${Math.round(max)}`;
  return `${Math.round(min || max)}`;
}

// Normalize one Adzuna result into our internal job shape. Carry Adzuna's stable
// job id so re-fetches / near-duplicate listings collapse to one card.
function normalizeAdzuna(r) {
  return {
    id: r.id != null ? String(r.id) : null,
    title: stripHtml(r.title),
    company: (r.company && r.company.display_name) || "Unknown",
    location: (r.location && r.location.display_name) || "",
    salary: formatSalary(r.salary_min, r.salary_max),
    description: stripHtml(r.description),
    url: r.redirect_url || "",
    source: "adzuna",
  };
}

// Stable identity for a job. Prefer a provider-stable id (Adzuna id, or ATS id) so
// the same posting never shows twice even when its location string varies between
// fetches; fall back to company+title+location. Used by dedupe AND seen-tracking.
function jobKey(j) {
  const sid = j.id || (j._ats && j._ats.id);
  if (sid) return `${j.source || "src"}:${sid}`.toLowerCase();
  return `${j.company}|${j.title}|${j.location}`.toLowerCase().replace(/\s+/g, " ").trim();
}

// Dedupe on company + normalized title + location (blueprint §3 pipeline hygiene).
function dedupe(jobs) {
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    const key = jobKey(j);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

/**
 * Fetch jobs from Adzuna.
 * query:   free-text role/skill terms (e.g. "AI engineer python")
 * options: { location, limit }
 * Throws Error("ADZUNA_CREDS_MISSING") if no keys — caller can fall back to samples.
 */
async function fetchJobs(query, { location = "", limit = JOBS_MAX, broad = false } = {}) {
  if (!hasCreds()) throw new Error("ADZUNA_CREDS_MISSING");

  const url = `https://api.adzuna.com/v1/api/jobs/${JOBS_COUNTRY}/search/1`;
  const params = {
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    results_per_page: Math.min(limit, 50),
    // broad=true → what_or matches ANY term (wider recall; the matcher filters relevance).
    [broad ? "what_or" : "what"]: query || "",
    "content-type": "application/json",
  };
  if (location) params.where = location;

  const res = await axios.get(url, { params, timeout: 15000 });
  const results = (res.data && res.data.results) || [];
  return dedupe(results.map(normalizeAdzuna)).slice(0, limit);
}

module.exports = { fetchJobs, normalizeAdzuna, dedupe, jobKey, formatSalary, stripHtml, hasCreds };

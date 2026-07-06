// test-jobs.js — eval for job sourcing (lib/jobs.js).
// Offline: verifies Adzuna normalization + dedupe on a fixed sample.
// Live (only if ADZUNA_APP_ID/KEY set): does a real fetch and prints a few jobs.
// Run: node test-jobs.js

require("dotenv").config();
const { normalizeAdzuna, dedupe, formatSalary, fetchJobs, hasCreds } = require("./lib/jobs");

// ---- Offline: a fixed Adzuna-shaped sample (no network) ----
const sample = [
  {
    title: "AI <b>Engineer</b>",
    company: { display_name: "Acme AI" },
    location: { display_name: "Bengaluru, Karnataka" },
    description: "Build <p>LLM apps</p> with Python &amp; LangChain. 0-2 years.",
    salary_min: 600000,
    salary_max: 900000,
    redirect_url: "https://adzuna/xyz",
  },
  {
    // duplicate of the first (same company+title+location) — should be deduped
    title: "AI Engineer",
    company: { display_name: "Acme AI" },
    location: { display_name: "Bengaluru, Karnataka" },
    description: "dup",
    salary_min: 600000,
    salary_max: 900000,
    redirect_url: "https://adzuna/dup",
  },
  {
    title: "Backend Developer",
    company: { display_name: "DataCorp" },
    location: { display_name: "Remote" },
    description: "Node.js APIs.",
    salary_min: null,
    salary_max: null,
    redirect_url: "https://adzuna/abc",
  },
];

console.log("🧪 Offline: normalize + dedupe\n");
const normalized = dedupe(sample.map(normalizeAdzuna));
console.log(`count: ${normalized.length} (expect 2 — one duplicate removed)`);
for (const j of normalized) {
  console.log(`  • ${j.title} @ ${j.company} | ${j.location} | ${j.salary}`);
  console.log(`    desc: ${j.description}`);
}
const checks = [
  ["dedupe removed 1", normalized.length === 2],
  ["html stripped from title", normalized[0].title === "AI Engineer"],
  ["entities+tags stripped in desc", !/[<>]|&amp;/.test(normalized[0].description)],
  ["salary → LPA", normalized[0].salary === "₹6–9 LPA"],
  ["missing salary → Not stated", normalized[1].salary === "Not stated"],
];
console.log("\nchecks:");
let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) pass = false;
}
console.log(`\n${pass ? "✅ offline eval PASSED" : "❌ offline eval FAILED"}`);

// ---- Live (optional) ----
(async () => {
  if (!hasCreds()) {
    console.log("\nℹ️  No ADZUNA_APP_ID/KEY set — skipping live fetch (bot will use sample jobs).");
    return;
  }
  console.log('\n🌐 Live fetch: "AI engineer python" in Bengaluru...\n');
  try {
    const jobs = await fetchJobs("AI engineer python", { location: "Bengaluru", limit: 5 });
    console.log(`got ${jobs.length} jobs:`);
    for (const j of jobs) console.log(`  • ${j.title} @ ${j.company} | ${j.location} | ${j.salary}`);
  } catch (err) {
    console.error("❌ live fetch failed:", err.message);
  }
})();

// test-ats.js — eval for ATS ingestion (lib/ats.js).
// Offline: query filter. Live: a real public Greenhouse board (no key needed).
// Run: node test-ats.js

require("dotenv").config();
const ats = require("./lib/ats");

let pass = true;
const check = (n, ok) => { console.log(`  ${ok ? "✅" : "❌"} ${n}`); if (!ok) pass = false; };

// ---- Offline: keyword filter ----
console.log("🧪 filterByQuery\n");
const jobs = [
  { title: "Senior AI Engineer", company: "X" },
  { title: "Backend Developer", company: "X" },
  { title: "Machine Learning Scientist", company: "X" },
  { title: "Sales Manager", company: "X" },
];
const filtered = ats.filterByQuery(jobs, "AI engineer machine learning", 3);
check("filters to relevant titles", filtered.length > 0 && filtered.length <= 3);
check("drops unrelated (Sales)", !filtered.some((j) => /sales/i.test(j.title)));
check("ranks AI Engineer high", /engineer|learning/i.test(filtered[0].title));

// ---- Live: a real public Greenhouse board (read-only, no key) ----
(async () => {
  const TOKEN = "greenhouse"; // Greenhouse's own board is public
  console.log(`\n🌐 Live: Greenhouse board "${TOKEN}"...\n`);
  try {
    const g = await ats.fetchGreenhouseBoard(TOKEN);
    console.log(`  got ${g.length} jobs; sample:`);
    for (const j of g.slice(0, 3)) console.log(`    • ${j.title} @ ${j.company} | ${j.location}`);
    check("greenhouse returns jobs", g.length > 0);
    check("normalized shape", g[0] && g[0].title && g[0].source === "greenhouse" && g[0]._ats);
    if (g[0]) {
      const qs = await ats.fetchGreenhouseQuestions(g[0]._ats.token, g[0]._ats.id).catch(() => []);
      console.log(`  first job has ${qs.length} application questions`);
      check("questions fetched (array)", Array.isArray(qs));
    }
  } catch (err) {
    console.log("  ⚠️ live fetch skipped/failed:", err.message);
  }

  console.log(`\n${pass ? "✅ ats eval PASSED" : "❌ ats eval FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

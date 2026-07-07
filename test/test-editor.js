// test-editor.js — eval for agents/editor.js (profile correction).
// Needs NVIDIA_API_KEY (real LLM). Run: node test-editor.js
//
// Expected outcomes (the point of §2.5 — check judgment, not just "runs"):
//   1. Rename        — "my name is Ramesh not Ram"      → name changes, skills untouched.
//   2. Add skill     — "I also know Docker"              → Docker added, existing skills kept.
//   3. Set years     — "I have 3 years of Python"        → Python years=3, no other skill gets years.
//   4. Fix total exp — "I actually have 2 years experience total" → total_experience_years=2.
//   5. Remove skill  — "remove Java, I don't know it"    → Java gone, others kept.
//   6. NO-FABRICATION (bad case) — "find me a better job" → profile UNCHANGED (off-topic, not a fact).

require("dotenv").config();
const { applyCorrection } = require("../agents/editor");

const base = () => ({
  name: "Ram",
  skills: [{ name: "Python", years: null }, { name: "Java", years: null }, { name: "SQL", years: 1 }],
  titles: ["AI Intern"],
  total_experience_years: 0.5,
  education: ["B.Tech, CBIT"],
  locations: ["Hyderabad"],
});

const has = (skills, name) => skills.some((s) => s.name.toLowerCase() === name.toLowerCase());
const yearsOf = (skills, name) => (skills.find((s) => s.name.toLowerCase() === name.toLowerCase()) || {}).years;

let pass = true;
const check = (n, ok, extra) => { console.log(`  ${ok ? "✅" : "❌"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) pass = false; };

(async () => {
  console.log("🧪 editor eval (live LLM)\n");

  // 1. Rename
  let r = await applyCorrection(base(), "my name is Ramesh, not Ram");
  check("1 rename → name updated", /ramesh/i.test(r.name), r.name);
  check("1 rename → skills untouched", r.skills.length === 3);

  // 2. Add skill
  r = await applyCorrection(base(), "I also know Docker");
  check("2 add → Docker present", has(r.skills, "Docker"));
  check("2 add → existing skills kept", has(r.skills, "Python") && has(r.skills, "Java"));

  // 3. Set years
  r = await applyCorrection(base(), "I have 3 years of Python experience");
  check("3 years → Python = 3", yearsOf(r.skills, "Python") === 3, `got ${yearsOf(r.skills, "Python")}`);
  check("3 years → Java still null (no fabrication)", yearsOf(r.skills, "Java") == null);

  // 4. Fix total experience
  r = await applyCorrection(base(), "I actually have 2 years of experience total");
  check("4 total → total_experience_years = 2", r.total_experience_years === 2, `got ${r.total_experience_years}`);

  // 5. Remove skill
  r = await applyCorrection(base(), "remove Java, I don't actually know it");
  check("5 remove → Java gone", !has(r.skills, "Java"));
  check("5 remove → others kept", has(r.skills, "Python") && has(r.skills, "SQL"));

  // 6. BAD CASE — off-topic request, not an editable fact → unchanged
  const b = base();
  r = await applyCorrection(b, "find me a better job please");
  check("6 no-op → name unchanged", r.name === b.name);
  check("6 no-op → skills unchanged", r.skills.length === b.skills.length && !has(r.skills, "Docker"));

  console.log(`\n${pass ? "✅ editor eval PASSED" : "❌ editor eval FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

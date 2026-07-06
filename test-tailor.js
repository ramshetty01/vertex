// test-tailor.js — eval for the resume tailor. Key check: NO FABRICATION.
// The job below demands Java/AWS the candidate does NOT have; tailored skills
// must never include them. Run: node test-tailor.js

require("dotenv").config();
const { tailorResume } = require("./agents/tailor");

const profile = {
  name: "Ram Dyavarashetty",
  skills: [
    { name: "Python", years: null },
    { name: "Machine Learning", years: null },
    { name: "LangChain", years: null },
    { name: "AI Automation", years: null },
    { name: "Chatbot Development", years: null },
  ],
  titles: ["AI Intern", "Automation Intern"],
  total_experience_years: 0.5,
  education: ["IFHE University, B.Tech CSE (AI/ML), Expected 2027"],
  locations: ["Hyderabad"],
};

const job = {
  title: "AI Engineer",
  company: "NimbusAI",
  description:
    "Build LLM apps with Python and LangChain. Bonus: Java microservices and AWS deployment. " +
    "We value chatbot and automation experience.",
};

(async () => {
  console.log("🧪 tailor eval — job demands Java+AWS the candidate lacks\n");
  const t = await tailorResume(profile, job);
  console.log("summary  :", t.summary);
  console.log("skills   :", t.skills.join(", "));
  console.log("highlights:\n" + t.highlights.map((h) => "  • " + h).join("\n"));

  const profileSkillsLower = profile.skills.map((s) => s.name.toLowerCase());
  const invented = t.skills.filter((s) => !profileSkillsLower.includes(s.toLowerCase()));
  const checks = [
    ["summary present", !!t.summary],
    ["skills all from profile (no fabrication)", invented.length === 0],
    ["Java NOT claimed", !t.skills.some((s) => /java/i.test(s))],
    ["AWS NOT claimed", !t.skills.some((s) => /aws/i.test(s))],
    ["has highlights", t.highlights.length > 0],
  ];
  console.log("\nchecks:");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  ${ok ? "✅" : "❌"} ${n}`);
    if (!ok) pass = false;
  }
  if (invented.length) console.log("  ⚠️ invented skills:", invented.join(", "));
  console.log(`\n${pass ? "✅ tailor eval PASSED" : "❌ tailor eval FAILED"}`);
})();

// test-coverletter.js — eval for agents/coverletter.js. Needs NVIDIA_API_KEY.
// Run: node test-coverletter.js
//
// Expected outcomes:
//   1. Names the real job title + company.
//   2. Mentions at least one REAL profile skill.
//   3. NO-FABRICATION: a job demanding Java + AWS (absent from profile) must NOT claim them.
//   4. Reasonable length (not empty, not a wall of text).
//   5. No leftover placeholder brackets like [Company].

require("dotenv").config();
const { writeCoverLetter } = require("../agents/coverletter");

const profile = {
  name: "Ram",
  skills: [{ name: "Python", years: null }, { name: "LangChain", years: null }, { name: "SQL", years: 1 }],
  titles: ["AI Automation Intern"],
  total_experience_years: 0.5,
};
const tailored = {
  summary: "AI automation intern skilled in Python and LLM workflows.",
  highlights: ["Built WhatsApp bots with LLM APIs", "Automated backend workflows in Python"],
  skills: ["Python", "LangChain", "SQL"],
};
const job = {
  title: "LLM Application Developer",
  company: "NimbusAI",
  // Deliberately demands Java + AWS, which the candidate does NOT have.
  description: "Build LLM apps with Python and LangChain. Must have strong Java and AWS cloud deployment experience.",
};

let pass = true;
const check = (n, ok, extra) => { console.log(`  ${ok ? "✅" : "❌"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) pass = false; };

(async () => {
  console.log("🧪 cover letter eval (live LLM)\n");
  const { text } = await writeCoverLetter(profile, job, tailored);
  console.log("--- letter ---\n" + text + "\n--------------\n");

  check("1 names the job title", /LLM Application Developer/i.test(text));
  check("1 names the company", /NimbusAI/i.test(text));
  check("2 mentions a real skill (Python/LangChain/SQL)", /python|langchain|sql/i.test(text));
  check("3 no fabricated Java", !/\bjava\b/i.test(text), /\bjava\b/i.test(text) ? "CLAIMED JAVA" : "clean");
  check("3 no fabricated AWS", !/\baws\b/i.test(text), /\baws\b/i.test(text) ? "CLAIMED AWS" : "clean");
  check("4 reasonable length (60-1600 chars)", text.length >= 60 && text.length <= 1600, `${text.length} chars`);
  check("5 no placeholder brackets", !/\[[A-Za-z ]+\]/.test(text));

  console.log(`\n${pass ? "✅ cover letter eval PASSED" : "❌ cover letter eval FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

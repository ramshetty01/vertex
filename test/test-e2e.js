// test-e2e.js — LIVE end-to-end pipeline on real data (no WhatsApp/phone).
// Real Adzuna jobs -> real 70b matcher -> real tailor -> apply preparation.
// Proves the full stack works in production. Run: node test-e2e.js

require("dotenv").config();
const { fetchJobs } = require("../lib/jobs");
const { findMatches } = require("../agents/matcher");
const { tailorResume } = require("../agents/tailor");
const applyAgent = require("../agents/apply");

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
const prefs = { locationPref: "Hyderabad", expectedSalaryLPA: 5, noticePeriod: "Immediate", feedback: {} };

(async () => {
  console.log("🚀 LIVE end-to-end pipeline\n");

  // 1. Real sourcing
  console.log("1️⃣  Sourcing jobs from Adzuna...");
  let jobs = [];
  try {
    jobs = await fetchJobs("AI engineer python langchain", { location: "" });
    console.log(`   got ${jobs.length} real jobs. e.g.:`);
    jobs.slice(0, 3).forEach((j) => console.log(`     • ${j.title} @ ${j.company} | ${j.location} | ${j.salary}`));
  } catch (e) {
    console.log(`   ⚠️ Adzuna: ${e.message} — using nothing.`);
  }
  if (!jobs.length) { console.log("   no jobs to score, stopping."); return; }

  // 2. Real matching (70b)
  console.log(`\n2️⃣  Scoring ${Math.min(jobs.length, 6)} jobs with the matcher (live 70b)...`);
  const matches = await findMatches(profile, jobs.slice(0, 6), prefs, 70);
  console.log(`   ${matches.length} passed the threshold:`);
  matches.forEach((m) => console.log(`     • ${m.fit}% — ${m.title} @ ${m.company} — ${m.strengths}`));

  const top = matches[0] || jobs[0];

  // 3. Real tailoring
  console.log(`\n3️⃣  Tailoring resume for: ${top.title} @ ${top.company}...`);
  const tailored = await tailorResume(profile, top);
  console.log(`   summary: ${tailored.summary}`);
  console.log(`   skills : ${tailored.skills.join(", ")}`);

  // 4. Apply preparation (channel + cheat sheet)
  console.log(`\n4️⃣  Preparing application...`);
  const app = applyAgent.prepareApplication(profile, top, tailored, [], {});
  console.log(`   channel: ${app.channel.tier}${app.channel.to ? " → " + app.channel.to : ""}`);
  console.log("   --- cheat sheet ---");
  console.log(app.cheatSheet.split("\n").map((l) => "   " + l).join("\n"));

  console.log("\n✅ Full pipeline ran on real data.");
})();

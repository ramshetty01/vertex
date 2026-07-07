// test-matcher.js — test the matcher agent WITHOUT WhatsApp
// Run: node test-matcher.js
// This is your first eval script: same profile, real-ish jobs, check the scores make sense.

require("dotenv").config();
const { findMatches } = require("../agents/matcher");

// Ram's actual parsed profile (from the parser output)
const profile = {
  name: "Ram Dyavarashetty",
  skills: [
    { name: "Python", years: null },
    { name: "Machine Learning", years: null },
    { name: "Deep Learning", years: null },
    { name: "LangChain", years: null },
    { name: "AI Automation", years: null },
    { name: "Agentic AI Workflows", years: null },
    { name: "Chatbot Development", years: null },
    { name: "API Integration", years: null },
    { name: "Web Automation", years: null },
  ],
  titles: ["Freelance AI Project Developer", "AI Intern", "Automation Intern"],
  total_experience_years: 0.5,
  education: ["IFHE University, B.Tech CSE (AI/ML), Expected 2027"],
  locations: ["Hyderabad"],
};

// Intake answers (blueprint Step 3) — these become soft matcher signals.
// Ram prefers Hyderabad but is open, min 5 LPA, immediate start.
const prefs = {
  locationPref: "Hyderabad",
  expectedSalaryLPA: 5,
  noticePeriod: "Immediate",
};

// Test jobs chosen to span the fit spectrum — we KNOW roughly what scores to expect
const testJobs = [
  {
    title: "AI Automation Intern",
    company: "FlowStack",
    location: "Hyderabad (Hybrid)",
    salary: "₹25k/month stipend",
    description:
      "Looking for an intern to build AI automation workflows using Python and LLM APIs. " +
      "Experience with LangChain or agent frameworks a big plus. Build chatbots and " +
      "automate backend workflows. Students welcome, 0-1 years experience.",
    expected: "HIGH — near-perfect overlap, intern level, right city",
  },
  {
    title: "Junior ML Engineer",
    company: "DataPeak",
    location: "Remote (India)",
    salary: "₹6-9 LPA",
    description:
      "Junior role building ML pipelines. Python, scikit-learn, model deployment. " +
      "1-2 years experience preferred but strong freshers considered. Deep learning knowledge valued.",
    expected: "MEDIUM-HIGH — skills match, slight experience stretch",
  },
  {
    title: "Senior Backend Engineer (Java)",
    company: "CoreBank Systems",
    location: "Mumbai (Onsite)",
    salary: "₹25-35 LPA",
    description:
      "5+ years building high-throughput Java microservices. Spring Boot, Kafka, " +
      "Kubernetes required. Financial services background preferred.",
    expected: "VERY LOW — wrong stack, 10x experience gap, wrong city (should be blocked)",
  },
  {
    title: "Prompt Engineer / LLM Application Developer",
    company: "NimbusAI",
    location: "Bengaluru (Hybrid)",
    salary: "₹5-8 LPA",
    description:
      "Build LLM-powered applications: RAG pipelines, agent workflows, chatbot products. " +
      "Python required, LangChain experience strongly preferred. 0-2 years. " +
      "Portfolio of AI projects matters more than years.",
    expected: "HIGH — direct match with his agentic AI work",
  },
];

(async () => {
  console.log("🧪 Testing matcher against 4 jobs with known expected outcomes...\n");

  for (const job of testJobs) {
    console.log(`--- ${job.title} @ ${job.company} ---`);
    console.log(`    Expected: ${job.expected}`);
  }
  console.log("\nScoring (threshold 75)...\n");

  const matches = await findMatches(profile, testJobs, prefs, 75);

  console.log(`\n✅ ${matches.length} job(s) passed the 75% threshold:\n`);
  for (const m of matches) {
    console.log(`  ${m.fit}% — ${m.title} @ ${m.company}`);
    console.log(`      💪 ${m.strengths}`);
    console.log(`      ⚠️  ${m.gaps}\n`);
  }

  console.log(
    "Sanity check: the intern & LLM-dev roles should pass, the Java senior role " +
      "should be blocked or score very low, the ML junior role is the judgment call."
  );
})();
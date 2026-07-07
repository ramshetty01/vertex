// test-all.js — offline eval suite runner (npm test). Runs every network-free eval
// sequentially, fails fast on the first failure, and prints a summary. The LLM-backed
// agent evals (editor/coverletter/matcher/inquiry/tailor) are excluded here because
// they need a live NIM key + network; run those individually when validating prompts.

const { execFileSync } = require("child_process");
const path = require("path");

const SUITES = [
  "test-flow.js",
  "test-proactive.js",
  "test-ratelimit.js",
  "test-paywall.js",
  "test-digest.js",
  "test-persist.js",
  "test-apply.js",
  "test-payments.js",
  "test-checkout.js",
  "test-jobs.js",
  "test-ats.js",
];

let failed = 0;
for (const s of SUITES) {
  process.stdout.write(`▶ ${s} ... `);
  try {
    execFileSync("node", [path.join(__dirname, s)], { stdio: ["ignore", "pipe", "pipe"] });
    console.log("PASS");
  } catch (err) {
    failed++;
    console.log("FAIL");
    process.stdout.write((err.stdout || "").toString().split("\n").slice(-15).join("\n") + "\n");
  }
}

console.log(`\n${failed === 0 ? "✅ all offline suites PASSED" : `❌ ${failed} suite(s) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);

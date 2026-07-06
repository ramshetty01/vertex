// test-proactive.js — offline test of the proactive retention sweep (no LLM, no network).
// Stubs the matcher; disables live job sources (no Adzuna creds, no ATS boards) so
// sourceJobsForUser falls back to the sample list with zero network. Run: node test-proactive.js
//
// Expected outcomes:
//   1. A DONE user with NEW (unseen) matches gets pushed a card, state → AWAITING_JOB_RESPONSE.
//   2. Already-seen jobs are NOT re-pushed (dedupe across runs via seenJobKeys).
//   3. A user still mid-flow (not DONE) is skipped entirely.
//   4. currentJobIndex points at the first newly-appended match.

process.env.MESSAGING_PROVIDER = "kapso";
process.env.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "offline-test-key";
process.env.BOT_DB_PATH = require("path").join(require("os").tmpdir(), `bot-proactive-${Date.now()}.db`);
process.env.ADZUNA_APP_ID = ""; // fetchJobs throws CREDS_MISSING immediately (no network)
process.env.ADZUNA_APP_KEY = "";
process.env.GREENHOUSE_BOARDS = ""; // ats.hasBoards() → false, skipped (no network)
process.env.LEVER_COMPANIES = "";

const messaging = require("./lib/messaging");
const matcher = require("./agents/matcher");

let sent = [];
messaging.sendMessage = async (to, body) => sent.push({ to, text: body });
messaging.sendInteractive = async (to, spec) => sent.push({ to, spec });
messaging.init = () => {};

const bot = require("./index.js");

let pass = true;
const check = (n, ok, extra) => { console.log(`  ${ok ? "✅" : "❌"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) pass = false; };

const JOB_A = { title: "AI Engineer", company: "Acme", location: "Remote", salary: "₹8 LPA", description: "Python.", fit: 90, strengths: "Python", gaps: "None significant" };
const JOB_B = { title: "ML Engineer", company: "DataCorp", location: "Remote", salary: "₹9 LPA", description: "ML.", fit: 82, strengths: "ML", gaps: "None significant" };

(async () => {
  console.log("🧪 proactive sweep test (offline)\n");

  // --- Seed users ---
  // p1: DONE, has already seen JOB_A. Next sweep returns [A, B] → only B is new.
  const p1 = bot.getUser("p1");
  p1.profile = { name: "Ram", skills: [{ name: "Python" }], titles: ["AI Intern"] };
  p1.intake = { locationPref: "any", expectedSalaryLPA: null, noticePeriod: "Immediate" };
  p1.state = "DONE";
  p1.matches = [JOB_A];
  p1.currentJobIndex = 1; // consumed the one match → DONE
  p1.seenJobKeys = [`${JOB_A.company}|${JOB_A.title}|${JOB_A.location}`.toLowerCase()];

  // p2: still mid-flow (AWAITING_JOB_RESPONSE) → must be skipped by the sweep.
  const p2 = bot.getUser("p2");
  p2.profile = { name: "Sri", skills: [{ name: "Java" }], titles: ["Dev"] };
  p2.intake = { locationPref: "any", expectedSalaryLPA: null, noticePeriod: "Immediate" };
  p2.state = "AWAITING_JOB_RESPONSE";
  p2.matches = [JOB_A];
  p2.currentJobIndex = 0;
  p2.seenJobKeys = [];

  // Persist both to the store so store.all() sees them.
  require("./lib/store").save("p1", p1);
  require("./lib/store").save("p2", p2);

  // Stub matcher: every sweep "finds" both A and B.
  matcher.findMatches = async () => [JOB_A, JOB_B];

  // Capture pushes via the injected pushFn.
  const pushed = [];
  const summary = await bot.runProactiveMatches(async (to, item) => pushed.push({ to, item }));

  // 1 + 2: p1 gets exactly the new job (B), not the seen one (A)
  check("p1 pushed exactly 1 new card", pushed.filter((x) => x.to === "p1").length === 1);
  const p1card = pushed.find((x) => x.to === "p1");
  check("pushed card is the NEW job (ML Engineer)", p1card && /ML Engineer/i.test(p1card.item.interactive.body), p1card && p1card.item.interactive.body.slice(0, 40));
  check("seen job (AI Engineer) NOT re-pushed", !(p1card && /AI Engineer/i.test(p1card.item.interactive.body)));

  // 3: p2 skipped (not DONE)
  check("mid-flow user p2 skipped", !pushed.some((x) => x.to === "p2"));

  // 4: state + index updated for p1
  const p1after = bot.getUser("p1");
  check("p1 state → AWAITING_JOB_RESPONSE", p1after.state === "AWAITING_JOB_RESPONSE");
  check("p1 currentJobIndex points at appended job", p1after.matches[p1after.currentJobIndex] && /ML Engineer/i.test(p1after.matches[p1after.currentJobIndex].title));
  check("JOB_B now marked seen", (p1after.seenJobKeys || []).some((k) => /datacorp/i.test(k)));

  // 5: summary counts
  check("summary swept=1 (only p1 eligible)", summary.swept === 1, `swept=${summary.swept}`);
  check("summary pushed=1", summary.pushed === 1, `pushed=${summary.pushed}`);

  // 6: idempotent — a second sweep finds nothing new (B now seen), no re-push
  //    (p1 is AWAITING_JOB_RESPONSE now, so it's skipped anyway — set back to DONE to prove seen-dedupe)
  const p1b = bot.getUser("p1");
  p1b.currentJobIndex = p1b.matches.length;
  p1b.state = "DONE";
  require("./lib/store").save("p1", p1b);
  const pushed2 = [];
  await bot.runProactiveMatches(async (to, item) => pushed2.push({ to, item }));
  check("second sweep pushes nothing (all seen)", pushed2.length === 0, `pushed ${pushed2.length}`);

  console.log(`\n${pass ? "✅ proactive sweep test PASSED" : "❌ proactive sweep test FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

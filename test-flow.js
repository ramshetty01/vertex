// test-flow.js — offline smoke test of the state machine (no LLM, no network).
// Stubs messaging to capture outbound, drives handleInbound through synchronous
// paths, and checks the bot doesn't crash and routes correctly. Run: node test-flow.js

process.env.MESSAGING_PROVIDER = "kapso"; // request provider → init is a no-op
process.env.BOT_DB_PATH = require("path").join(require("os").tmpdir(), `bot-flow-${Date.now()}.db`);

const messaging = require("./lib/messaging");
const applyAgent = require("./agents/apply");

let sent = [];
messaging.sendMessage = async (to, body) => sent.push({ to, text: body });
messaging.sendInteractive = async (to, spec) => sent.push({ to, spec });
messaging.init = () => {};

const bot = require("./index.js");

const inb = (from, text) => ({ from, text, numMedia: 0, mediaType: null, downloadMedia: async () => Buffer.from("") });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastText = () => sent.map((s) => s.text || (s.spec && s.spec.body) || "").join(" || ");

let pass = true;
const check = (n, ok) => { console.log(`  ${ok ? "✅" : "❌"} ${n}`); if (!ok) pass = false; };

(async () => {
  console.log("🧪 flow smoke test (offline)\n");

  // 1. Welcome (no media, new user)
  sent = [];
  await bot.handleInbound(inb("u1", "hi"));
  check("welcome sent", /job search assistant/i.test(lastText()));

  // 2. menu
  sent = [];
  await bot.handleInbound(inb("u1", "menu"));
  check("menu lists commands", /What you can do/i.test(lastText()));

  // 3. status with no applications
  sent = [];
  await bot.handleInbound(inb("u1", "status"));
  check("empty status", /No applications yet/i.test(lastText()));

  // ---- Inject a user mid-flow with matches (skip parse/match LLM) ----
  const u = bot.getUser("u2");
  u.profile = { name: "Ram", skills: [{ name: "Python" }], titles: ["AI Intern"] };
  u.matches = [
    { title: "AI Engineer", company: "Acme", location: "Remote", salary: "₹8 LPA", description: "Python. Apply careers stuff.", fit: 90, strengths: "Python", gaps: "None significant" },
    { title: "ML Engineer", company: "DataCorp", location: "Remote", salary: "₹9 LPA", description: "ML pipelines.", fit: 80, strengths: "ML", gaps: "None significant" },
  ];
  u.currentJobIndex = 0;
  u.state = "AWAITING_JOB_RESPONSE";

  // 4. Not interested → skip-reason list
  sent = [];
  await bot.handleInbound(inb("u2", "2"));
  check("skip → asks reason (list)", sent.some((s) => s.spec && s.spec.list));
  check("state = SKIP_REASON", bot.getUser("u2").state === "SKIP_REASON");

  // 5. reason tap → feedback recorded + advance to next card
  sent = [];
  await bot.handleInbound(inb("u2", "r_salary"));
  check("feedback recorded", bot.getUser("u2").feedback.salaryLow === 1);
  check("advanced to next job card", sent.some((s) => s.spec && s.spec.buttons));

  // ---- CONFIRM_APPLY path (assisted; no email configured) ----
  const u2 = bot.getUser("u2");
  const tailored = { summary: "AI intern skilled in Python.", highlights: ["Built bots"], skills: ["Python"] };
  const app = applyAgent.prepareApplication(u2.profile, u2.matches[1], tailored);
  u2.pendingApply = { job: u2.matches[1], app };
  u2.currentJobIndex = 1;
  u2.state = "CONFIRM_APPLY";

  // 6. confirm send → cheat sheet + tracker entry
  sent = [];
  await bot.handleInbound(inb("u2", "1"));
  await wait(50); // let the background submit IIFE run
  check("cheat sheet sent", /Ready to apply/i.test(lastText()));
  check("application tracked", bot.getUser("u2").applications.length === 1);

  // 7. status now shows the application
  sent = [];
  await bot.handleInbound(inb("u2", "status"));
  check("status shows application", /ML Engineer/i.test(lastText()) && /Applications:/i.test(lastText()));

  // ---- Custom-question relay ----
  const u3 = bot.getUser("u2");
  u3.matches = u3.matches.concat([{ title: "Data Eng", company: "Z", location: "Remote", salary: "-", description: "x", fit: 80, strengths: "x", gaps: "None significant" }]);
  u3.relay = { questions: ["Why do you want this role?", "Notice period?"], idx: 0, job: { title: "ML Engineer", company: "DataCorp" } };
  u3.state = "RELAY_QUESTIONS";

  sent = [];
  await bot.handleInbound(inb("u2", "Because I love ML")); // answer Q1
  check("Q1 answer saved", bot.getUser("u2").savedAnswers["why do you want this role?"] === "Because I love ML");
  check("asks Q2", /Notice period/i.test(lastText()));

  sent = [];
  await bot.handleInbound(inb("u2", "Immediate")); // answer Q2 → finish
  check("Q2 answer saved", bot.getUser("u2").savedAnswers["notice period?"] === "Immediate");
  check("relay cleared after last Q", bot.getUser("u2").relay === null);

  // reuse: a new application whose questions include a saved one → it's "known", not re-asked
  const app2 = applyAgent.prepareApplication(
    bot.getUser("u2").profile || { name: "R", skills: [] },
    { title: "X", company: "Y", description: "d" },
    { summary: "s", highlights: [], skills: [] },
    [{ label: "Why do you want this role?", required: true }, { label: "Expected CTC?", required: true }],
    bot.getUser("u2").savedAnswers
  );
  check("saved question reused (known)", app2.knownAnswers.some((k) => /why do you want/i.test(k.label)));
  check("new question stays unknown", app2.unknownQuestions.some((q) => /Expected CTC/i.test(q.label)));

  console.log(`\n${pass ? "✅ flow smoke test PASSED" : "❌ flow smoke test FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

// test-flow.js — offline smoke test of the state machine (no LLM, no network).
// Stubs messaging to capture outbound, drives handleInbound through synchronous
// paths, and checks the bot doesn't crash and routes correctly. Run: node test-flow.js

process.env.MESSAGING_PROVIDER = "kapso"; // request provider → init is a no-op
// llm.js constructs its client eagerly; the offline test never calls it (all stubbed),
// but the client still needs a non-empty key to instantiate without throwing.
process.env.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "offline-test-key";
process.env.BOT_WA_NUMBER = "919876543210"; // for the invite command's wa.me link
process.env.BOT_DB_PATH = require("path").join(require("os").tmpdir(), `bot-flow-${Date.now()}.db`);

const messaging = require("./lib/messaging");
const applyAgent = require("./agents/apply");
const editor = require("./agents/editor"); // stubbed below — no LLM in the offline test

let sent = [];
messaging.sendMessage = async (to, body) => sent.push({ to, text: body });
messaging.sendInteractive = async (to, spec) => sent.push({ to, spec });
messaging.init = () => {};

// Stub the profile editor: append a "Docker" skill so we can assert it was applied,
// without hitting the LLM. index.js calls editor.applyCorrection (namespace) so this sticks.
editor.applyCorrection = async (profile, _correction) => ({
  ...profile,
  skills: [...(profile.skills || []), { name: "Docker", years: null }],
});

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

  // ---- Profile edit: correction applied, then confirm → intake ----
  const e = bot.getUser("u4");
  e.profile = { name: "Ram", skills: [{ name: "Python", years: null }], titles: ["AI Intern"], total_experience_years: 0.5, education: [], locations: [] };
  e.state = "CONFIRMING_PROFILE";

  // typed correction → EDITING_PROFILE ack, background applies stubbed edit, back to CONFIRMING
  sent = [];
  await bot.handleInbound(inb("u4", "add Docker"));
  check("correction acks + goes to edit", /Updating your profile/i.test(lastText()));
  await wait(20); // let the background edit IIFE run
  check("edit applied (Docker added)", bot.getUser("u4").profile.skills.some((s) => s.name === "Docker"));
  check("edit re-shows summary", /Here's what I understood/i.test(lastText()));
  check("back in CONFIRMING_PROFILE", bot.getUser("u4").state === "CONFIRMING_PROFILE");

  // confirm → intake
  sent = [];
  await bot.handleInbound(inb("u4", "ok"));
  check("confirm → asks location (intake)", /where do you want to work/i.test(lastText()));
  check("state = INTAKE_LOCATION", bot.getUser("u4").state === "INTAKE_LOCATION");

  // ---- Application status progression (blueprint §119) ----
  const s = bot.getUser("u5b");
  s.profile = { name: "Ram", skills: [{ name: "Python" }] };
  s.applications = [{ title: "AI Engineer", company: "Acme", tier: "assisted", status: "Submitted", ts: Date.now() }];
  s.state = "DONE";

  // update → app list
  sent = [];
  await bot.handleInbound(inb("u5b", "update"));
  check("update → app list shown", sent.some((x) => x.spec && x.spec.list));
  check("state = UPDATE_PICK_APP", bot.getUser("u5b").state === "UPDATE_PICK_APP");

  // pick the app → status list (forward stages only)
  sent = [];
  await bot.handleInbound(inb("u5b", "app_0"));
  const statusRows = (sent.find((x) => x.spec && x.spec.list) || {}).spec?.list?.rows || [];
  check("status list offers forward stages", statusRows.some((r) => r.id === "st_Interview"));
  check("status list excludes past stages (no Prepared)", !statusRows.some((r) => r.id === "st_Prepared"));
  check("state = UPDATE_PICK_STATUS", bot.getUser("u5b").state === "UPDATE_PICK_STATUS");

  // set Interview → saved, returns to DONE
  sent = [];
  await bot.handleInbound(inb("u5b", "st_Interview"));
  check("status saved as Interview", bot.getUser("u5b").applications[0].status === "Interview");
  check("ack mentions Interview", /Interview/i.test(lastText()));
  check("returned to prior state (DONE)", bot.getUser("u5b").state === "DONE");

  // digest reflects the interview
  sent = [];
  await bot.handleInbound(inb("u5b", "status"));
  check("digest shows interviewing", /interviewing/i.test(lastText()));

  // no open applications → friendly message
  const s2 = bot.getUser("u5c");
  s2.applications = [{ title: "X", company: "Y", tier: "assisted", status: "Closed", ts: Date.now() }];
  s2.state = "DONE";
  sent = [];
  await bot.handleInbound(inb("u5c", "update"));
  check("no open apps → guidance, no list", /no open applications/i.test(lastText()) && !sent.some((x) => x.spec && x.spec.list));

  // ---- Duplicate-application guard ----
  check("alreadyApplied true for matching job",
    bot.alreadyApplied({ applications: [{ title: "AI Eng", company: "Acme" }] }, { title: "ai eng", company: "ACME" }) === true);
  check("alreadyApplied false for new job",
    bot.alreadyApplied({ applications: [{ title: "AI Eng", company: "Acme" }] }, { title: "ML Eng", company: "Acme" }) === false);

  const d = bot.getUser("u6dup");
  d.profile = { name: "Ram", skills: [{ name: "Python" }] };
  d.paid = true;
  d.applications = [{ title: "AI Engineer", company: "Acme", tier: "assisted", status: "Prepared", ts: Date.now() }];
  d.matches = [
    { title: "AI Engineer", company: "Acme", location: "Remote", salary: "-", description: "x", fit: 90, strengths: "x", gaps: "None significant" },
    { title: "ML Engineer", company: "Acme", location: "Remote", salary: "-", description: "x", fit: 85, strengths: "x", gaps: "None significant" },
  ];
  d.currentJobIndex = 0;
  d.state = "AWAITING_JOB_RESPONSE";
  sent = [];
  await bot.handleInbound(inb("u6dup", "1")); // Interested on the already-applied job
  await wait(10);
  check("dup apply → 'already applied' + advances", /already applied/i.test(lastText()));
  check("dup apply → did NOT enter PREPARING_APPLY", bot.getUser("u6dup").state !== "PREPARING_APPLY");

  // ---- Invite / referral command ----
  sent = [];
  await bot.handleInbound(inb("u1", "invite"));
  check("invite → forwardable pitch", /Forward this/i.test(lastText()));
  check("invite → wa.me link with bot number", /wa\.me\/919876543210/.test(lastText()));

  console.log(`\n${pass ? "✅ flow smoke test PASSED" : "❌ flow smoke test FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

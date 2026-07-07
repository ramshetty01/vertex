// test-ratelimit.js — offline test of the daily application rate limit (blueprint §46).
// No LLM on the blocked path. Run: node test-ratelimit.js

process.env.MESSAGING_PROVIDER = "kapso";
process.env.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "offline-test-key";
process.env.APPLIES_PER_DAY = "2"; // low cap so the test is cheap; read at module load
process.env.BOT_DB_PATH = require("path").join(require("os").tmpdir(), `bot-ratelimit-${Date.now()}.db`);

const messaging = require("../lib/messaging");
let sent = [];
messaging.sendMessage = async (to, body) => sent.push({ to, text: body });
messaging.sendInteractive = async (to, spec) => sent.push({ to, spec });
messaging.init = () => {};

const bot = require("../index.js");

const inb = (from, text) => ({ from, text, numMedia: 0, mediaType: null, downloadMedia: async () => Buffer.from("") });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastText = () => sent.map((s) => s.text || (s.spec && s.spec.body) || "").join(" || ");
const now = Date.now();
const HOUR = 60 * 60 * 1000;

let pass = true;
const check = (n, ok, extra) => { console.log(`  ${ok ? "✅" : "❌"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) pass = false; };

const match = { title: "AI Engineer", company: "Acme", location: "Remote", salary: "₹8 LPA", description: "Python.", fit: 90, strengths: "Python", gaps: "None significant" };
function seed(id, apps) {
  const u = bot.getUser(id);
  u.profile = { name: "Ram", skills: [{ name: "Python" }], titles: ["AI Intern"] };
  u.paid = true; // bypass the paywall so the tap reaches startApply
  u.matches = [match];
  u.currentJobIndex = 0;
  u.state = "AWAITING_JOB_RESPONSE";
  u.applications = apps;
  return u;
}

(async () => {
  console.log(`🧪 rate-limit test (cap=${bot.APPLIES_PER_DAY}, offline)\n`);

  // --- Pure helper checks ---
  check("count ignores apps older than 24h",
    bot.appliesInLast24h({ applications: [{ ts: now - 25 * HOUR }, { ts: now - HOUR }] }) === 1);
  check("quotaExceeded true at cap", bot.applyQuotaExceeded({ applications: [{ ts: now }, { ts: now }] }) === true);
  check("quotaExceeded false under cap", bot.applyQuotaExceeded({ applications: [{ ts: now }] }) === false);

  // --- AT the cap: tapping Interested is refused, no LLM/prepare ---
  seed("rl1", [{ ts: now - HOUR }, { ts: now - 2 * HOUR }]); // 2 recent = at cap
  sent = [];
  await bot.handleInbound(inb("rl1", "1"));
  check("at-cap tap → limit message", /limit of \*2 applications\*/i.test(lastText()));
  check("at-cap tap → NOT preparing apply", bot.getUser("rl1").state === "AWAITING_JOB_RESPONSE");

  // --- UNDER the cap (1 recent + 1 old): tap proceeds to prepare ---
  seed("rl2", [{ ts: now - HOUR }, { ts: now - 30 * HOUR }]); // only 1 counts
  sent = [];
  await bot.handleInbound(inb("rl2", "1"));
  check("under-cap tap → enters PREPARING_APPLY", bot.getUser("rl2").state === "PREPARING_APPLY");
  await wait(10); // let the background prepare IIFE settle (LLM will error on offline key; that's fine)

  console.log(`\n${pass ? "✅ rate-limit test PASSED" : "❌ rate-limit test FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

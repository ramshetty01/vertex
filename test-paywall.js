// test-paywall.js — offline test of the free-cards paywall gate. No network.
// Verifies: first FREE_CARDS matches are free to act on; paywall only from card
// FREE_CARDS+1; paid users never paywalled. Run: node test-paywall.js

process.env.MESSAGING_PROVIDER = "kapso";
process.env.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "offline-test-key";
process.env.FREE_CARDS = "3";
process.env.BOT_DB_PATH = require("path").join(require("os").tmpdir(), `bot-paywall-${Date.now()}.db`);

const messaging = require("./lib/messaging");
let sent = [];
messaging.sendMessage = async (to, body) => sent.push({ to, text: body });
messaging.sendInteractive = async (to, spec) => sent.push({ to, spec });
messaging.init = () => {};

const payments = require("./lib/payments");
payments.enabled = () => true;                                   // force paywall ON
payments.createPaymentLink = async () => ({ url: "https://pay.test/abc", id: "plink_1" }); // no network

const bot = require("./index.js");
const inb = (from, text) => ({ from, text, numMedia: 0, mediaType: null, downloadMedia: async () => Buffer.from("") });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastText = () => sent.map((s) => s.text || (s.spec && s.spec.body) || "").join(" || ");

let pass = true;
const check = (n, ok, extra) => { console.log(`  ${ok ? "✅" : "❌"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) pass = false; };

(async () => {
  console.log(`🧪 paywall gate test (FREE_CARDS=${bot.FREE_CARDS}, offline)\n`);

  // --- requiresPayment gate: free for first 3 cards, then paywall; paid always free ---
  check("card 1 (index 0) free", bot.requiresPayment({ paid: false, currentJobIndex: 0 }) === false);
  check("card 3 (index 2) free", bot.requiresPayment({ paid: false, currentJobIndex: 2 }) === false);
  check("card 4 (index 3) paywalled", bot.requiresPayment({ paid: false, currentJobIndex: 3 }) === true);
  check("paid user never paywalled", bot.requiresPayment({ paid: true, currentJobIndex: 9 }) === false);

  // --- Handler: on card 4 (index 3), Interested → payment link + AWAITING_PAYMENT ---
  const u = bot.getUser("pw1");
  u.profile = { name: "Ram", skills: [{ name: "Python" }] };
  u.paid = false;
  u.matches = Array.from({ length: 5 }, (_, i) => ({
    title: `Job ${i}`, company: "Acme", location: "Remote", salary: "-", description: "x", fit: 90, strengths: "x", gaps: "None significant",
  }));
  u.currentJobIndex = 3; // 4th card
  u.state = "AWAITING_JOB_RESPONSE";
  sent = [];
  await bot.handleInbound(inb("pw1", "1"));
  await wait(10);
  check("4th card Interested → payment link sent", /pay\.test\/abc/.test(lastText()));
  check("4th card Interested → state AWAITING_PAYMENT", bot.getUser("pw1").state === "AWAITING_PAYMENT");

  // --- Handler: on card 1 (index 0), Interested is NOT paywalled (enters apply prep) ---
  const u2 = bot.getUser("pw2");
  u2.profile = { name: "Ram", skills: [{ name: "Python" }] };
  u2.paid = false;
  u2.matches = u.matches;
  u2.currentJobIndex = 0; // 1st card
  u2.state = "AWAITING_JOB_RESPONSE";
  sent = [];
  await bot.handleInbound(inb("pw2", "1"));
  check("1st card Interested → NOT paywalled (no pay link)", !/pay\.test/.test(lastText()));
  check("1st card Interested → enters apply, not AWAITING_PAYMENT", bot.getUser("pw2").state !== "AWAITING_PAYMENT");

  console.log(`\n${pass ? "✅ paywall gate test PASSED" : "❌ paywall gate test FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

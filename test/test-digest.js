// test-digest.js — offline test of the weekly digest push (blueprint §119). No LLM/network.
// Run: node test-digest.js

process.env.MESSAGING_PROVIDER = "kapso";
process.env.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "offline-test-key";
process.env.BOT_DB_PATH = require("path").join(require("os").tmpdir(), `bot-digest-${Date.now()}.db`);

const messaging = require("../lib/messaging");
messaging.sendMessage = async () => {};
messaging.sendInteractive = async () => {};
messaging.init = () => {};

const bot = require("../index.js");
const store = require("../lib/store");

let pass = true;
const check = (n, ok, extra) => { console.log(`  ${ok ? "✅" : "❌"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) pass = false; };

(async () => {
  console.log("🧪 weekly digest test (offline)\n");

  // --- profileTip picks the right nudge ---
  check("tip: few skills → add skills",
    /add a few more skills/i.test(bot.profileTip({ profile: { skills: [{ name: "Python" }], total_experience_years: 1 } })));
  check("tip: no location → set location",
    /location preference/i.test(bot.profileTip({ profile: { skills: [{ name: "a" }, { name: "b" }, { name: "c" }], total_experience_years: 1 }, intake: {} })));
  check("tip: matches remaining → review them",
    /still to review/i.test(bot.profileTip({ profile: { skills: [{ name: "a" }, { name: "b" }, { name: "c" }], total_experience_years: 1 }, intake: { locationPref: "any" }, matches: [1, 2, 3], currentJobIndex: 1 })));

  // --- weekly digest wraps the tracker + a tip ---
  const wd = bot.buildWeeklyDigest({
    profile: { skills: [{ name: "Python" }], total_experience_years: 1 }, intake: { locationPref: "any" },
    applications: [{ title: "AI Eng", company: "Acme", status: "Interview", ts: Date.now() }],
    matches: [], currentJobIndex: 0,
  });
  check("weekly digest has heading", /weekly job update/i.test(wd));
  check("weekly digest includes tracker", /job search so far/i.test(wd));
  check("weekly digest includes a tip", /\*Tip:\*/i.test(wd));

  // --- runDigestPush: active users get it, empty users skipped ---
  const active = bot.getUser("d1");
  active.profile = { name: "Ram", skills: [{ name: "Python" }] };
  active.applications = [{ title: "AI Eng", company: "Acme", status: "Submitted", ts: Date.now() }];
  active.state = "DONE";
  store.save("d1", active);

  const empty = bot.getUser("d2"); // profile but no apps + no remaining matches → skipped
  empty.profile = { name: "Sri", skills: [{ name: "Java" }] };
  empty.applications = [];
  empty.matches = [];
  empty.currentJobIndex = 0;
  empty.state = "DONE";
  store.save("d2", empty);

  const noProfile = bot.getUser("d3"); // no profile → skipped
  noProfile.state = "AWAITING_RESUME";
  store.save("d3", noProfile);

  const got = [];
  const summary = await bot.runDigestPush(async (to, text) => got.push({ to, text }));
  check("active user received digest", got.some((g) => g.to === "d1"));
  check("empty user skipped", !got.some((g) => g.to === "d2"));
  check("no-profile user skipped", !got.some((g) => g.to === "d3"));
  check("summary sent=1", summary.sent === 1, `sent=${summary.sent}`);

  console.log(`\n${pass ? "✅ digest test PASSED" : "❌ digest test FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

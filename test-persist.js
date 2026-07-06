// test-persist.js — verifies state survives a "restart" (SQLite persistence, §2.7).
// Uses a throwaway DB. Run: node test-persist.js

const os = require("os");
const path = require("path");
const fs = require("fs");

process.env.BOT_DB_PATH = path.join(os.tmpdir(), `bot-test-${Date.now()}.db`);
process.env.MESSAGING_PROVIDER = "kapso";

const messaging = require("./lib/messaging");
messaging.sendMessage = async () => {};
messaging.sendInteractive = async () => {};
messaging.init = () => {};

const store = require("./lib/store");
const bot = require("./index.js");
const inb = (from, text) => ({ from, text, numMedia: 0, mediaType: null, downloadMedia: async () => Buffer.from("") });

let pass = true;
const check = (n, ok) => { console.log(`  ${ok ? "✅" : "❌"} ${n}`); if (!ok) pass = false; };

(async () => {
  console.log("🧪 persistence eval\n");

  // 1. store round-trip
  store.save("rt", { state: "X", n: 42 });
  const back = store.load("rt");
  check("store save/load round-trips", back && back.state === "X" && back.n === 42);
  store.remove("rt");
  check("store remove works", store.load("rt") === null);

  // 2. drive the bot, mutate state, then simulate a restart (evict from memory)
  await bot.handleInbound(inb("puser", "hi")); // creates + persists AWAITING_RESUME
  const u = bot.getUser("puser");
  u.paid = true;
  u.profile = { name: "Ram" };
  u.applications.push({ title: "AI Engineer", company: "Acme", tier: "assisted", status: "Prepared", ts: Date.now() });
  await bot.handleInbound(inb("puser", "status")); // handler persists mutated state

  check("row exists in DB", !!store.load("puser"));

  // Simulate restart: drop the in-memory copy; getUser must reload from SQLite.
  bot.users.delete("puser");
  const reloaded = bot.getUser("puser");
  check("reloaded from DB after eviction", reloaded !== u); // different object instance
  check("paid persisted", reloaded.paid === true);
  check("profile persisted", reloaded.profile && reloaded.profile.name === "Ram");
  check("applications persisted", reloaded.applications.length === 1);

  // 3. restart command wipes the row
  await bot.handleInbound(inb("puser", "restart"));
  check("restart clears DB row", store.load("puser") === null);

  try { fs.unlinkSync(process.env.BOT_DB_PATH); } catch {}
  try { fs.unlinkSync(process.env.BOT_DB_PATH + "-wal"); } catch {}
  try { fs.unlinkSync(process.env.BOT_DB_PATH + "-shm"); } catch {}

  console.log(`\n${pass ? "✅ persistence eval PASSED" : "❌ persistence eval FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

// lib/config.js — single source of truth for runtime configuration.
// Reads process.env once, applies typed defaults, and exposes a boot-time readiness
// report so operators immediately see what's live vs missing (this is what would have
// surfaced the "ADMIN_TOKEN not set" / "no volume" misconfigs at a glance).
//
// Design: app-level knobs (ports, limits, tokens, provider selection) live here.
// Per-concern secrets (Kapso/Razorpay/SMTP/Adzuna keys) stay encapsulated in their
// own lib modules (each owns its config); config.report() only *inspects* presence so
// the boot log is complete without this file becoming a god-object.

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const has = (v) => !!(v && String(v).trim());

const config = {
  // Server
  port: num(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || "development",

  // Messaging
  messagingProvider: (process.env.MESSAGING_PROVIDER || "twilio").toLowerCase(),
  botWaNumber: (process.env.BOT_WA_NUMBER || "").replace(/\D/g, ""),

  // Conversation / product knobs
  freeCards: num(process.env.FREE_CARDS, 3),
  appliesPerDay: num(process.env.APPLIES_PER_DAY, 10),

  // Admin
  adminToken: process.env.ADMIN_TOKEN || "",

  // Storage
  botDbPath: process.env.BOT_DB_PATH || "",
  uploadDir: process.env.UPLOAD_DIR || "",
};

// A readiness snapshot of every external integration — presence only, never values.
function readiness() {
  return {
    llm: has(process.env.NVIDIA_API_KEY),
    messaging: {
      provider: config.messagingProvider,
      kapso: has(process.env.KAPSO_API_KEY) && has(process.env.KAPSO_PHONE_NUMBER_ID),
      twilio: has(process.env.TWILIO_ACCOUNT_SID) && has(process.env.TWILIO_AUTH_TOKEN),
    },
    jobs: { adzuna: has(process.env.ADZUNA_APP_ID) && has(process.env.ADZUNA_APP_KEY), greenhouse: has(process.env.GREENHOUSE_BOARDS) },
    payments: { razorpay: has(process.env.RAZORPAY_KEY_ID) && has(process.env.RAZORPAY_KEY_SECRET), webhook: has(process.env.RAZORPAY_WEBHOOK_SECRET) },
    email: has(process.env.SMTP_HOST) && has(process.env.SMTP_USER),
    admin: has(config.adminToken),
    persistentStorage: has(config.botDbPath) && has(config.uploadDir),
    botNumber: has(config.botWaNumber),
  };
}

// Log a compact readiness table at boot. Loud warnings for things that will bite in
// production (no admin token, no persistent volume) so they're caught before users are.
function logReadiness() {
  const r = readiness();
  const yn = (b) => (b ? "✅" : "—");
  console.log("──────── configuration ────────");
  console.log(`  env: ${config.nodeEnv}  |  provider: ${r.messaging.provider}  |  free cards: ${config.freeCards}  |  apply cap/day: ${config.appliesPerDay}`);
  console.log(`  LLM ${yn(r.llm)}   messaging ${yn(r.messaging[r.messaging.provider] || false)}   jobs(adzuna) ${yn(r.jobs.adzuna)}   ATS(greenhouse) ${yn(r.jobs.greenhouse)}`);
  console.log(`  payments ${yn(r.payments.razorpay)}   pay-webhook ${yn(r.payments.webhook)}   email ${yn(r.email)}   bot number ${yn(r.botNumber)}`);
  console.log(`  admin token ${yn(r.admin)}   persistent storage ${yn(r.persistentStorage)}`);
  if (!r.admin) console.warn("  ⚠️  ADMIN_TOKEN unset — /admin dashboard, stats, and cron endpoints are DISABLED.");
  if (!r.persistentStorage) console.warn("  ⚠️  BOT_DB_PATH/UPLOAD_DIR unset — on a container host, user state & resumes are WIPED on every redeploy.");
  if (!r.llm) console.warn("  ⚠️  NVIDIA_API_KEY unset — parsing/matching will fail.");
  console.log("───────────────────────────────");
}

module.exports = { config, readiness, logReadiness };

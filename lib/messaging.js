// lib/messaging.js — ONE messaging gateway for all WhatsApp providers.
// Swap providers by setting MESSAGING_PROVIDER; nothing else in the app changes.
// (Same philosophy as lib/llm.js — provider details live in exactly one file.)
//
//   MESSAGING_PROVIDER=kapso   -> Kapso WhatsApp API (Meta Cloud-compatible; official, no daily cap, native buttons)
//   MESSAGING_PROVIDER=wwebjs  -> whatsapp-web.js, in-process, QR in terminal (unofficial; free, no cap; testing)
//   MESSAGING_PROVIDER=twilio  -> Twilio WhatsApp (sandbox = 9 msgs/day cap)
//
// Two provider shapes:
//   - Request providers (kapso, twilio): WhatsApp POSTs to our express webhook.
//       parseInbound(req) -> normalized inbound | null
//   - Push providers (wwebjs): a persistent client emits messages.
//       init({ onMessage }) wires the client's message event to our handler.
//
// Normalized inbound object (both shapes produce this):
//   { from, text, numMedia, mediaType, downloadMedia: async () => Buffer }
//   (for a tapped button/list row, `text` is the option's id — e.g. "1" — so the
//    handler sees the same token whether the user tapped or typed it.)
//
// Common API:
//   parseInbound(req) | init({onMessage}) | sendMessage(to, body)
//   sendInteractive(to, { body, buttons? , list? })
//     buttons: [{ id, title }]  (max 3)  |  list: { button, rows: [{ id, title }] }
//     Non-native providers fall back to numbered text automatically.

// Fallback: render an interactive spec as plain text (body + numbered options).
function renderInteractiveText(spec) {
  const opts = spec.buttons || (spec.list && spec.list.rows) || [];
  const lines = opts.map((o) => `*${o.id}* — ${o.title}`).join("\n");
  return lines ? `${spec.body}\n\n${lines}` : spec.body;
}

const axios = require("axios");

const PROVIDER = (process.env.MESSAGING_PROVIDER || "twilio").toLowerCase();

// ---------------- Twilio ----------------
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM || "whatsapp:+14155238886"; // sandbox sender
let twilioClient = null;
function getTwilio() {
  if (!twilioClient) twilioClient = require("twilio")(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return twilioClient;
}

// ---------------- Kapso (Meta Cloud API-compatible proxy) ----------------
const KAPSO_API_URL = (process.env.KAPSO_API_URL || "https://api.kapso.ai").replace(/\/$/, "");
const KAPSO_API_KEY = process.env.KAPSO_API_KEY || "";
const KAPSO_PHONE_NUMBER_ID = process.env.KAPSO_PHONE_NUMBER_ID || "";
const kapsoHeaders = { "X-API-Key": KAPSO_API_KEY };

async function fetchBuffer(url, headers, extra) {
  const res = await axios.get(url, { responseType: "arraybuffer", headers, ...(extra || {}) });
  return Buffer.from(res.data);
}

const providers = {
  twilio: {
    kind: "request",
    parseInbound(req) {
      const from = req.body.From;
      if (!from) return null;
      const numMedia = parseInt(req.body.NumMedia || "0", 10);
      const mediaUrl = req.body.MediaUrl0 || null;
      return {
        from,
        text: (req.body.Body || "").trim(),
        numMedia,
        mediaType: req.body.MediaContentType0 || null,
        downloadMedia: () =>
          fetchBuffer(mediaUrl, undefined, {
            auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
          }),
      };
    },
    async sendMessage(to, body) {
      await getTwilio().messages.create({ from: TWILIO_FROM, to, body });
    },
    async sendInteractive(to, spec) {
      await this.sendMessage(to, renderInteractiveText(spec)); // no native buttons on sandbox
    },
  },

  kapso: {
    kind: "request",
    // Webhook event: whatsapp.message.received (payload may be top-level or under .data)
    parseInbound(req) {
      const body = req.body || {};
      const msg = body.message || (body.data && body.data.message);
      if (!msg || !msg.from) return null;
      const k = msg.kapso || {};
      if (k.direction && k.direction !== "inbound") return null; // ignore outbound echoes
      const hasMedia = !!(k.has_media && k.media_url);
      const md = k.media_data || {};
      // A tapped button/list row arrives as type "interactive"; use its id as text.
      let text = msg.text && msg.text.body ? msg.text.body : "";
      if (msg.type === "interactive" && msg.interactive) {
        const rep = msg.interactive.button_reply || msg.interactive.list_reply || {};
        text = rep.id || rep.title || "";
      }
      return {
        from: msg.from, // digits, e.g. "16315551181"
        text: text.trim(),
        numMedia: hasMedia ? 1 : 0,
        mediaType: hasMedia ? md.content_type || null : null,
        downloadMedia: () => fetchBuffer(k.media_url, kapsoHeaders),
      };
    },
    async sendMessage(to, body) {
      await this._post({ messaging_product: "whatsapp", to, type: "text", text: { body } });
    },
    async sendInteractive(to, spec) {
      let interactive;
      if (spec.buttons) {
        interactive = {
          type: "button",
          body: { text: spec.body },
          action: {
            buttons: spec.buttons.slice(0, 3).map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title },
            })),
          },
        };
      } else if (spec.list) {
        interactive = {
          type: "list",
          body: { text: spec.body },
          action: {
            button: spec.list.button || "Choose",
            sections: [{ rows: spec.list.rows.map((r) => ({ id: r.id, title: r.title })) }],
          },
        };
      } else {
        return this.sendMessage(to, spec.body);
      }
      await this._post({ messaging_product: "whatsapp", to, type: "interactive", interactive });
    },
    async _post(payload) {
      await axios.post(
        `${KAPSO_API_URL}/meta/whatsapp/v24.0/${KAPSO_PHONE_NUMBER_ID}/messages`,
        payload,
        { headers: { ...kapsoHeaders, "Content-Type": "application/json" } }
      );
    },
  },

  wwebjs: {
    kind: "push",
    _client: null,
    init({ onMessage }) {
      const { Client, LocalAuth } = require("whatsapp-web.js");
      const qrcode = require("qrcode-terminal");
      const client = new Client({
        authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }), // session persists across restarts
        puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
      });
      client.on("qr", (qr) => {
        console.log("📱 Scan this QR in WhatsApp → Linked Devices:");
        qrcode.generate(qr, { small: true });
      });
      client.on("ready", () => console.log("✅ WhatsApp (wwebjs) connected and ready."));
      client.on("auth_failure", (m) => console.error("❌ wwebjs auth failure:", m));
      client.on("disconnected", (r) => console.error("⚠️ wwebjs disconnected:", r));
      // Only real user messages; drop status broadcasts and protocol/notification events.
      const ALLOWED_TYPES = ["chat", "document", "image", "audio", "ptt", "video"];
      client.on("message", async (msg) => {
        if (msg.fromMe || msg.isStatus || msg.from === "status@broadcast") return;
        if (msg.type && !ALLOWED_TYPES.includes(msg.type)) return; // e2e_notification, gp2, call_log, etc.
        const hasMedia = !!msg.hasMedia;
        const mimetype = msg._data && msg._data.mimetype;
        onMessage({
          from: msg.from, // "91XXXXXXXXXX@c.us"
          text: (msg.body || "").trim(),
          numMedia: hasMedia ? 1 : 0,
          // documents often expose mimetype; fall back to pdf for 'document' type
          mediaType: hasMedia ? mimetype || (msg.type === "document" ? "application/pdf" : msg.type) : null,
          downloadMedia: async () => {
            const media = await msg.downloadMedia();
            return Buffer.from(media.data, "base64");
          },
        });
      });
      this._client = client;
      client.initialize();
    },
    async sendMessage(to, body) {
      if (!this._client) throw new Error("wwebjs client not initialized");
      await this._client.sendMessage(to, body);
    },
    async sendInteractive(to, spec) {
      await this.sendMessage(to, renderInteractiveText(spec)); // buttons unreliable on wwebjs; use text
    },
  },
};

const active = providers[PROVIDER];
if (!active) throw new Error(`Unknown MESSAGING_PROVIDER: ${PROVIDER}`);
console.log(`💬 Messaging provider: ${PROVIDER} (${active.kind})`);

module.exports = {
  provider: PROVIDER,
  kind: active.kind,
  parseInbound: active.kind === "request" ? (req) => active.parseInbound(req) : () => null,
  init: active.kind === "push" ? (opts) => active.init(opts) : () => {},
  sendMessage: (to, body) => active.sendMessage(to, body),
  sendInteractive: (to, spec) =>
    active.sendInteractive
      ? active.sendInteractive(to, spec)
      : active.sendMessage(to, renderInteractiveText(spec)),
};

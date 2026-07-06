// lib/payments.js — Razorpay payment links + webhook verification (blueprint §5).
// Paywall triggers at the first Interested/Inquire tap; a payment link is sent in
// chat; Razorpay's webhook unlocks the user.
//
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, PLAN_PRICE_INR (default 149).
// If keys are absent, payments are DISABLED (enabled()===false) and the app treats
// everyone as already paid so the demo still works end-to-end.

const axios = require("axios");
const crypto = require("crypto");

const KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";
const PLAN_PRICE_INR = parseInt(process.env.PLAN_PRICE_INR || "149", 10);

const enabled = () => !!(KEY_ID && KEY_SECRET);

// Create a Razorpay Payment Link. Returns { url, id }.
// waFrom is stashed in notes so the webhook can map the payment back to the user.
async function createPaymentLink(waFrom, { amountINR = PLAN_PRICE_INR, description = "Job assistant — weekly access" } = {}) {
  const res = await axios.post(
    "https://api.razorpay.com/v1/payment_links",
    {
      amount: Math.round(amountINR * 100), // paise
      currency: "INR",
      description,
      notes: { wa_from: waFrom },
      notify: { sms: false, email: false },
      reminder_enable: false,
    },
    { auth: { username: KEY_ID, password: KEY_SECRET }, timeout: 15000 }
  );
  return { url: res.data.short_url, id: res.data.id };
}

// Verify a Razorpay webhook signature (HMAC-SHA256 of the raw body).
function verifySignature(rawBody, signature) {
  if (!WEBHOOK_SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  // timing-safe compare
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Parse a webhook body into { paid, waFrom }. Handles payment_link.paid / payment.captured.
function parseEvent(body) {
  const event = body && body.event;
  const pl = body && body.payload;
  if (event === "payment_link.paid" && pl && pl.payment_link) {
    const entity = pl.payment_link.entity || {};
    return { paid: true, waFrom: (entity.notes && entity.notes.wa_from) || null };
  }
  if (event === "payment.captured" && pl && pl.payment) {
    const entity = pl.payment.entity || {};
    return { paid: true, waFrom: (entity.notes && entity.notes.wa_from) || null };
  }
  return { paid: false, waFrom: null };
}

module.exports = { enabled, createPaymentLink, verifySignature, parseEvent, PLAN_PRICE_INR };

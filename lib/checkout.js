// lib/checkout.js — Razorpay Standard Web Checkout: order creation + signature verify.
// Separate from lib/payments.js (which uses Payment Links for the WhatsApp paywall).
// KEY_SECRET stays server-side only; the frontend receives KEY_ID via /api/config.
// Docs: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/

const Razorpay = require("razorpay");
const crypto = require("crypto");

const KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

const enabled = () => !!(KEY_ID && KEY_SECRET);

let instance = null;
function client() {
  if (!instance) instance = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  return instance;
}

// Create an order. amount is in paise (>= 100). Returns the Razorpay order object.
async function createOrder({ amount, currency = "INR", receipt } = {}) {
  return client().orders.create({
    amount,
    currency,
    receipt: receipt || `rcpt_${Date.now()}`,
  });
}

// Verify the checkout callback signature: HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET).
function verifyPaymentSignature({ order_id, payment_id, signature }) {
  if (!KEY_SECRET || !order_id || !payment_id || !signature) return false;
  const expected = crypto
    .createHmac("sha256", KEY_SECRET)
    .update(`${order_id}|${payment_id}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { enabled, createOrder, verifyPaymentSignature, KEY_ID };

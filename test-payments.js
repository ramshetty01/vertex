// test-payments.js — eval for lib/payments.js (offline; no real Razorpay calls).
// Verifies: signature verify (HMAC), event parsing, payment-link request body.
// Run: node test-payments.js

process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
process.env.RAZORPAY_KEY_ID = "rzp_test_id";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
process.env.PLAN_PRICE_INR = "149";

const crypto = require("crypto");
const axios = require("axios");
const payments = require("./lib/payments");

let pass = true;
const check = (name, ok) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) pass = false;
};

(async () => {
  console.log("🧪 payments eval\n");

  check("enabled() true when keys set", payments.enabled() === true);

  // Signature verify
  const body = JSON.stringify({ event: "payment_link.paid" });
  const goodSig = crypto.createHmac("sha256", "whsec_test").update(body).digest("hex");
  check("valid signature accepted", payments.verifySignature(Buffer.from(body), goodSig) === true);
  check("bad signature rejected", payments.verifySignature(Buffer.from(body), "deadbeef") === false);
  check("missing signature rejected", payments.verifySignature(Buffer.from(body), undefined) === false);

  // Event parsing
  const evt = {
    event: "payment_link.paid",
    payload: { payment_link: { entity: { notes: { wa_from: "919876543210" } } } },
  };
  const parsed = payments.parseEvent(evt);
  check("parseEvent → paid true", parsed.paid === true);
  check("parseEvent → waFrom extracted", parsed.waFrom === "919876543210");
  check("unrelated event → not paid", payments.parseEvent({ event: "foo" }).paid === false);

  // Payment-link request body (mock axios)
  let captured = null;
  const realPost = axios.post;
  axios.post = async (url, body, opts) => {
    captured = { url, body, opts };
    return { data: { short_url: "https://rzp.io/abc", id: "plink_1" } };
  };
  const link = await payments.createPaymentLink("919876543210");
  axios.post = realPost;
  check("link url returned", link.url === "https://rzp.io/abc");
  check("amount in paise (149 → 14900)", captured.body.amount === 14900);
  check("wa_from stashed in notes", captured.body.notes.wa_from === "919876543210");
  check("basic auth set", captured.opts.auth.username === "rzp_test_id");

  console.log(`\n${pass ? "✅ payments eval PASSED" : "❌ payments eval FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

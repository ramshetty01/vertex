// test-checkout.js — eval for Razorpay Standard Checkout (lib/checkout.js).
// Offline: signature verify. Live (if keys set): creates a real test-mode order.
// Run: node test-checkout.js

require("dotenv").config();
const crypto = require("crypto");
const checkout = require("../lib/checkout");

let pass = true;
const check = (n, ok) => { console.log(`  ${ok ? "✅" : "❌"} ${n}`); if (!ok) pass = false; };

// ---- Offline: signature verify ----
console.log("🧪 signature verify\n");
const secret = process.env.RAZORPAY_KEY_SECRET || "";
const order_id = "order_TEST123";
const payment_id = "pay_TEST456";
const goodSig = secret
  ? crypto.createHmac("sha256", secret).update(`${order_id}|${payment_id}`).digest("hex")
  : "";
check("valid signature accepted", checkout.verifyPaymentSignature({ order_id, payment_id, signature: goodSig }) === true);
check("bad signature rejected", checkout.verifyPaymentSignature({ order_id, payment_id, signature: "bad" }) === false);
check("missing fields rejected", checkout.verifyPaymentSignature({ order_id }) === false);

// ---- Live: create a real test-mode order ----
(async () => {
  if (!checkout.enabled()) {
    console.log("\nℹ️  No Razorpay keys — skipping live order creation.");
    console.log(`\n${pass ? "✅ checkout eval PASSED (offline)" : "❌ checkout eval FAILED"}`);
    process.exit(pass ? 0 : 1);
  }
  console.log("\n🌐 Live: creating a ₹149 test order...\n");
  try {
    const order = await checkout.createOrder({ amount: 14900, currency: "INR" });
    console.log("  order id:", order.id, "| amount:", order.amount, "| status:", order.status);
    check("order created", order.id && order.id.startsWith("order_"));
    check("amount echoed (14900)", order.amount === 14900);
  } catch (err) {
    console.error("  ❌ create failed:", (err && (err.error || err.message)) || err);
    pass = false;
  }
  console.log(`\n${pass ? "✅ checkout eval PASSED" : "❌ checkout eval FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

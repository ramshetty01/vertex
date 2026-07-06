// lib/email.js — SMTP sender for Tier-1 email applications (blueprint §2).
// Env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.
// If not configured, enabled()===false and the apply agent falls back to the
// assisted (link + cheat-sheet) tier instead of sending email.

const nodemailer = require("nodemailer");

const HOST = process.env.SMTP_HOST || "";
const PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";
const FROM = process.env.SMTP_FROM || USER;

const enabled = () => !!(HOST && USER && PASS);

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: PORT === 465,
      auth: { user: USER, pass: PASS },
    });
  }
  return transport;
}

// Send an email. attachments: [{ filename, content }]. Returns { messageId }.
async function sendEmail({ to, subject, text, attachments = [] }) {
  const info = await getTransport().sendMail({ from: FROM, to, subject, text, attachments });
  return { messageId: info.messageId };
}

module.exports = { enabled, sendEmail };

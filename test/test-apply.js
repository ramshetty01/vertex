// test-apply.js — eval for the apply agent (offline; no email sent).
// Verifies tier detection, cheat-sheet build, and audit record shape.
// Run: node test-apply.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const applyAgent = require("../agents/apply");
const emailLib = require("../lib/email");
// Capture what submitEmail would send, without SMTP (same module instance apply.js uses).
emailLib.sendEmail = async (opts) => opts;

const profile = { name: "Ram D", skills: [{ name: "Python" }], titles: ["AI Intern"] };
const tailored = {
  summary: "AI intern skilled in Python and LangChain.",
  highlights: ["Built chatbots", "Automated workflows"],
  skills: ["Python", "LangChain"],
};

const jobWithEmail = {
  title: "AI Engineer", company: "Acme",
  description: "Apply by sending your resume to careers@acme.io. Python required.",
  url: "https://acme.io/jobs/1",
};
const jobNoEmail = {
  title: "ML Engineer", company: "DataCorp",
  description: "Build ML pipelines. Python, scikit-learn.",
  url: "https://boards.greenhouse.io/datacorp/jobs/9",
};

let pass = true;
const check = (n, ok) => { console.log(`  ${ok ? "✅" : "❌"} ${n}`); if (!ok) pass = false; };

console.log("🧪 apply eval\n");

// Without SMTP configured, email-bearing job still falls back to assisted (email.enabled()===false)
const ch1 = applyAgent.detectChannel(jobWithEmail);
check("email job → assisted when SMTP disabled", ch1.tier === "assisted");

const ch2 = applyAgent.detectChannel(jobNoEmail);
check("no-email job → assisted", ch2.tier === "assisted");
check("greenhouse url flagged as ats", ch2.ats === "ats");

const app = applyAgent.prepareApplication(profile, jobNoEmail, tailored);
check("prepare returns cheatSheet", typeof app.cheatSheet === "string" && app.cheatSheet.length > 0);
check("cheat sheet has apply link", app.cheatSheet.includes(jobNoEmail.url));
check("cheat sheet has summary", app.cheatSheet.includes("AI intern skilled"));
check("cheat sheet has skills", app.cheatSheet.includes("Python"));
check("subject built", app.subject.includes("ML Engineer"));

// Email body build (unit — not sent)
const body = applyAgent.buildEmailText(profile, jobWithEmail, tailored);
check("email body names role", body.includes("AI Engineer"));
check("email body no fabricated skill", !/java|aws/i.test(body));

// Cover letter wiring (letter passed in — no LLM here)
const letter = { text: "Dear Hiring Team, I'm applying for the ML Engineer role at DataCorp. Best, Ram D" };
const appCL = applyAgent.prepareApplication(profile, jobNoEmail, tailored, [], {}, letter);
check("cover letter stored on app", appCL.coverLetter === letter.text);
check("cheat sheet includes cover letter", appCL.cheatSheet.includes("Cover letter") && appCL.cheatSheet.includes("applying for the ML Engineer"));

// When the channel is email, the letter becomes the email body
const appEmailCL = applyAgent.prepareApplication(profile, { ...jobWithEmail, applyEmail: "careers@acme.io" }, tailored, [], {}, letter);
check("no-cover-letter app → letter null, still builds", applyAgent.prepareApplication(profile, jobNoEmail, tailored).coverLetter === null);

// submitEmail attaches the REAL uploaded PDF when we have one
(async () => {
  const appEmail = applyAgent.prepareApplication(profile, { ...jobWithEmail, applyEmail: "careers@acme.io" }, tailored, [], {}, letter);
  appEmail.emailText = appEmail.emailText || "Cover letter body for email tier."; // submitEmail is email-tier only
  const pdfPath = path.join(os.tmpdir(), `resume-${Date.now()}.pdf`);
  fs.writeFileSync(pdfPath, "%PDF-1.4 fake");
  const sent1 = await applyAgent.submitEmail(appEmail, profile, pdfPath);
  check("email attaches real PDF by path", sent1.attachments.length === 1 && sent1.attachments[0].path === pdfPath);
  check("attachment named .pdf", /\.pdf$/.test(sent1.attachments[0].filename));
  fs.unlinkSync(pdfPath);

  // No PDF on file → fall back to a text attachment, NOT a fake "resume"
  const sent2 = await applyAgent.submitEmail(appEmail, profile, null);
  check("no PDF → text fallback, not named resume", sent2.attachments[0].filename === "application.txt");

  console.log(`\n${pass ? "✅ apply eval PASSED" : "❌ apply eval FAILED"}`);
  process.exit(pass ? 0 : 1);
})();

// agents/matcher.js — scores a job against a user profile
// Returns: { fit: number 0-100, strengths: string, gaps: string, hard_blockers: [string] }

const { completeJSON } = require("../lib/llm");

const SYSTEM_PROMPT =
  "You are a calibrated job-fit evaluator. Compare a candidate profile (JSON) against a job posting. " +
  "Respond with ONLY valid JSON, no markdown. Rules:\n" +
  '- "fit": integer 0-100. The score is driven PRIMARILY by skill/role overlap, not by years of experience. ' +
  "90+ = near-perfect skill and role match. 75-89 = strong skill match with minor gaps. " +
  "50-74 = partial skill match (some relevant skills, but real role gaps). Below 50 = wrong role or fails a stated requirement.\n" +
  "- EXPERIENCE RULE: compare the candidate's years to the job's stated MINIMUM. " +
  "If candidate years >= the minimum (or the range starts at 0, or no minimum is stated), experience is SATISFIED — " +
  "it is not a gap and not a blocker. Only if candidate years < the stated minimum: treat it as a gap, and cap fit at 65 " +
  "only when the shortfall is 2+ years.\n" +
  "- A candidate WITHIN a stated range (e.g. 0.5 yrs for a '0-2 years' role) fully satisfies that requirement. " +
  "For intern/junior/fresher roles (0-1 or 0-2 years, 'students welcome', 'strong freshers considered'), do NOT let a low TOTAL " +
  "experience count depress the score — a candidate with strong matching skills for such a role should score 85-95. " +
  "Low total experience is only a real gap when the job clearly wants a senior/more-experienced person.\n" +
  '- Judge ONLY from what the profile states. Missing information is a gap, not an assumed strength.\n' +
  '- "strengths": one short sentence naming the 2-3 strongest overlaps (specific skills).\n' +
  '- "gaps": one short sentence naming the most important missing requirements. If none, "None significant".\n' +
  '- "hard_blockers": ONLY requirements the candidate clearly FAILS (e.g. job minimum 5 yrs vs candidate 0.5; ' +
  "mandatory onsite city the candidate does not list). Each blocker max 12 words. " +
  "If you find yourself writing 'however' or 'but' in a blocker, it is NOT a blocker — return []. \n" +
  "- CANDIDATE PREFERENCES (if provided): treat as SOFT signals, not automatic blockers. " +
  "LOCATION: a job in a different city than the candidate prefers is a location GAP, NEVER a hard_blocker — " +
  "the candidate may relocate, and hybrid/remote roles rarely require it. Mark a location hard_blocker ONLY if the job text " +
  "EXPLICITLY says onsite-only with no remote AND explicitly forbids relocation. 'Hybrid' or plain 'Onsite' in another city is a gap, not a blocker. " +
  "SALARY: only a hard_blocker if the job's stated MAXIMUM salary is clearly below the candidate's stated minimum. " +
  "If a preference is 'any' or 'skip', ignore it entirely.\n" +
  'Schema: {"fit": number, "strengths": string, "gaps": string, "hard_blockers": [string]}';

// Render intake answers into a compact preferences block for the prompt.
// Skipped/empty fields are omitted so the model doesn't treat them as constraints.
function formatPrefs(prefs) {
  if (!prefs) return "";
  const lines = [];
  if (prefs.locationPref && prefs.locationPref !== "any")
    lines.push(`- Preferred location: ${prefs.locationPref}`);
  if (prefs.expectedSalaryLPA != null)
    lines.push(`- Minimum expected salary: ${prefs.expectedSalaryLPA} LPA`);
  if (prefs.noticePeriod && prefs.noticePeriod !== "any")
    lines.push(`- Notice period / availability: ${prefs.noticePeriod}`);

  // Learned feedback from past Not-Interested reasons — soft down-weighting signal.
  const fb = prefs.feedback || {};
  const fbParts = [];
  if (fb.salaryLow) fbParts.push(`low salary (x${fb.salaryLow})`);
  if (fb.wrongLocation) fbParts.push(`wrong location (x${fb.wrongLocation})`);
  if (fb.wrongRole) fbParts.push(`wrong role (x${fb.wrongRole})`);
  if (fb.company) fbParts.push(`company fit (x${fb.company})`);
  if (fbParts.length)
    lines.push(
      `- The candidate has previously declined roles citing: ${fbParts.join(", ")}. ` +
        `Weight these factors DOWN for similar jobs (soft signal, not a hard blocker).`
    );

  return lines.length ? `\n\nCANDIDATE PREFERENCES:\n${lines.join("\n")}` : "";
}

/**
 * Score one job against one profile.
 * profile: the parsed profile JSON from the parser agent
 * job:     { title, company, location, salary, description }
 * prefs:   optional intake answers { locationPref, expectedSalaryLPA, noticePeriod }
 */
async function scoreJob(profile, job, prefs = null) {
  const userContent =
    `CANDIDATE PROFILE:\n${JSON.stringify(profile)}\n\n` +
    `JOB POSTING:\nTitle: ${job.title}\nCompany: ${job.company}\n` +
    `Location: ${job.location}\nSalary: ${job.salary || "Not stated"}\n` +
    `Description: ${(job.description || "").slice(0, 4000)}` +
    formatPrefs(prefs);

  const result = await completeJSON(SYSTEM_PROMPT, userContent, "strong");

  // Defensive validation — never trust LLM output blindly
  const fit = Math.max(0, Math.min(100, Math.round(Number(result.fit) || 0)));
  return {
    fit,
    strengths: String(result.strengths || "").slice(0, 200),
    gaps: String(result.gaps || "").slice(0, 200),
    hard_blockers: Array.isArray(result.hard_blockers)
      ? result.hard_blockers.map(String)
      : [],
  };
}

// Run async tasks with a bounded concurrency window.
// Full parallelism bursts the NIM free tier and one congested moment times out
// the whole batch at once; a small window spreads load so each call keeps its
// own retry budget. Sequential (limit 1) is the most reliable, 2 is a balance.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * Score many jobs, return only those at/above the threshold,
 * best first, skipping any with hard blockers.
 */
async function findMatches(profile, jobs, prefs = null, threshold = 75) {
  const scored = [];
  await mapWithConcurrency(jobs, 2, async (job) => {
    try {
      const score = await scoreJob(profile, job, prefs);
      console.log(`🎯 ${job.title} @ ${job.company}: ${score.fit}%` +
        (score.hard_blockers.length ? ` (blocked: ${score.hard_blockers[0]})` : ""));
      if (score.fit >= threshold && score.hard_blockers.length === 0) {
        scored.push({ ...job, ...score });
      }
    } catch (err) {
      console.error(`❌ Scoring failed for ${job.title}:`, err.message);
      // Skip this job rather than fail the whole batch
    }
  });
  return scored.sort((a, b) => b.fit - a.fit);
}

module.exports = { scoreJob, findMatches };
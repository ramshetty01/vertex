# WORKLOG

Running recap of build sessions. Newest first. Each entry: what shipped, evals, verification, what's left. Complements CLAUDE.md §7 (status checklist) — this is the narrative/audit trail.

---

## 2026-07-06 — Fast burst: invite command + duplicate-apply guard

- **invite/share/refer** command → forwardable pitch + wa.me deep link to the bot (BOT_WA_NUMBER). Pilot growth loop. Added to menu.
- **Duplicate-apply guard**: alreadyApplied(user, job) (title+company, case-insensitive); startApply short-circuits with "already applied" + advances, before any LLM cost. Stops dupes from proactive re-surfacing / revisits.
- flow 38/38.

---

## 2026-07-06 — Fix: email apply attaches the real resume PDF

- Bug: submitEmail attached the cover-letter text as a file named `resume.txt` — a fake resume; the user's actual uploaded PDF was never sent.
- Fix: attach the real `user.resumePath` PDF (nodemailer `path`), named `<Name>_resume.pdf`; fall back to `application.txt` only when no PDF is on file — never a misleadingly-named file. `submitEmail(app, profile, resumePath)`.
- test-apply.js 16/16 (attaches real PDF by path, .pdf name, text fallback). flow 32/32.

---

## 2026-07-06 — Weekly digest push + live deploy verified

- **Deploy verified live** (whatshired-production.up.railway.app): health 200, webhook challenge echoes, /admin serves. Flagged to operator: ADMIN_TOKEN not set on Railway (dashboard/cron dead till set), no persistent volume yet (state wiped on redeploy), Razorpay in rzp_test mode.
- **Weekly digest** (blueprint §119 heartbeat): runDigestPush() sends each active user buildWeeklyDigest() = tracker + one profileTip() nudge; skips empty/new users. Guarded POST /admin/send-digest for a weekly cron (DEPLOY.md §6). test-digest.js 10/10. flow still 32/32.

---

## 2026-07-06 — Application status progression (blueprint §119)

- Full ladder `Prepared → Submitted → Viewed → Response → Interview → Closed` (`STATUS_LADDER` + per-stage emoji, `statusRank`).
- One-tap "any update?" check-in: global command `update`/`updates`/`log` → `UPDATE_PICK_APP` (native list of open apps, non-Closed) → `UPDATE_PICK_STATUS` (list of forward stages only) → saves `app.status` + `updatedAt`, audits to `applications.jsonl` (`event:"status_update"`), returns to the prior state via `statusReturnState`.
- Digest enriched (emoji per stage, interview count); `/admin/stats` "submitted" counts by rank so advanced stages still count. Added `update` to the menu.
- Auto-detection (email/ATS) is external → deferred; the user drives progress, which is the right pilot slice.
- Eval: `test-flow.js` now 32/32 (update→pick→forward-stages-only→save Interview→digest reflects→no-open-apps guidance).

---

## 2026-07-06 — Admin dashboard (pilot monitoring UI)

- **`public/admin.html`** + `GET /admin` route — visual Wizard-of-Oz dashboard: stat tiles (users / with-profile / paid / applications / submitted), users-by-state bars, per-user table (PII-masked ids), 10s auto-refresh, light/dark aware. Self-contained (inline CSS/JS, no CDN). Token entered at runtime, stored in the browser's localStorage only — never embedded in the page; sent as `X-Admin-Token` to the existing `/admin/stats`.
- Verified: `/admin` serves 200 with the page; `/admin/stats` contract matches what the page renders. Browser screenshot skipped (extension offline this session) — page is static DOM over the already-verified JSON endpoint.
- `PILOT.md` §4 updated to point at the dashboard. `test-flow.js` still 22/22 (route add, no handler change).

---

## 2026-07-06 — Phase 3 kickoff: pilot enablement

Moved from "Phase 2 code-complete" toward running a pilot. The remaining pilot work is operator activation (deploy + keys) + recruiting; these are the engineering pieces that make a pilot **safe and observable**.

### 1. Application rate-limit (blueprint §46) — `index.js`
- `APPLIES_PER_DAY` (default 10, env, 0 disables). Rolling 24h count of REAL submissions (`user.applications` ts). Gate at the top of `startApply` — refuses BEFORE spending LLM cost, tells the user quality-over-volume, leaves them free to browse/skip/ask.
- Exposed `appliesInLast24h` / `applyQuotaExceeded` for tests.
- Eval `test-ratelimit.js` 7/7 (helper window math, at-cap tap refused + no PREPARING_APPLY, under-cap tap proceeds).

### 2. Admin observability — `GET /admin/stats`
- Aggregate for Wizard-of-Oz monitoring: user count, state breakdown, applications total/submitted, paid count, per-user detail with **PII-masked** ids (`91***869`). `ADMIN_TOKEN`-guarded.
- Refactored the auth into a shared `adminGuard(req,res)` (run-matches now reuses it).
- Verified live: 403 unauthorized, real JSON authorized.

### 3. Pilot runbook — `PILOT.md`
- Success metric (% of matches acted on), operator prerequisites, live-verify steps, onboarding, monitoring (stats + logs + applications.jsonl), retention cron, known soft spots, post-pilot decision gate.

### Evals after this work
parser(manual), matcher 4/4, inquiry 6/6, tailor 5/5, jobs 5/5, payments 11/11, apply 13/13, editor 6/6, proactive 12/12, coverletter 7/7, ratelimit 7/7, flow 22/22 — all green.

---

## 2026-07-06 — Cover letter agent

### Cover letter — `agents/coverletter.js`
- **Why:** blueprint §26 ("a tailored resume variant, a cover letter if required") — spec'd, not yet built. Sibling to `agents/tailor.js`.
- **Built:** `writeCoverLetter(profile, job, tailored)` → `{ text }`. Strong tier, ONLY profile facts (§2.8), 120-180 words / 3 paras. Code-side fallback template (pure profile fields) on any LLM/JSON failure; strips a stray leading "Here is…" line.
- **Wired:** `startApply` generates it alongside the tailored resume → `prepareApplication(...coverLetter)` → becomes the EMAIL BODY (preferred over generic builder) + a *Cover letter* block in the assisted cheat sheet.
- **Evals:** `test-coverletter.js` 7/7 incl no-fabrication (job wants Java+AWS, both absent → letter claims neither). `test-apply.js` 13/13 (cover letter stored, in cheat sheet, null when absent). `test-flow.js` still 22/22.
- Not yet committed at time of writing this entry → see commit in git log.

---

## 2026-07-06 — Session: profile editing, proactive matches, live-key wiring

### 1. Field-level profile correction — `agents/editor.js` (commit `cbcc3f7`)
- **Problem fixed:** `CONFIRMING_PROFILE` dead-end — a typed correction was logged then ignored ("tell me what to fix" but never applied).
- **Built:** `applyCorrection(profile, text)` — strong tier, applies ONLY the user's stated change, defensive merge keeps every unchanged field, never loses the working profile on LLM/JSON failure. §2.8-safe (user states own facts, not fabrication).
- **Wired (`index.js`):** non-`ok` text in `CONFIRMING_PROFILE` → apply, re-show, re-confirm; `edit` command routes here; PDF resend re-parses. Factored `startParse()` / `startEdit()` (ack-then-background, §2.6). New `EDITING_PROFILE` state. Editor imported as namespace (stubbable).
- **Evals:** `test-editor.js` 6/6 (rename, add, set-years, fix-total, remove, + no-op bad case). `test-flow.js` 22/22 (added correction→apply→re-show→confirm→intake).

### 2. Proactive match sweep — retention loop (commit `f8ba61f`)
- **Built:** `runProactiveMatches()` in `index.js` — sweeps every stored user who finished onboarding and is `DONE` (out of matches), re-sources + re-scores, pushes only NEW jobs. Cross-run dedupe via `user.seenJobKeys` (bounded 500, `markSeen()`), keyed by shared `jobKey()` (exported from `lib/jobs.js`). New `store.all()`. Matcher imported as namespace (stubbable).
- **Trigger:** guarded `POST /admin/run-matches` (`ADMIN_TOKEN` header/query; 503 if unset — never open by default) for cron. DEPLOY.md §6 documents the curl + cron.
- **Caveat:** WhatsApp business-initiated push outside the 24h window needs an approved TEMPLATE — deferred; engine does content + matching regardless.
- **Evals:** `test-proactive.js` 12/12 (new-only push, seen-not-repushed, mid-flow user skipped, index/state/seen updates, idempotent second sweep).

### 3. Live API key wiring + verification
- **Verified live:** NVIDIA LLM (685ms), Adzuna (real jobs), Greenhouse ATS (19 jobs / 21 questions), Razorpay checkout (live test order created), `ADMIN_TOKEN` generated → `.env`, admin endpoint auth verified (403/403/200).
- **Still needs the operator (external accounts):**
  - `RAZORPAY_WEBHOOK_SECRET` — WhatsApp paywall auto-unlock (`payment_links` webhook). Web checkout works without it.
  - `SMTP_*` — Tier-1 email auto-apply. Falls back to assisted cheat-sheet without it.
  - Kapso live round-trip — config good; needs public webhook + a real inbound to fully confirm.

### State at end of session
- Pushed to `origin/main` through `f8ba61f`.
- All offline evals green: parser(manual), matcher 4/4, inquiry 6/6, tailor 5/5, jobs 5/5, payments 11/11, apply 10/10, editor 6/6, proactive 12/12, flow 22/22.
- Phase 1 + 2 feature-complete. Remaining: pilot recruitment, WhatsApp template for proactive push, operator-supplied keys above.

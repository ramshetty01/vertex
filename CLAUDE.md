# CLAUDE.md — Project Rules & Context

This file is the source of truth for how this codebase is built. Read it before making changes. It exists so that every session — human or AI — builds toward the same enterprise-grade end state instead of drifting.

---

## 1. What this project is

A WhatsApp bot that helps users find and apply to jobs. User sends a resume → bot parses it → scores real jobs against the profile → sends matches ≥75% fit as interactive cards → user replies Interested / Not Interested / Inquire → (later) an apply agent handles submission with human confirmation.

Full product spec: see `docs/blueprint.md` and `docs/enterprise-build.md` (the two planning documents from the original design conversation — copy them into the repo if not already there). This file is the *engineering constitution*; those are the *product plan*. When they conflict, this file wins for "how do we build it," the blueprint wins for "what are we building."

---

## 2. Non-negotiable architectural rules

These were each learned the hard way during initial build. Do not regress on them.

**2.1 One project folder, no duplicates.** There must be exactly one working copy of this code. Never `cd` into a subfolder and start a second `npm install` / parallel copy. (We lost an hour to this once — a stray `whatsapp-bot/` subfolder had its own `node_modules` and stale files while the root folder is what actually runs.) Before creating any new file, verify it doesn't already exist elsewhere in the repo.

**2.2 Every LLM call goes through `lib/llm.js`.** No agent file may instantiate its own OpenAI/NIM client. This is the seed of the LLM gateway: model routing, retries, timeouts, and JSON validation live in exactly one place. When switching providers or adding caching, this is the only file that changes.

**2.3 Model tiers, not one model for everything.** `MODELS.strong` (currently a 70B-class model) is for anything requiring rule-following and calibration: resume parsing, job scoring, resume tailoring. `MODELS.fast` (currently 8B-class) is for cheap/simple tasks: intent classification, routing. We proved empirically that 8B is unreliable for parsing (silently drops rules across identical runs) — don't move parsing/scoring to a faster tier without re-running the eval suite (`test-*.js` scripts) and confirming calibration holds.

**2.4 Never trust raw LLM output — validate and clamp everything.** Every agent that returns JSON must: extract JSON defensively (regex match, not naive `JSON.parse` on raw content), clamp numeric ranges (e.g. fit score to 0–100), coerce types, and provide safe fallbacks for missing fields. See `agents/matcher.js` `scoreJob()` for the pattern to copy.

**2.5 Every agent gets a test script before it's wired into the bot.** Pattern: `test-<agent>.js` at repo root, using a **fixed, realistic input** and a written **expected outcome** in comments/logs — not just "does it run," but "does it rank/score sensibly." Before wiring any agent into `index.js`, its test script must pass a sanity check on at least 3–4 varied cases (including at least one deliberately-bad case that should score low / get rejected). Keep these scripts; rerun them after every prompt or model change. They are the eval suite from the enterprise doc, grown organically.

**2.6 Webhook handlers ack fast; heavy work happens async.** Twilio/Meta expect a response within ~15s. Any handler branch that calls an LLM or does slow I/O must: (a) send an immediate acknowledgment message via the TwiML response, (b) do the real work in a non-awaited async IIFE or background job, (c) push the result later via the REST API (`twilioClient.messages.create`), not the webhook's TwiML response. Never let a webhook response wait on an LLM call.

**2.7 State lives in data, never in memory alone.** DONE — user state is now persisted to SQLite (`lib/store.js`, `bot.db`, better-sqlite3). The in-memory `users` Map is a write-through working set; `getUser` lazy-loads from SQLite so state survives restarts. `persist(from)` is called after the handler and in a `finally` at the end of every background IIFE (parse/match/paywall/apply/inquiry) + `unlockAndResume`. Whole user object stored as one JSON row (all fields are plain data). `BOT_DB_PATH` env overrides the file (tests use a temp db). When adding new background state mutations, add a `persist(from)` at their completion. Migrate to Postgres only when multi-instance/concurrency demands it.

**2.8 No fabrication, ever, in any agent.** The parser must not invent skill-years, employers, or experience not stated in source text. The matcher must judge only from stated profile facts. The future resume-tailor must never claim experience the user doesn't have. If you're tempted to have a prompt "fill in a reasonable guess," don't — return `null`/empty instead and let the user or a downstream step fill the gap explicitly.

**2.9 One-tap human confirmation before anything is sent externally.** No agent may submit a job application, send an email, or take an irreversible external action without an explicit user confirmation step. This applies even in "assisted apply" mode. This is both a legal/ethical requirement and a quality gate.

---

## 3. Prompt-writing rules (learned from real miscalibrations today)

- State explicit score bands/definitions — don't let the model invent its own scale.
- If a rule can be *over*-applied (e.g. "penalize experience gaps" → model penalizes ALL experience mentions), add a counter-example or an explicit "satisfied" condition, not just the penalty condition. Every constraint needs its positive counterpart stated too.
- Add a "tell" for self-contradiction: e.g. *"if you find yourself writing 'however' or 'but' in a blocker field, it is not a blocker — return empty."* This catches models reasoning correctly but filing the answer wrong.
- Location, salary, and other soft-preference fields should default to **soft signal / gap**, not **hard blocker**, unless the source text is explicit and absolute (e.g. "onsite only, no remote/relocation considered").
- After any prompt change, re-run the relevant `test-*.js` script and check outputs against the *written* expected outcomes before considering the change done. A prompt change is not finished until the eval script confirms it.

---

## 4. File structure (current + intended)

```
backendforgr/
├── CLAUDE.md              # this file
├── index.js               # orchestrator: webhook + conversation state machine
├── test-llm.js            # sanity ping for the LLM client
├── test-matcher.js        # eval script for the matcher agent
├── test-parser.js         # (add when parser eval script is built)
├── .env                   # secrets — NEVER commit
├── .gitignore             # must include .env, node_modules/, resumes/
├── agents/
│   ├── parser.js          # Level 1 agent: resume PDF -> profile JSON
│   ├── matcher.js         # Level 1 agent: profile + job -> fit score
│   ├── inquiry.js          # (not yet built) Level 2 agent: answers questions about a role
│   └── apply.js            # (not yet built) Level 3 agent: tiered apply workflow
├── lib/
│   └── llm.js              # shared LLM client, model routing, retries, JSON validation
└── resumes/                 # uploaded resumes — gitignored, contains PII
```

Rule: new agents go in `agents/`. Shared infra goes in `lib/`. Nothing agent-specific gets added to `lib/llm.js` — it stays a generic gateway.

---

## 5. Environment & secrets

`.env` must contain: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `NVIDIA_API_KEY`. Never hardcode these. Never commit `.env`. If a key is pasted into chat, code, or a commit by accident, rotate it immediately.

Current LLM provider: NVIDIA NIM free tier (`https://integrate.api.nvidia.com/v1`), OpenAI-compatible. Free tier is for prototyping/pilot only — expect rate limits (40 req/min) and peak-hour latency/timeouts. This is a known, accepted limitation until a paid provider is chosen for production; don't over-engineer around free-tier congestion beyond reasonable retries/timeouts.

Messaging goes through ONE gateway: `lib/messaging.js` (same pattern as `lib/llm.js`). Provider is env-switched via `MESSAGING_PROVIDER`; the app only ever calls `parseInbound` / `sendMessage` / `downloadMedia`, never a provider SDK directly. Swapping providers is a one-file/one-env change.

The gateway supports two provider *shapes*: request providers (kapso, twilio) receive inbound via the express webhook (`parseInbound(req)`); push providers (wwebjs) run a persistent client and feed the same handler via `init({onMessage})`. Both produce one normalized inbound `{ from, text, numMedia, mediaType, downloadMedia() }` and call the shared `handleInbound()` in `index.js`. Because none rely on a synchronous reply (Twilio TwiML is gone), ALL outbound goes via REST `sendMessage` and the webhook just acks 200 — cleanly satisfies §2.6.

Current provider: **Kapso** (`MESSAGING_PROVIDER=kapso`) — a Meta WhatsApp Cloud API-compatible proxy (`api.kapso.ai`), OFFICIAL path: no daily cap, native buttons/lists, real numbers. Send = `POST {KAPSO_API_URL}/meta/whatsapp/v24.0/{KAPSO_PHONE_NUMBER_ID}/messages` with `X-API-Key` header and Meta-style body `{messaging_product,to,type,text:{body}}`. Inbound webhook event `whatsapp.message.received`: `message.from` (digits), `message.text.body`, media at `message.kapso.media_url` (+ `media_data.content_type`), fetched with the `X-API-Key` header. Env: `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_API_URL`. Setup is via the `@kapso/cli` (`kapso login`, `kapso setup`) — user runs those; they must also point Kapso's webhook at this bot's public `/webhook` URL (ngrok in dev). Being a request provider, Kapso needs the express webhook publicly reachable.

**wwebjs** (`MESSAGING_PROVIDER=wwebjs`) — `whatsapp-web.js` in-process, QR in terminal, session in `.wwebjs_auth/` (gitignored). Kept as a free local-testing fallback. ⚠️ UNOFFICIAL (against WhatsApp ToS) — ban risk under automation; burner number only, NEVER production. (WAHA was removed in favor of Kapso.)

**Twilio** (`MESSAGING_PROVIDER=twilio`) still supported. Sandbox limits: join code, 72h expiry, no native buttons, 9 msgs/day (error 63038 — the reason we moved off it).

---

## 6. What NOT to do (yet)

- Don't add a multi-agent framework (LangChain/LangGraph/CrewAI). Current agents are plain functions with explicit control flow — keep it that way until an agent genuinely needs multi-step autonomous looping with tool calls (the future `apply.js`), and even then, evaluate need first.
- Don't build the fully-autonomous apply agent. Per the blueprint, apply is tiered (email → ATS API → assisted pre-fill → cheat-sheet) and always ends in explicit user confirmation. Never attempt silent/autonomous submission to a third-party portal.
- Don't scrape LinkedIn/Naukri/Indeed directly. Use aggregator APIs (Adzuna, JSearch, Jooble) and direct ATS feeds (Greenhouse, Lever) first. A scraping tool (e.g. Firecrawl) is acceptable for job-posting ingestion from arbitrary company career pages, not for resume parsing (unnecessary — resumes are simple, sensitive PII; keep that pipeline local/direct) and not for login-walled job boards.
- Don't move to Postgres/Kubernetes/Kafka/multi-tenancy until the pilot validates the core loop (users act on ≥75% matches). Architecture should scale *conceptually* (clean separation of concerns) without scaling *operationally* (infra complexity) before there's a reason to.
- Don't skip the test script step to "move faster." Every skipped eval has, so far, shipped a real miscalibration (invented experience years, over-strict blockers, project names as job titles). The test script is faster than debugging it live against a real user.

---

## 7. Current status (update this section as the project progresses)

- [x] WhatsApp sandbox connected (Twilio), webhook verified end-to-end
- [x] Conversation state machine: NEW → AWAITING_RESUME → CONFIRMING_PROFILE → AWAITING_JOB_RESPONSE → DONE
- [x] `agents/parser.js` — resume PDF → profile JSON, calibrated after 3 iterations (fixed: invented skill-years, project-names-as-titles, employer-names-as-locations)
- [x] `lib/llm.js` — shared client, model tiers, JSON-validated completion helper
- [x] `agents/matcher.js` — job fit scoring, calibrated after 2 iterations (fixed: over-strict experience blocking; misplaced-prompt bug that reverted the calibration)
- [x] Wire `findMatches` into `index.js` — replaced hardcoded `JOBS` with `CANDIDATE_JOBS` scored live via `findMatches` on profile confirm (parallel `Promise.allSettled`)
- [x] Async ack-then-process pattern — resume parse AND job scoring both ack instantly, run in background IIFE, push results via `twilioClient.messages.create`
- [x] Structured intake step (location/salary/notice-period) — 3-question flow after profile confirm; answers stored in `user.intake` and fed to matcher as SOFT signals (hard-block only on absolute incompatibility). `findMatches` now concurrency-capped at 2 (4-wide parallel bursts the free tier and times out the whole batch at once). Eval PASSES 4/4: intern 90% + LLM-dev 90% pass, Java senior 0% blocked on experience, ML junior 90% (judgment call). Two calibration fixes needed along the way: (a) location preference must be a GAP not a hard_blocker for hybrid/other-city roles; (b) low TOTAL experience must not depress scores for intern/junior roles that welcome freshers.
  - ⚠️ `MODELS.strong` swapped `meta/llama-3.3-70b-instruct` → `meta/llama-3.1-70b-instruct` because the 3.3 NIM endpoint was down (60-90s timeouts; 3.1 alive ~11s). Per §2.3 the eval was re-run and re-calibrated for 3.1. If 3.3 comes back and is preferred, re-run `test-matcher.js` before switching — do NOT assume the two share calibration (3.1 clusters strong matches flat at 90; 3.3 gave more spread).
- [x] Messaging gateway `lib/messaging.js` — provider-agnostic (kapso/wwebjs/twilio), request+push shapes feed one `handleInbound()`; all outbound via REST. Active: **kapso** (official Meta Cloud proxy, no cap, native buttons). wwebjs kept as unofficial local-test fallback; WAHA removed. Moved off Twilio to escape sandbox 63038 cap. See §5.
- [x] `agents/inquiry.js` — answers role questions from the JD only; honest "not stated" + offers to relay; prompt-injection defense (JD treated as data). Wired into `index.js` as the `INQUIRING` state (option 3). Eval `test-inquiry.js` PASSES 6/6 incl an embedded-injection JD (reported ₹25k stipend, never the injected "50 LPA"). LESSON: over-constraining output format ("no double quotes inside answer") made the model DROP the value's own quotes → invalid JSON. Fix was raw `complete()` + tolerant field extraction in the agent, NOT a stricter prompt. Added `complete()` (raw, no parse) to `lib/llm.js` for prose-heavy agents.
- [x] Native interactive messages (Kapso) — gateway exposes `sendInteractive(to, {body, buttons|list})`; job cards use 3 reply BUTTONS (Interested/Not/Ask), notice-period uses a LIST. Button/list ids reuse the "1"/"2"/"3"/"4" tokens, and `parseInbound` maps a tap's `interactive.*_reply.id` back to `text`, so a tap is identical to typing — handler logic unchanged. twilio/wwebjs fall back to numbered text automatically. Verified: payload JSON matches Meta spec, taps round-trip to the right token.
- [x] Job sourcing `lib/jobs.js` — Adzuna (India feed, API-first per blueprint §3): fetch → normalize (strip HTML, salary→LPA) → dedupe(company+title+location). `sourceJobsForUser()` in index.js builds a query from profile titles+skills and intake location, falls back to sample `CANDIDATE_JOBS` if no keys / no results. Offline eval `test-jobs.js` PASSES 5/5. ⚠️ Needs `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` (free) for live jobs; until set, uses samples. RECALL TUNING (from live run): query = top skills + role words, capped to 4 terms, sent with Adzuna `what_or` (broad=true, match ANY) — long/niche multi-term queries return 0 even with what_or, so keep it short. Skills-first. This took recall 1→9 real jobs; the matcher handles precision.
- [x] Feedback loop — Not-Interested → one-tap reason LIST (salary/location/role/company); counts stored in `user.feedback`, injected into matcher prefs as a soft down-weight signal (`formatPrefs`). New `SKIP_REASON` state; `advanceToNext`/`withAck` refactor.
- [x] Profile-edit / navigation — global commands `menu`/`help`, `edit` (re-show summary + accept new resume PDF), `back` (re-show current card), checked before the state switch. Closes the pilot dead-ends (see [[whatsapp-bot-usability-gaps]] memory, now resolved).
- [x] `agents/editor.js` — field-level profile correction (Phase 1 dead-end fix). In `CONFIRMING_PROFILE`, any non-`ok` text (or `edit` from anywhere) applies the user's free-text fix ("add Docker", "I have 3 yrs Python", "name is Ramesh") to the profile via the strong tier, re-shows the summary, re-confirms. §2.8-safe: the USER states their own facts (not fabrication); code-side defensive merge keeps every unchanged field and never loses the working profile on LLM/JSON failure. Re-uploading a PDF at confirm re-parses (edit-by-resend). Parse-start factored into `startParse()`, correction into `startEdit()` (both ack-then-background per §2.6; new states `PARSING`(reused)/`EDITING_PROFILE`). Editor imported as a namespace so tests can stub it. Eval `test-editor.js` PASSES 6/6 (rename, add, set-years, fix-total, remove, + no-op bad case "find me a job" leaves profile unchanged). `test-flow.js` now 22/22 (added: correction ack→apply→re-show→confirm→intake).
- [x] Razorpay paywall `lib/payments.js` (Phase 2, blueprint §5) — free to browse/skip; first Interested/Inquire tap triggers a payment link (`AWAITING_PAYMENT` state); Razorpay webhook `/razorpay-webhook` (HMAC-verified, raw body captured via express.json verify) → `unlockAndResume` continues the parked action. Graceful-disabled when no keys (everyone treated as paid). Eval `test-payments.js` PASSES 11/11. ⚠️ Needs `RAZORPAY_KEY_ID`/`KEY_SECRET`/`WEBHOOK_SECRET` + webhook registered at Razorpay for live.
- [x] Cover letter `agents/coverletter.js` (Phase 2, blueprint §26 "a tailored resume variant, a cover letter if required") — sibling to tailor.js. Strong tier, ONLY profile facts (§2.8), 120-180 words / 3 paras. Code-side fallback template (pure profile fields) on any LLM/JSON failure, plus a leading-"Here is" stripper. Wired into `startApply`: generated alongside the tailored resume, passed to `prepareApplication(...coverLetter)` → becomes the EMAIL BODY (preferred over the generic builder) and a *Cover letter* block in the assisted cheat sheet. Eval `test-coverletter.js` PASSES 7/7 incl the no-fabrication check (job demanding Java+AWS, both absent → letter claims neither). `test-apply.js` now 13/13 (cover-letter stored, in cheat sheet, null when absent).
- [x] Resume tailor `agents/tailor.js` (Phase 2, blueprint §6) — reorders/rephrases REAL profile experience to match a JD; code-side no-fabrication guard filters output skills to those actually in the profile. `formatTailoredPreview` renders a WhatsApp preview. Eval `test-tailor.js` PASSES 5/5 incl the key check: a job demanding Java+AWS (absent) never gets them claimed.
- [x] Assisted apply `agents/apply.js` + `lib/email.js` (Phase 2, blueprint §2) — Interested → tailor resume → preview + one-tap confirm (§2.9) → apply. Tier-1 email (SMTP via nodemailer) when the posting exposes an email AND SMTP configured; otherwise assisted fallback = 1-tap apply link + copy-paste cheat sheet (always works, user is final submitter). Greenhouse/Lever URLs flagged as ATS. Every send snapshotted to append-only `applications.jsonl` (gitignored, PII). States `PREPARING_APPLY`/`CONFIRM_APPLY`. Eval `test-apply.js` PASSES 10/10. ⚠️ Tier-1 email needs `SMTP_*`; Tier-2 ATS auto-submit not built (needs per-company tokens) — assisted covers it. (Custom-question relay: now built, see below.)
- [x] Application tracker + digest (Phase 2, blueprint §9) — each apply pushes to `user.applications` (Prepared/Submitted); `buildDigest()` renders progress; global command `status`/`digest`/`applications` shows it on demand. Scheduled weekly template push deferred (needs cron + approved WhatsApp template).
- [x] Application status progression (blueprint §119) — full ladder `Prepared → Submitted → Viewed → Response → Interview → Closed` (`STATUS_LADDER`, per-stage emoji). One-tap "any update?" check-in: global command `update`/`updates`/`log` → `UPDATE_PICK_APP` (native list of open apps, non-Closed) → `UPDATE_PICK_STATUS` (list of forward stages only) → saves `app.status` + `updatedAt`, audits to `applications.jsonl` (`event:"status_update"`), returns to the prior state (`statusReturnState`). Digest + `/admin/stats` count "submitted" by rank (≥ Submitted) so advanced stages still count; digest surfaces interview count. Auto-detection (email/ATS) is external and deferred — user drives progress. Covered by `test-flow.js` (now 32/32: update→pick→forward-stages-only→save Interview→digest reflects→no-open-apps guidance).
- [x] Proactive match sweep (Phase 2, blueprint §9 retention loop) — `runProactiveMatches()` in index.js sweeps every stored user (`store.all()`, new) who finished onboarding AND is `DONE` (out of matches), re-sources+re-scores, and pushes only genuinely NEW jobs. Cross-run dedupe via `user.seenJobKeys` (bounded 500; `markSeen()`), keyed by shared `jobKey()` (exported from lib/jobs.js, reuses the dedupe key). Fresh jobs append to `user.matches`, `currentJobIndex` points at the first new one, state → `AWAITING_JOB_RESPONSE`. Guarded admin trigger `POST /admin/run-matches` (`ADMIN_TOKEN` header/query; 503 if unset — never open by default) for a cron/scheduler; also exported for tests. Matcher imported as a namespace (`matcher.findMatches`) so tests stub it. Eval `test-proactive.js` PASSES 12/12 (new-only push, seen-not-repushed, mid-flow user skipped, index/state/seen updates, idempotent second sweep). ⚠️ WhatsApp: business-initiated push outside the 24h window needs an approved TEMPLATE — deferred; engine produces content + matching either way. See DEPLOY.md §6.
- [x] Offline flow smoke test `test-flow.js` — guards server startup behind `require.main === module`, exports `handleInbound`/`getUser`/`users`; stubs messaging, drives the state machine with no LLM/network. PASSES 10/10 (welcome, menu, status, skip→reason→feedback→advance, confirm-apply→cheat-sheet→tracker). **All evals green: parser(manual), matcher 4/4, inquiry 6/6, tailor 5/5, jobs 5/5, payments 11/11, apply 13/13, editor 6/6, proactive 12/12, coverletter 7/7, ratelimit 7/7, flow 32/32.**
- [x] Razorpay Standard Web Checkout `lib/checkout.js` + `public/checkout.html` — SEPARATE from the WhatsApp Payment-Links paywall (`lib/payments.js`). Routes in index.js: `GET /api/config` (KEY_ID only), `POST /api/create-order` (orders API, amount≥100 paise, 401/500 handling), `POST /api/verify-payment` (HMAC `order_id|payment_id`, 400 on mismatch/missing — never marks paid otherwise). Frontend uses checkout.js modal, handles dismiss/payment.failed. KEY_SECRET never leaves backend. Eval `test-checkout.js` PASSES (sig 3/3 + live test order); all endpoints HTTP-smoke-verified. Test card 4111 1111 1111 1111. ⚠️ Setting RAZORPAY_KEY_ID/SECRET ALSO enables the WhatsApp paywall — that flow additionally needs RAZORPAY_WEBHOOK_SECRET + a registered webhook to auto-unlock, else pay-link users pay but don't unlock.
- [x] ATS read-ingestion `lib/ats.js` (blueprint §3 secondary source) — free/public Greenhouse + Lever job feeds (no key). `fetchAtsJobs()` merges configured boards; `sourceJobsForUser` now pools Adzuna + ATS, dedupes, caps at 10. `fetchGreenhouseQuestions()` pulls a job's required application questions, fed into the apply cheat-sheet (custom-question-relay foundation). `detectChannel` now uses `job.applyEmail`. Eval `test-ats.js` PASSES incl LIVE Greenhouse (19 jobs, 21 questions). Config: `GREENHOUSE_BOARDS`, `LEVER_COMPANIES` (comma slugs). SEEDED live-verified India-relevant Greenhouse boards: `postman,groww,coinbase,gitlab` (409 jobs pooled, filter surfaces relevant ML/AI roles incl "Remote - India"). Other working boards found: stripe/databricks/dropbox (remote-heavy). NOTE (confirmed 2026-07): NO ATS offers free/open application *submission* — read-only. True free auto-apply = email (Tier 1) only; ATS submit needs the employer's key.
- [x] SQLite persistence `lib/store.js` (§2.7 — pre-pilot requirement, now DONE) — user state survives restarts; write-through Map + lazy-load; `persist(from)` after handler + in every background IIFE's `finally`. Eval `test-persist.js` PASSES 8/8 (round-trip, reload-after-eviction keeps paid/profile/applications, restart clears row). `bot.db` gitignored.
- [x] Custom-question relay (Phase 2, blueprint §6) — a job's required questions (from Greenhouse) that aren't already answered are relayed one-by-one in WhatsApp (`RELAY_QUESTIONS` state); each answer saved to `user.savedAnswers` and REUSED on future applications (shown pre-filled in the cheat sheet, never asked twice). `prepareApplication` splits questions into known/unknown via savedAnswers. Covered by `test-flow.js` (now 16/16: relay saves, asks next, reuses saved, new question stays unknown).
- Phase 1 + Phase 2 feature-complete. Every planned agent/feature built + evald. Remaining is activation (keys) + pilot.
- [x] Phase 3 pilot-enablement (engineering pieces): application rate-limit (blueprint §46 — `APPLIES_PER_DAY`, rolling 24h count of real submissions, gate in `startApply` before LLM cost, refuses + lets user keep browsing; eval `test-ratelimit.js` 7/7); admin observability `GET /admin/stats` (aggregate + PII-masked ids, `ADMIN_TOKEN`-guarded via shared `adminGuard`); pilot runbook `PILOT.md`. Remaining pilot work is operator activation (deploy + keys) + recruiting, not code.
- [ ] Recruit 10 pilot users, run Wizard-of-Oz test on real jobs (see `PILOT.md`)
- Phase 2 code-complete. Live activation needs external keys: ADZUNA (jobs), RAZORPAY (paywall), SMTP (Tier-1 email). Without them the bot runs on samples / no-paywall / assisted-apply — full flow still works.
- [x] Profile-edit / navigation gaps (see memory) — RESOLVED: field-level correction via `agents/editor.js` (typed fixes now applied, not just logged); `back`/`edit`/PDF-resend all wired. See editor entry above.
- [ ] `agents/apply.js` (not started — Phase 2, post-pilot-validation)

---

## 8. How to work in this repo (for any future session)

1. Read this file first.
2. Check section 7 for current status before assuming what exists.
3. Any new agent: write the test script alongside it, with realistic input and a written expected outcome, before wiring it into `index.js`.
4. Any prompt change: rerun the relevant test script, compare against expected outcomes, don't consider it done until it passes.
5. Any new external dependency (API, package, service): note it in section 5 or add a new section — don't let tooling decisions live only in chat history.
6. When in doubt between "fast hack" and "the enterprise-doc-approved pattern," default to the fast hack *if and only if* it's flagged in section 7 as a known pilot-stage shortcut. Otherwise, follow the architecture in section 2.

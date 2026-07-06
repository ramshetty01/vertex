# WORKLOG

Running recap of build sessions. Newest first. Each entry: what shipped, evals, verification, what's left. Complements CLAUDE.md §7 (status checklist) — this is the narrative/audit trail.

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

# PILOT — Phase 3 runbook (Wizard-of-Oz, 10 users)

Goal of the pilot: validate the core loop — **do users act on ≥75% matches?** (CLAUDE.md §6). Everything here is activation + observation, not new building.

---

## 0. Success metric
The one number that matters: **% of surfaced matches a user acts on** (Interested or Inquire, not skip). Secondary: replies to proactive pushes, applications prepared/sent. Track weekly.

---

## 1. Operator prerequisites (things only you can do — external accounts)
These block a fully-live pilot. The bot runs without them (samples / no-paywall / assisted-apply), but for a real pilot set:

- [ ] **Deploy** to Railway with a persistent volume — see `DEPLOY.md`. Sets `BOT_DB_PATH=/data/bot.db`, `UPLOAD_DIR=/data/resumes`.
- [ ] **Kapso webhook** pointed at the deployed `/webhook` (DEPLOY.md §5). Needed for real WhatsApp in/out.
- [ ] `ADMIN_TOKEN` — random secret (already generated locally; set the same on Railway).
- [ ] **Razorpay** (optional for paywall pilot): `RAZORPAY_WEBHOOK_SECRET` + a registered webhook at `/razorpay-webhook`. Without it, pay-link users pay but don't auto-unlock. For a first pilot, consider leaving payments OFF (unset keys ⇒ everyone treated as paid) to measure the *loop*, not willingness to pay.
- [ ] **SMTP** (optional): enables Tier-1 email auto-apply. Without it, apply falls back to the assisted cheat-sheet (always works).
- [ ] `APPLIES_PER_DAY` — daily apply cap (default 10). Blueprint §46.

## 2. Verify live before inviting anyone
Run these against the DEPLOYED url:
- `GET /` → `Job bot is running ✅`
- `GET /admin/stats` with `X-Admin-Token` → JSON (starts at `{"users":0,...}`)
- Send yourself the flow on WhatsApp: PDF → confirm → intake → matches → tap Interested → confirm → cheat sheet. This is the smoke test that matters.

## 3. Onboarding the 10 users
- Give each the WhatsApp number + a one-line "send your resume as a PDF to start."
- Wizard-of-Oz: you watch `GET /admin/stats` and the server logs. If the bot mis-handles something, you can (manually, out of band) nudge the user — the point is to learn where the loop breaks, not to have a perfect bot.

## 4. Monitoring (during the pilot)
- **`GET /admin/stats`** — aggregate: user count, state breakdown, applications, paid. PII-masked ids. Poll it or curl on a loop.
- **Server logs** — every inbound is logged `📩 [STATE] from: text`; matcher logs each job's fit %; proactive sweep logs pushes.
- **`applications.jsonl`** — append-only audit of every prepared/sent application (gitignored, PII). Review before a user's interview.

## 5. Retention loop (proactive matches)
- Schedule a daily cron: `POST /admin/run-matches` with `X-Admin-Token` (DEPLOY.md §6).
- ⚠️ Pushing users outside their 24h WhatsApp session needs an approved **template**. For a small pilot, users are usually active within 24h; broad rollout needs the template.

## 6. What to watch for (known soft spots)
- Free-tier NIM latency/timeouts under load (§5) — matcher is concurrency-capped at 2; expect occasional slow scores.
- Adzuna recall on niche queries — falls back to ATS boards + samples.
- Profile parse quality on unusual resume layouts — user can now fix fields by typing (e.g. "add Docker") thanks to `agents/editor.js`.

## 7. After the pilot — decision gate
If users act on ≥75% matches at a meaningful rate → proceed to scale (paid provider, Postgres per DEPLOY.md, WhatsApp templates, payments on). If not → the problem is match quality or the loop, not infra; iterate the matcher/sourcing before scaling. (CLAUDE.md §6: don't scale operationally before the loop validates.)

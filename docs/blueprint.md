# WhatsApp Job Application Agent — Product Blueprint

A complete product plan integrating the original workflow with solutions to the four hard problems (auto-apply, scraping, WhatsApp API rules, payment placement) and all recommended improvements.

---

## 1. Revised End-to-End Workflow

The original flow was: user → resume → payment → scrape → score → notify → interested / not interested / inquire → apply → update. The revised flow keeps that skeleton but moves payment later, adds a structured intake step, and replaces fully autonomous apply with assisted apply.

**Step 1 — Onboarding.** User messages the WhatsApp number (or clicks a wa.me link from your landing page). This counts as opt-in, which Meta requires. The bot introduces itself and asks for a resume (PDF or DOCX upload directly in WhatsApp).

**Step 2 — Resume parsing into a structured profile.** An LLM parses the resume into structured JSON: skills, years of experience per skill, titles, industries, education, certifications, and notable achievements. This structured profile — not the raw PDF — is what every downstream agent uses. It also powers per-job resume tailoring later.

**Step 3 — Structured intake (the improvement that fixes most bad matches).** The resume alone misses the biggest match-killers, so a quick button-based flow collects: preferred locations (or remote/hybrid/onsite), current and expected salary range, notice period, target roles, and any hard no-gos (e.g., no night shifts, no contract roles). This takes under a minute with WhatsApp interactive buttons and list messages, and every answer becomes a hard filter or scoring input.

**Step 4 — Free taste before payment.** The matching pipeline runs and the user receives their first 3–5 matched jobs above the 75% threshold, with explained fit scores, completely free. They can view but not act. This is the value demonstration that makes the paywall convert.

**Step 5 — Payment.** When the user taps Interested or Inquire for the first time, they hit the paywall. Payment happens via a Razorpay payment link sent in chat (WhatsApp Pay is an option in India but Razorpay links are simpler to start). Pricing models are covered in Section 6.

**Step 6 — Ongoing matching and notification.** A scheduled pipeline continuously ingests jobs, scores them against the user's profile, and pushes anything ≥75% to the user via an approved utility template. Each job card contains: title, company, location, salary if available, the explained fit score, and three buttons — Interested, Not Interested, Inquire.

**Step 7 — The three-button decision.**
Interested routes to the assisted-apply flow (Step 8). Not Interested triggers a one-tap optional reason ("salary low / wrong location / wrong role / company") that feeds back into the scoring model — this feedback loop is what makes matches improve week over week. Inquire routes to the inquiry agent, which answers questions about the role from the job description and public company data ("is it remote?", "what's the interview process?", "what does this company do?"). If the answer isn't in available data, the agent says so honestly rather than guessing.

**Step 8 — Assisted apply (not autonomous apply).** The apply agent prepares everything: a tailored resume variant, a cover letter if required, and pre-filled answers to standard form fields. Then, depending on the application channel: for email applications it sends on the user's behalf after a one-tap confirm; for ATS portals it either uses an official API where available or sends the user a magic link to a pre-filled application they submit with one tap. When the agent hits a custom question it can't answer ("Why do you want to work here?", "Do you have a driving license?"), it forwards the question to the user in WhatsApp, includes their reply, and continues. The user's final tap means the human is technically the submitter — which is both better UX trust-wise and much safer legally.

**Step 9 — Tracking and updates.** Every application enters a tracker. The user gets a weekly digest ("Applied to 6 jobs, 1 recruiter view, 0 responses, 4 new matches waiting") and event-driven updates when status changes are detectable (email replies parsed with consent, ATS status where APIs allow). This loop is the retention engine.

---

## 2. Hard Problem #1 — Auto-Apply

**Why it's hard.** LinkedIn, Naukri, and Indeed prohibit automated applications in their terms of service and actively detect automation through CAPTCHAs, behavioral fingerprinting, device signals, and login challenges. Beyond the boards themselves, most serious applications route through company ATS portals — Workday, Greenhouse, Lever, SAP SuccessFactors, Zoho Recruit, Darwinbox (common in India) — each with different form structures, mandatory custom questions, document requirements, and sometimes timed assessments. A fully autonomous browser-automation agent breaks constantly, gets accounts banned, and risks submitting wrong answers to questions it shouldn't guess (visa status, salary, notice period specifics).

**The solution: a tiered apply strategy, ordered by reliability.**

Tier 1, email applications: many postings (especially SME and startup roles in India) accept applications by email. Fully automatable and safe. The agent composes a tailored email with the tailored resume attached and sends after user confirmation.

Tier 2, official ATS APIs and public endpoints: Greenhouse and Lever expose public job-board APIs and application endpoints for many companies; use these wherever they exist. They're stable, legal, and don't require scraping.

Tier 3, assisted apply with pre-fill: for portals with no API, the agent prepares all field values and either generates a deep link with URL-parameter pre-fill where supported, or presents the user a summary card in WhatsApp with a "Confirm & Submit" tap that triggers a headless submission of a form the user has reviewed. The human confirmation is the compliance and quality gate.

Tier 4, human-in-the-loop fallback: for Workday-style multi-page portals with logins and assessments, the agent sends the user the link plus a "cheat sheet" message containing every answer they'll need, pre-written. Even this saves the user 80% of the effort and never breaks.

**Design rules for the apply agent.** Never guess answers to legally or materially significant questions (work authorization, criminal history, salary, notice period) — always ask the user. Log every submitted application with a snapshot of exactly what was sent, so the user can review it before an interview. Rate-limit applications per user per day (quality over volume also improves response rates, which is your real success metric).

---

## 3. Hard Problem #2 — Job Sourcing (Scraping Legality & Reliability)

**Why it's hard.** Scraping LinkedIn or Naukri at scale gets IP ranges banned quickly and carries legal risk — LinkedIn in particular has a long litigation history against scrapers. Scraped pipelines are also operationally fragile: layout changes silently break parsers, and stale or duplicate listings destroy user trust in your 75% threshold.

**The solution: an API-first sourcing stack, with scraping only as a last resort for public, non-login pages.**

Primary sources: aggregator APIs — Adzuna (has an India feed), Jooble, JSearch (RapidAPI, aggregates Google Jobs results), and Careerjet. These give you legal, structured, deduplicated volume on day one.

Secondary sources: direct ATS job-board feeds. Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co/v0/postings`), Ashby, and SmartRecruiters all expose public JSON feeds per company. Build a registry of companies your users care about and poll their feeds — this data is fresher than any aggregator and completely safe to use.

Tertiary sources: Google Jobs structured data (JobPosting schema.org markup) on company career pages, and RSS feeds where offered.

For India specifically: Naukri and Indeed dominate over LinkedIn for a huge share of roles, especially non-tech and Tier-2 city jobs. Neither offers a friendly public API, so cover their inventory indirectly — much of it surfaces through Google Jobs and aggregators — and consider official partnership or Indeed's publisher program once you have traction. Also index startup-heavy sources like Wellfound and Cutshort feeds where accessible.

**Pipeline hygiene that protects the 75% promise.** Deduplicate aggressively (same job appears on 4+ sources; hash on company + normalized title + location). Detect staleness — expire listings after a source-appropriate TTL and re-verify a posting is still live immediately before sending it to a user. Normalize salary data (annual vs monthly, LPA vs USD) since salary mismatch is the top cause of wasted applications. Track per-source quality metrics (user Interested-rate by source) and downweight sources that produce dead or misleading listings.

---

## 4. Hard Problem #3 — WhatsApp Business API Constraints

**Why it's hard.** WhatsApp is not a free push channel. Business-initiated messages require pre-approved message templates, are billed per conversation by category, and the whole account lives under a quality rating — if too many users block or report you, Meta throttles your messaging tier or bans the number. Getting this wrong doesn't degrade the product; it kills it.


**The solution: design the messaging model around Meta's rules from day one.**

Opt-in and the 24-hour window: any user-initiated message opens a 24-hour "service window" during which you can send free-form messages freely. Outside that window, you can only send approved templates. Design flows to keep conversations user-initiated where possible — e.g., the weekly digest template ends with a button that, when tapped, reopens the service window for a full interactive session.

Templates you'll need approved before launch: new-job-match alert (utility category), application status update (utility), weekly digest (utility), payment link / renewal reminder (utility), and re-engagement for dormant users (marketing category — use sparingly, marketing templates are priced higher and drive blocks). Write templates with variables so one template covers all jobs.

Cost model: in India, business-initiated conversations run roughly ₹0.30–0.80 depending on category, and user-initiated service conversations are cheaper or free within limits. Model this per user: a user receiving ~10 match alerts + 4 digests per month costs you a predictable amount — build it into pricing. (Verify current Meta rate card before finalizing pricing; it changes.)

Quality-rating protection: the 75% threshold is your best defense — low-relevance pings are what get you blocked. Add a per-user frequency cap (e.g., max 2 match messages/day, batch the rest into the digest), an easy in-chat "pause alerts" and "unsubscribe" command honored instantly, and monitoring on your quality rating via the WhatsApp Business Management API with alerts if it drops from High.

Infrastructure choice: start with Meta's WhatsApp Cloud API directly (no BSP margin, good docs). Move to a BSP like Gupshup, Twilio, or WATI later only if you need their tooling. One number per environment; get the business verified early since verification unlocks higher messaging tiers.

---

## 5. Hard Problem #4 — Payment Placement & Conversion

**Why it's hard.** The original flow charges after resume upload but before the user has seen a single job. Cold users won't pay for an unproven matcher, and WhatsApp funnels are especially unforgiving — a paywall before value means most users silently disappear.

**The solution: free value first, paywall the actions.**

The free tier shows the first 3–5 matches with full explained fit scores. The user sees exactly what they'd be paying for. The paywall triggers at the first Interested or Inquire tap — the moment of highest intent.

Pricing models to test (in rough order of promise for India):

A weekly plan (e.g., ₹99–199/week) matches job-search psychology — searches are intense and short-lived, and weekly feels lower-commitment than monthly while often yielding higher effective revenue. A monthly plan (₹299–499) suits longer searches. A per-application pack (e.g., 10 assisted applies for ₹149) suits skeptics and gives a natural upsell path to the subscription. A success-fee model ("pay when you get interviews") is the strongest trust signal but hardest to verify and enforce — consider it later, not at launch.

Premium add-ons with real willingness-to-pay: per-job tailored resume generation, cover letters, and the inquiry agent as an unlimited feature.

Payment mechanics: Razorpay payment links sent in chat work today with minimal integration; UPI intent links make it one-tap for most Indian users. Handle payment webhooks to unlock features instantly and confirm in chat within seconds — any delay between paying and unlocking feels like fraud on WhatsApp.

Churn design: when a subscription lapses, don't go silent — downgrade gracefully to the free tier (matches keep arriving, actions locked) so re-activation is one tap away.

---

## 6. All Product Improvements, Integrated

**Explained fit scores.** Never send a bare "82% match." Send: "82% — Strong: React (4 yrs, they want 3+), fintech background. Gap: they list AWS, your profile shows GCP." Generated by the scoring LLM in the same call that produces the score. This builds trust in the number, teaches users what to fix in their profile, and dramatically improves the quality of their Interested/Not decisions.

**Feedback-driven scoring.** Every Not Interested reason, every Interested tap, and every application outcome feeds a per-user preference layer on top of the base matcher. Concretely: hard filters get updated (user rejected 3 Bengaluru-onsite roles → ask if they want onsite excluded), and soft preferences reweight the score. Within two weeks the 75% threshold means something personal, not generic.

**Structured profile as the single source of truth.** The parsed resume + intake answers + learned preferences live as one profile object. Every agent (scorer, inquiry, apply, resume-tailor) reads from it. The user can update it anytime in chat ("my notice period is now 30 days") and the bot confirms the field change.

**Per-job resume tailoring.** For each application, generate a resume variant that reorders and rephrases (never fabricates) the user's real experience to mirror the job description's language — this measurably improves ATS keyword screening and recruiter response rates, and it's your strongest premium feature. Always show the user the tailored version before submission and keep an immutable copy of what was sent.

**Custom-question relay.** When the apply agent encounters a question it can't answer from the profile, it relays it in WhatsApp: "This role asks: 'Describe a project where you led a team.' Reply here and I'll include it (or tap Skip to answer it yourself later)." The answer gets saved to the profile so it's never asked twice.

**Application tracker and weekly digest.** Every application has a status (Prepared → Submitted → Viewed → Response → Interview → Closed). The weekly digest is the retention heartbeat: applications sent, detectable engagement, new matches waiting, and one profile-improvement tip. Status detection sources: user-granted email parsing (label-based Gmail access is the practical route), ATS APIs where available, and simple "any update?" check-ins the user can answer with one tap.

**Inquiry agent guardrails.** It answers only from the job description, the company's public pages, and recent news — with the source cited in-message. If the data doesn't contain the answer, it says "That's not in the posting — want me to include this as a question in your application?" Never invents salary figures or interview processes.

**India-specific tuning.** Prioritize Naukri/Indeed-covered inventory via aggregators; normalize salaries in LPA; support notice-period as a first-class matching field (it's a primary filter for Indian recruiters); handle bilingual interaction (English + Hindi/regional at minimum for intake flows); and expect resume formats that include photos and personal details — strip these appropriately for roles/regions where they're discouraged.

---

## 7. System Architecture

**Channel layer:** WhatsApp Cloud API webhooks → a thin gateway service that normalizes inbound events (text, button taps, media, list selections) into an internal message bus.

**Conversation orchestrator:** a state machine per user (onboarding → intake → active → paywalled → subscribed) that decides which agent handles each inbound event. Keep conversation state in Postgres/Redis, not in the LLM's context — WhatsApp sessions are long-lived and fragmented.

**Agent services:** resume parser (LLM, produces structured profile JSON), matcher/scorer (embedding retrieval to shortlist + LLM scoring pass that outputs score + explanation JSON), inquiry agent (RAG over job posting + company data), apply agent (tier router: email / ATS API / pre-fill / cheat-sheet), and resume tailor.

**Ingestion pipeline:** scheduled workers (Celery or BullMQ) pull from aggregator APIs and ATS feeds → normalize → dedupe → embed → store in Postgres + a vector index (pgvector is enough at this scale). A separate freshness worker re-verifies listings before any user notification.

**Matching job:** runs per-user on new-listing events and on profile changes; anything scoring ≥75% after hard filters enqueues a notification, subject to the per-user frequency cap and batching rules.

**Payments:** Razorpay webhooks → entitlement service → orchestrator unlocks features and confirms in chat.

**Observability you actually need from day one:** per-source listing quality, match-score distribution vs user Interested-rate (calibration of your 75%), WhatsApp quality rating, template delivery/read rates, apply success rate per tier, and time-from-match-to-action.

---

## 8. Compliance & Trust Checklist

Consent and data: resumes are sensitive personal data. Under India's DPDP Act you need clear consent at upload, a stated purpose, deletion on request ("delete my data" as a chat command), and no sharing with employers beyond the application itself. Store resumes encrypted; log every place a user's data was sent.

Acting on the user's behalf: the one-tap confirmation before every submission is your legal and ethical anchor — the user authorizes each application individually. Keep the audit trail.

Truthfulness: the resume tailor and question-relay must never fabricate experience, and this should be an explicit, tested constraint, not a hope.

Platform terms: no credential storage for job boards at launch (avoid the "give us your Naukri password" pattern — it's a ToS violation and a security liability). If you later add it, use it only for user-reviewed, user-triggered submissions.

---

## 9. Unit Economics Sketch (India)

| Cost item | Rough estimate per active user / month |
|---|---|
| WhatsApp utility conversations (2–3 alerts/day, batched) | ₹25–60 |
| LLM calls (parsing, scoring, inquiry, tailoring) | ₹15–40 |
| Job aggregator API costs (amortized) | ₹5–15 |
| Infra: server, DB, storage (amortized) | ₹5–10 |
| **Total cost to serve** | **~₹50–125** |

Implications: pricing below ₹99/month is structurally difficult. A weekly pass at ₹99–149 (matches the naturally time-boxed "active job hunt" mindset) or a monthly plan at ₹249–349 with tailored resumes as the premium hook leaves healthy margin. Free-tier users must be capped (e.g., 3 matches/week, view-only) or they burn WhatsApp conversation fees with zero revenue. The biggest cost levers are batching alerts into digests (one conversation instead of three) and caching job scores so a job scored once is reused across every user it matches.

---

## 10. MVP Roadmap

**Phase 1 (weeks 1–4) — Match & Notify.** WhatsApp onboarding, resume parsing, structured intake, aggregator + ATS-feed ingestion, scoring with explained fit, job cards with the three buttons, inquiry agent, free tier. No payments, no apply. Goal: prove users say Interested to what you send (target: >30% of sent jobs get a tap, <2% block rate).

**Phase 2 (weeks 5–8) — Monetize & Assisted Apply.** Razorpay paywall at first action, Tier 1 (email) and Tier 2 (Greenhouse/Lever API) applies, tailored resumes, custom-question relay, application tracker, weekly digest.

**Phase 3 (weeks 9+) — Depth.** Tier 3 pre-fill applies, email-based status detection, feedback-driven score personalization, regional language support, per-application packs, and source expansion.

Kill criteria worth writing down now: if Phase 1 users don't act on matches at meaningful rates, the problem is sourcing/scoring quality — fix that before building any apply automation, because applying to badly matched jobs at scale helps no one.

---

## 11. Biggest Risks, Ranked

1. Match quality below the trust bar → users block the number → Meta quality rating drops → channel dies. Mitigation: the 75% threshold, explained scores, frequency caps, feedback loop.
2. Apply automation breaking or misfiring (wrong answers submitted) → user harm and refunds. Mitigation: tiered apply, mandatory user confirmation, no-guess rules, audit snapshots.
3. Source instability or legal challenge → inventory dries up. Mitigation: API-first sourcing, multi-source redundancy, no login-wall scraping.
4. Unit economics: WhatsApp conversation fees + LLM costs per user must stay well under weekly-plan revenue. Mitigation: batch alerts into digests, cache scoring for identical jobs across users, cheaper models for parsing/routing and stronger models only for tailoring and inquiry.

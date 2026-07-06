# WhatsApp Job Agent — Enterprise-Grade Build Guide

This document takes the product blueprint and answers one question: how do you build it so it survives 100,000+ users, enterprise customers, audits, outages, and a growing engineering team — instead of collapsing the way MVP codebases usually do.

"Enterprise level" means five concrete properties: it scales horizontally, it fails gracefully, it's secure and auditable, it's observable, and it can be operated and extended by a team rather than one founder. Everything below is organized around those five properties.

---

## 1. Reference Architecture

The system splits into six planes. Each is independently deployable and independently scalable, because their load profiles are completely different — message traffic is bursty and latency-sensitive, ingestion is batchy and throughput-bound, and LLM work is expensive and queue-friendly.

**Edge / Channel plane.** Meta Cloud API webhooks land on a stateless webhook gateway (behind a load balancer, 2+ replicas, autoscaled). Its only jobs: verify the Meta signature (X-Hub-Signature-256), acknowledge within Meta's timeout (respond 200 in <5s or Meta retries and eventually disables your webhook), and drop the raw event onto a message queue. It does zero business logic. This is the single most important enterprise pattern in the whole system: never process webhooks synchronously.

**Messaging plane.** An outbound sender service owns all communication back to WhatsApp. It handles template selection, per-user frequency caps, the 24-hour window logic (free-form vs template), rate limiting against your Meta messaging tier, retry with exponential backoff on transient errors, and dead-lettering of permanently failed sends. Centralizing outbound in one service means window/billing logic exists in exactly one place — the alternative (every service sending its own messages) is how companies accidentally burn their quality rating.

**Orchestration plane.** A conversation orchestrator holds a per-user finite state machine (onboarding → intake → active_free → paywalled → subscribed → dormant) persisted in Postgres, with hot session state in Redis. It consumes normalized inbound events from the queue and routes them: button taps to the right handler, free text to intent classification, media to the resume pipeline. State lives in the database, never in process memory and never solely in LLM context — pods must be killable at any moment with zero data loss.

**Agent plane.** Each agent is a stateless worker service consuming from its own queue: resume parser, matcher/scorer, inquiry agent, apply agent, resume tailor. They read the user profile from the profile service, call the LLM gateway, and emit results as events. Because they're queue-driven and stateless, scaling any one of them is just adding consumers.

**Data & ingestion plane.** Scheduled ingestion workers pull from aggregator APIs and ATS feeds, then push raw postings through a normalization pipeline: dedupe (hash on company + normalized title + location), enrich, embed, and upsert into Postgres + pgvector. A freshness worker re-verifies any posting immediately before it's sent to a user. Ingestion runs on its own infrastructure so a scraping burst can never degrade chat latency.

**Platform plane.** Cross-cutting services: identity/entitlements (who paid for what), payments (Razorpay webhooks → entitlement events), audit log service (append-only), notification scheduler (digests, alert batching), and the LLM gateway described below.

**Event backbone.** All planes communicate through a broker. Start with Redis Streams or RabbitMQ; adopt Kafka when you need replay, multiple consumer groups per event type, and event-sourced analytics — typically past ~50k users. Define events with schemas (Protobuf or JSON Schema, versioned) from day one: `resume.uploaded`, `profile.updated`, `job.ingested`, `match.created`, `user.responded`, `application.submitted`, `payment.completed`. A schema'd event backbone is what lets you add new consumers (analytics, fraud detection, a recruiter-side product later) without touching existing services.

---

## 2. The LLM Gateway (treat AI as infrastructure, not a library call)

Every LLM call in the system goes through one internal gateway service. This is non-negotiable at enterprise scale because it's where you enforce:

Cost controls — per-user and per-tenant token budgets, model routing (cheap fast model for intent classification and resume field extraction; stronger model for scoring explanations, tailoring, and inquiry), and response caching (identical job scored against identical profile version = cache hit; job descriptions embedded once, not per user).

Reliability — provider failover (primary + secondary LLM provider with automatic switchover), timeouts, circuit breakers, and graceful degradation (if the scorer is down, queue the jobs; never drop them, never block chat).

Safety and quality — centralized prompt versioning (prompts are deployed artifacts with versions and rollbacks, not strings in code), output schema validation (every agent returns JSON validated against a schema; invalid output triggers one structured retry, then dead-letters for review), PII redaction rules for what may leave your boundary, and prompt-injection defenses for the inquiry agent (job descriptions are untrusted input — treat text from scraped postings as data, never as instructions).

Evaluation — log every prompt/response pair (with PII handling), maintain golden datasets (e.g., 500 resume+job pairs with human-labeled fit scores), and run regression evals on every prompt or model change. Track score calibration in production: the fraction of ≥75% matches that users mark Interested is your single most important quality metric, per cohort, per week.

---

## 3. Data Architecture

**Postgres is the system of record** — users, profiles, jobs, matches, applications, payments, conversation state. Use row-level tenant isolation from day one (see multi-tenancy below). Add pgvector for embeddings; you will not need a dedicated vector database until well past 1M active postings.

**Redis** — hot session state, rate-limit counters, dedupe caches, distributed locks (e.g., "only one apply job per application").

**Object storage (S3/GCS)** — resumes and generated documents, encrypted, with strict lifecycle policies and no public access, ever. Store a content hash and virus-scan result for every upload.

**Warehouse (BigQuery/ClickHouse/Redshift)** — the event stream lands here for analytics: funnel conversion, match calibration, per-source job quality, LTV/CAC. Product decisions come from the warehouse, not from production queries.

**Immutable audit store** — append-only records of every application submitted (exact payload sent, tailored resume version, user confirmation timestamp, template of consent shown). This is both your legal defense and your customer-trust feature ("see exactly what we sent").

Data modeling rules that save you later: profiles are versioned (a match references the profile version it was scored against); jobs are never hard-deleted, only expired; every user-facing decision (score, filter rejection) stores its inputs so any match can be explained retroactively.

---

## 4. Multi-Tenancy and the Enterprise Product Line

"Enterprise" is also a business model. The same platform supports three tiers, and designing tenancy now is 10× cheaper than retrofitting it:

B2C — individual job seekers on WhatsApp (your current plan).

B2B2C — colleges/placement cells, staffing agencies, and upskilling platforms buy seats for their candidates, get a dashboard (placement rates, application funnels per student), custom branding on messages, and bulk onboarding. This segment has real budgets in India and is your fastest path to enterprise revenue.

API/white-label — job boards or ed-tech companies embed your matching + assisted-apply engine under their own WhatsApp number.

Implementation: every table carries `tenant_id`; enforce with Postgres row-level security. Each tenant can have its own WABA (WhatsApp Business Account) and phone number — you must support multiple WABAs anyway to isolate quality ratings (a B2C spam problem must never take down a university client's number). Entitlements, rate limits, template sets, and LLM budgets are all per-tenant configuration, not code.

---

## 5. Security & Compliance (the actual enterprise checklist)

**Regulatory baseline for India:** DPDP Act 2023 compliance — explicit consent at collection with stated purpose, a consent record per user, data-principal rights implemented as real features (in-chat "download my data" and "delete my data" commands with SLA'd fulfillment), breach notification procedures, and a designated grievance officer once you're at scale. Resumes are personal data; treat contact info, salary, and any inferred attributes as sensitive.

**Security program (what enterprise buyers will ask for):**
Encryption in transit (TLS 1.2+ everywhere, including internal service-to-service via mTLS or a service mesh) and at rest (KMS-managed keys; envelope encryption for resume storage). Secrets in a vault (AWS Secrets Manager / HashiCorp Vault), never in env files in repos, with rotation. SSO + MFA for all internal tools; RBAC on the admin dashboard with least privilege; no production database access without an audited break-glass procedure. Dependency scanning, container image scanning, and SAST in CI. Annual penetration test once you have B2B customers. SOC 2 Type II is the certification B2B2C clients will eventually demand — start logging and access-controlling as if you're already in audit scope, because retrofitting evidence collection is miserable.

**AI-specific governance:** documented no-guess rules for the apply agent (work authorization, salary, notice period, background questions always relayed to the human), a tested "never fabricate experience" constraint on the tailor with automated checks (generated resume claims must be traceable to profile facts), human-review queues for low-confidence agent outputs, and an incident category for "agent submitted something wrong" with a defined remediation runbook (notify user, offer correction/withdrawal, root-cause the prompt).

**Platform compliance:** Meta Business Verification, correct template categorization (misclassified marketing-as-utility gets templates paused), display-name and commerce-policy compliance, and per-tenant quality-rating monitoring with automated send-throttling if a rating drops.

---

## 6. Reliability Engineering

Set explicit SLOs and build to them: webhook acknowledgment p99 < 2s; inbound message → bot reply p95 < 5s for scripted flows, < 15s for LLM flows; job match delivered within 6 hours of posting ingestion; 99.9% monthly availability for the messaging path.

Patterns that get you there: every consumer is idempotent (Meta redelivers webhooks; your queue redelivers on crash — process-exactly-once is achieved via idempotency keys, not hope). Outbox pattern for anything that must atomically "update DB + emit event." Dead-letter queues on every consumer with alerting and a replay tool. Circuit breakers around every external dependency (Meta API, LLM providers, aggregator APIs, Razorpay) with defined degraded modes: if job ingestion dies, chat still works; if LLMs die, scripted flows still work and LLM tasks queue; if Meta is down, everything queues and drains on recovery.

Deployment: containerized services on Kubernetes (EKS/GKE) or, honestly, ECS/Cloud Run until you have a platform engineer — Kubernetes is not a requirement for enterprise-grade, operational discipline is. Blue-green or canary deploys, automated rollback on SLO burn, infrastructure as code (Terraform) from the first environment, and separate dev/staging/prod with staging wired to Meta's test number.

Disaster recovery: automated Postgres backups with tested restores (an untested backup is a rumor), point-in-time recovery, RPO ≤ 15 minutes / RTO ≤ 4 hours as initial targets, and a documented runbook for the two scariest scenarios — losing a WhatsApp number (mitigation: multiple WABAs, user phone numbers stored so you can migrate them to a new number with an announced template) and a bad agent deployment mass-sending wrong content (mitigation: kill switch on the outbound sender, per-minute send anomaly alerts).

---

## 7. Observability

Three pillars, wired from the first deploy: structured logs (JSON, correlation ID propagated from webhook receipt through every queue hop to the outbound send — being able to trace one user message end-to-end is the difference between 10-minute and 10-hour debugging), metrics (RED metrics per service, queue depths and consumer lag, Meta API error rates by code, LLM latency/cost/token usage per agent per model), and distributed traces (OpenTelemetry).

Business-level monitors that page a human: quality rating drop on any WABA, template rejection, block-rate spike, match→Interested rate falling below threshold (your product is silently degrading), payment webhook failures, DLQ growth, and LLM spend per hour exceeding budget.

---

## 8. Team & Delivery Model

A realistic enterprise-grade team at this stage: 1 backend/platform lead (event backbone, messaging plane, reliability), 1–2 product engineers (orchestrator, flows, dashboard), 1 AI engineer (agents, evals, LLM gateway), 1 data/ingestion engineer (sources, pipeline quality), 0.5 DevOps/SRE (IaC, CI/CD, monitoring — often the platform lead early on), and a part-time compliance/ops function. That's 4–6 people; enterprise-grade is achievable at this size **if** the architecture stays boring: monorepo, few services (the six planes can start as ~4 deployables), one database, one queue technology.

Delivery discipline: trunk-based development, CI running tests + security scans + LLM regression evals, feature flags for every user-facing change (per-tenant rollout), and a weekly review of the calibration and quality dashboards as a standing ritual — in an AI product, model drift is a production incident that no exception tracker will catch.

---

## 9. Cost Model at Scale (orders of magnitude)

Per active user per month, expect three dominant variable costs: WhatsApp template messages outside free windows (minimized by the batching/window strategy — design target: <10 paid templates/user/month), LLM inference (design target: parsing once, scoring cached across users for the same job, cheap models for routing — achievable at low double-digit ₹ per active user), and infrastructure (largely fixed until ~100k users; a well-built version of this runs on a few thousand dollars/month of cloud at 50k MAU).

The enterprise levers: per-tenant LLM budgets, scoring cache hit rate (same job × many similar profiles), and pushing users toward user-initiated interactions (free service windows). Instrument cost per user per week from day one — unit economics is an engineering metric here, not a finance afterthought.

---

## 10. Build Order (enterprise-hardening roadmap)

**Stage 1 — Solid core (months 1–2).** Webhook gateway + queue + orchestrator + outbound sender as separate deployables; Postgres with tenant_id and RLS; audit log; IaC; CI/CD; structured logging with correlation IDs; Meta test number wired to staging. Ship the Phase-1 product (match & notify) on this foundation.

**Stage 2 — AI infrastructure (months 2–4).** LLM gateway with routing, caching, schema validation, and eval harness; golden datasets; calibration dashboard; prompt versioning. Ship assisted apply Tiers 1–2 and payments.

**Stage 3 — Enterprise readiness (months 4–7).** Multi-WABA support; B2B2C tenant dashboard; SSO/RBAC on internal tools; DPDP data-rights features; DR drills; SLO alerting; pen test. Sign the first placement-cell / staffing-agency pilot.

**Stage 4 — Scale (months 7+).** Kafka if event volume demands it; warehouse-driven personalization; white-label API; SOC 2 audit; regional language flows; dedicated apply-tier expansion.

The through-line: enterprise-grade is 20% architecture and 80% discipline — idempotency, schemas, audit trails, evals, and runbooks. None of it requires exotic technology; all of it requires deciding on day one that the system will be operated, audited, and handed to teammates.

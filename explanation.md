# AI Revenue Recovery — Complete Project Explanation

> A full, end-to-end walkthrough of what this system does, how it works, why it was built this way, and every component involved.

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [The Solution](#2-the-solution)
3. [System Architecture](#3-system-architecture)
4. [Tech Stack](#4-tech-stack)
5. [How the Pipeline Works (End to End)](#5-how-the-pipeline-works-end-to-end)
6. [Service by Service Breakdown](#6-service-by-service-breakdown)
7. [Where AI (LLM) Is Used](#7-where-ai-llm-is-used)
8. [Where Deterministic Code Handles Everything](#8-where-deterministic-code-handles-everything)
9. [The Compliance / Guardrail Layer](#9-the-compliance--guardrail-layer)
10. [The Promise-to-Pay State Machine](#10-the-promise-to-pay-state-machine)
11. [The Hinglish Negotiation Channel](#11-the-hinglish-negotiation-channel)
12. [The Dashboard](#12-the-dashboard)
13. [Synthetic Data & Batch Report](#13-synthetic-data--batch-report)
14. [How to Run Everything](#14-how-to-run-everything)
15. [Design Decisions & Trade-offs](#15-design-decisions--trade-offs)

---

## 1. The Problem

Razorpay merchants lose revenue across **four disconnected leak points**:

| Leak Point | What Happens | Why It's Hard |
|---|---|---|
| **Payment failure** | Card/UPI/netbanking transaction fails silently | Error codes are noisy (bank decline, insufficient funds, 3DS timeout, wrong OTP, risk block) — most merchants don't know what to do |
| **Checkout abandonment** | User adds to cart, starts checkout, drops off before paying | No retry mechanism exists by default — needs session state, not just payment state |
| **Subscription/mandate failure** | UPI Autopay or e-mandate recurring debit fails | RBI's e-mandate framework (AFA, 24-hr pre-debit notice, ₹15,000 threshold) makes blind retries **non-compliant** |
| **Overdue B2B receivables** | An invoice/payment link goes unpaid past due date | This is a people problem — escalation must stay professional, rate-limited, and compliant |

Today each leak is handled by a different, disconnected tool — or nothing at all.

**The insight:** AI can close the loop from detecting the problem to diagnosing it, choosing the right intervention, and recovering the money — but only if you put deterministic guardrails around the AI so it can't move money it shouldn't.

---

## 2. The Solution

An **AI-powered revenue recovery agent** that:

1. **Detects** payment failures from Razorpay webhooks
2. **Classifies** root causes using a rules engine (fast, deterministic) with LLM fallback (for ambiguous cases)
3. **Decides** compliant recovery actions through a deterministic policy layer (8 named rules)
4. **Executes** authorized actions (payment retries, payment links, reminders, negotiations)
5. **Tracks** promise-to-pay agreements through a state machine
6. **Reports** honest recovery metrics with a full audit trail

**The core principle: "The LLM proposes, a deterministic policy layer disposes."**

The AI generates text and structured guesses. Code validates everything before any action is taken. This is the single biggest differentiator from a naive "let ChatGPT do everything" approach.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  1. SIGNAL INGESTION LAYER                                        │
│  Razorpay test-mode webhooks → Postgres + Redis Stream           │
│  Go · chi · HMAC-SHA256 verification · idempotent persistence   │
└───────────────────────────────┬───────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. DETECTION & CLASSIFICATION LAYER                               │
│  Rules engine (Go, substring matchers) handles ~80%             │
│  LLM fallback (TypeScript, Groq API) for ambiguous cases        │
│  Closed enum enforcement — invalid categories coerced to unknown│
└───────────────────────────────┬───────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. DECISION / POLICY LAYER  ("the agent's brain")                │
│  8 pure, testable policy functions — no DB access               │
│  Hard kill-switches first, then soft rules                      │
│  Every decision produces a verbatim DecisionTrace (audit trail) │
│  Actions: RETRY_PAYMENT | SEND_PAYMENT_LINK | SEND_REMINDER |  │
│           ESCALATE_TO_HUMAN | LOG_PROMISE_TO_PAY | STOP_SEQUENCE│
└───────────────────────────────┬───────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. EXECUTION LAYER (channel adapters)                             │
│  TypeScript · Express · zod re-validation                       │
│  Razorpay stub (deterministic per-order success via FNV-1a)    │
│  SMS / Email / WhatsApp / Voice adapters (stubs that log sends) │
│  Hinglish negotiation channel (multi-turn LLM conversation)     │
└───────────────────────────────┬───────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. LEDGER, STOPPING RULES & AUDIT LAYER                          │
│  Immutable event ledger: events → classifications → decisions → │
│  actions (one row per layer per event)                           │
│  Promise-to-pay state machine with escalation ceiling           │
│  Next.js dashboard: ₹ counter, funnel, feed, audit, promises    │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
events → classifications → decisions → actions
  ↑          ↑                ↑           ↑
  |          |                |           |
Ingest    Classify         Decide      Execute
(Go)      (Go+TS)         (Go)        (TS)
```

Every layer writes **exactly one row** per event. The chain is the audit trail — queryable, filterable, and visible in the dashboard.

---

## 4. Tech Stack

| Component | Technology | Why |
|---|---|---|
| **Ingestion** | Go + chi | Correctness-critical: HMAC verification, idempotent persistence |
| **Decision Engine** | Go | Policy layer must be deterministic, testable, auditable |
| **Execution** | TypeScript + Express | LLM integration, Razorpay SDK, fast iteration |
| **LLM Orchestrator** | TypeScript | OpenAI-compatible SDK pointing at Groq's free tier |
| **Dashboard** | Next.js + recharts | Fast to build, reads directly from Postgres |
| **Database** | PostgreSQL 16 | Event ledger, classifications, decisions, actions, promises |
| **Queue** | Redis 7 | Redis Streams for at-least-once event delivery between services |
| **LLM** | Groq (free tier) | Free, no credit card, OpenAI-compatible API at `api.groq.com` |
| **Model** | `openai/gpt-oss-120b` | Reasoning model for classification, drafting, negotiation |
| **Payments** | Razorpay test-mode | Real API calls with deterministic stub for success/failure |
| **Migrations** | Goose + docker-init SQL | Schema auto-applied on first container start |

### Why Go + TypeScript?

**Go** handles layers where correctness is non-negotiable:
- Webhook ingestion (HMAC verification — wrong = security hole)
- Classification (closed-enum enforcement — wrong = corrupted decisions)
- Policy layer (guardrails — wrong = agent moves money it shouldn't)

**TypeScript** handles layers where iteration speed and LLM integration matter:
- Execution adapters (Razorpay SDK, channel adapters)
- Message drafting (LLM-powered copy generation)
- Negotiation conversations (multi-turn Hinglish)
- Dashboard (Next.js, recharts)

The boundary is clean: **Go decides, TypeScript executes.**

---

## 5. How the Pipeline Works (End to End)

### Step 1: Webhook Arrives

Razorpay sends a webhook when a payment fails:

```
POST /webhook/razorpay
Headers: X-Razorpay-Signature: <hmac-sha256>
Body: {"event":"payment.failed","payload":{"payment":{"entity":{...}}}}
```

The **Ingestion Service** (Go):
1. Reads the raw body as bytes
2. Verifies HMAC-SHA256 signature against `RAZORPAY_WEBHOOK_SECRET`
3. Checks idempotency (deduplicates on `X-Razorpay-Event-Id`)
4. Parses the payload, extracts `event_type`, `order_id`, `customer_id`, `amount_paise`
5. Inserts one row into `events` table
6. Publishes event ID to Redis Stream (`new_events`)

**Result:** One verified, deduplicated event in the database.

### Step 2: Classification

The **Decision Engine** (Go) consumes from Redis and classifies each event:

1. **Rules engine** (`internal/classifier/rules.go`) — substring matching on the signal text:
   - `"insufficient"` → `insufficient_funds`
   - `"expired"` → `expired_card`
   - `"mandate"` + `"revoked"` → `mandate_revoked`
   - ... (9 categories total)

2. **LLM fallback** — only when NO rule matches (ambiguous cases):
   - Calls `llm-orchestrator`'s `/classify` endpoint
   - Groq API reads the event and picks from the closed enum
   - Output validated against zod schema + enum before storage

3. **Priority scoring** — `amount_paise/100 × recoverability_weight[category]`
   - Higher-value, more-recoverable events get processed first

**Result:** One row in `classifications` — category, narrative, priority score, classified_by.

### Step 3: Decision (The Guardrail Layer)

The **Policy Layer** (`internal/policy/decide.go`) runs **8 named checks** in order:

| Order | Check | What It Does | Effect |
|---|---|---|---|
| 1 | `IsMandateRevoked` | Has the customer revoked their UPI mandate? | → `STOP_SEQUENCE` (never retry) |
| 2 | `HasExceededEscalationCeiling` | Cross-channel escalation exhausted (5+)? | → `STOP_SEQUENCE` |
| 3 | `HasExceededMaxAttempts` | Retry cap hit (3 attempts)? | → `ESCALATE_TO_HUMAN` |
| 4 | `IsWithinCooldown` | Must wait for exponential backoff window? | → Block (wait) |
| 5 | `IsBelowAFAThreshold` | Recurring charge ≥ ₹15,000? | `RETRY_PAYMENT` → **transforms** to `SEND_PAYMENT_LINK` |
| 6 | `IsWithinPreDebitWindow` | Auto-debit within 24h of customer notification? | → Block (RBI rule) |
| 7 | `IsOptedOut` | Customer opted out of this channel? | → Block, try lower-friction channel |
| 8 | `IsOutsideQuietHours` | Contacting outside 9am–7pm? | → Block (`SEND_REMINDER` only) |

**Key behaviors:**
- Above ₹15,000, a retry doesn't just get blocked — it **transforms** into a payment link (preserving recovery while restoring compliance)
- Quiet hours block `SEND_REMINDER` (proactive nudge) but NOT `SEND_PAYMENT_LINK` (response to a just-failed payment)
- Every decision produces a `DecisionTrace` — the full reasoning chain stored verbatim in `decisions.reasoning`

**Result:** One row in `decisions` — action, blocked (bool), block_reason, reasoning trace.

### Step 4: Execution

The **Execution Service** (TypeScript) receives authorized actions:

1. **Re-validates** independently (zod schema) — catches drift between Go and TS
2. **Routes by action type:**
   - `RETRY_PAYMENT` → Razorpay stub (deterministic success via FNV-1a hash)
   - `SEND_PAYMENT_LINK` → Razorpay stub creates link
   - `SEND_REMINDER` → LLM Orchestrator's `/draft` generates message copy → channel adapter stub logs the send
   - `ESCALATE_TO_HUMAN` → Pending human todo
   - `LOG_PROMISE_TO_PAY` → Registers promise in Decision Engine's state machine
   - `STOP_SEQUENCE` → Terminal marker
3. **Writes one `actions` row** with status, amount_recovered_paise, outcome_payload

**Result:** One row in `actions` — status, recovered amount, outcome details.

### Step 5: Promise Tracking (for B2B Receivables)

When `LOG_PROMISE_TO_PAY` is triggered, the **Promise State Machine** (`internal/statemachine`) manages the lifecycle:

```
notified → awaiting_response → promised → due → kept
                │ (timeout)                 └→ broken → re_escalated → (loop)
                └→ re_escalated                             └→ written_off
```

- **Pure transitions** — `(state, trigger) → state` table, no DB access
- **Escalation ceiling** — re-runs `policy.Decide` with `escalation_count`; at 5+ escalations → `STOP_SEQUENCE` → `written_off`
- **Escalation history** — each escalation appends to `escalation_history JSONB` on the promise row

### Step 6: Dashboard & Reporting

The **Dashboard** (Next.js) queries Postgres directly and shows:

- **₹ Recovered counter** — `actions.amount_recovered_paise` + `promises WHERE state='kept'`
- **Funnel chart** — Ingested → Classified → Decided → Dispatched → Blocked
- **Live feed** — recent events with classification, decision, execution status
- **Audit log** — filterable by blocked actions, expandable reasoning traces
- **Promise tracker** — PTP state per invoice, simulate debtor response
- **Batch report** — recovery by leak type, blocked-by-compliance, rules-vs-LLM split

---

## 6. Service by Service Breakdown

### `services/ingestion` (Go)

**Purpose:** Receive Razorpay webhooks, verify signatures, persist events.

| File | What It Does |
|---|---|
| `internal/webhook/handler.go` | HTTP handler: HMAC verify → idempotent insert → Redis publish |
| `internal/db/events.go` | Postgres queries for events |
| `internal/queue/publisher.go` | Redis Stream publisher |

**Key guarantees:**
- HMAC-SHA256 verification against raw bytes (not re-serialized JSON)
- Idempotent on `X-Razorpay-Event-Id` (duplicate webhooks → 200, not error)
- One row per verified event in `events` table

### `services/decision-engine` (Go)

**Purpose:** Classify events, apply policy rules, manage promises.

| Directory | What It Does |
|---|---|
| `internal/classifier/` | Rules engine + LLM fallback for classification |
| `internal/policy/` | 8 pure guardrail functions (no DB access) |
| `internal/decider/` | Orchestrates: fetch context → run policy → persist decision |
| `internal/statemachine/` | Promise-to-pay state transitions |
| `internal/promises/` | Promise CRUD + lifecycle endpoints |
| `internal/db/` | All Postgres queries |

**Key guarantees:**
- Every event gets exactly one classification (idempotent on `classification_id`)
- Every classification gets exactly one decision (idempotent on `classification_id`)
- Policy functions are pure — testable without database
- Decision traces stored verbatim (never reconstructed)

### `services/execution` (TypeScript)

**Purpose:** Carry out authorized recovery actions.

| File | What It Does |
|---|---|
| `src/handlers/index.ts` | Routes actions to handlers, writes `actions` rows |
| `src/razorpay/client.ts` | Deterministic Razorpay stub (FNV-1a hash) |
| `src/adapters/voice.adapter.ts` | Negotiation controller |
| `src/adapters/*.ts` | SMS, Email, WhatsApp adapter stubs |

**Key guarantees:**
- Re-validates every action (zod schema) independently of Go
- Idempotent on `decision_id` (duplicate dispatch → stored result)
- `amount_recovered_paise` only on confirmed capture (honest accounting)

### `services/llm-orchestrator` (TypeScript)

**Purpose:** AI-powered classification, message drafting, and negotiation.

| Endpoint | What It Does |
|---|---|
| `POST /classify` | Classify ambiguous events (Groq API, heuristic fallback) |
| `POST /draft` | Generate root-cause-specific message copy |
| `POST /negotiate` | Multi-turn Hinglish negotiation (turn-limited) |

**Key guarantees:**
- All outputs validated against zod schemas
- Heuristic fallbacks when no API key (pipeline runs without LLM)
- Never in the authorization path — LLM proposes, code disposes

### `services/dashboard` (Next.js)

**Purpose:** Make every phase visible and demoable.

| Page | What It Shows |
|---|---|
| `/` | ₹ recovered counter, funnel chart, compliance chips |
| `/feed` | Recent events with classification + decision + execution |
| `/audit` | Filterable audit log with blocked-actions toggle |
| `/promises` | Promise state machine per invoice |
| `/report` | Batch report: recovery by leak type, compliance blocks, edge cases |
| `/negotiate` | Chat UI for Hinglish negotiation |

**Key design:** Reads directly from Postgres (shared `Pool` via `lib/db.ts`). Promise simulate actions route through Go Decision Engine to preserve single-source-of-truth.

---

## 7. Where AI (LLM) Is Used

The LLM (Groq, free tier) is called in exactly **3 places**:

### 1. Classification — `/classify` (Fallback Only)

**When:** Only when NO rules engine rule matches (~20% of events in production, 0% in synthetic batch).

**What it does:** Reads the event signal and picks from a closed enum of 9 risk categories.

**What it solves:** Ambiguous error descriptions that substring matching can't handle.

**Example:**
```
Input:  "transaction flagged by risk engine"
Rules:  No match (no keyword like "fraud" or "blocked")
LLM:    → category: "risk_block", narrative: "Bank's risk engine flagged the transaction"
```

**Safeguard:** Output validated against zod schema + closed enum. Invalid → coerced to `"unknown"`.

### 2. Message Drafting — `/draft` (Always Used)

**When:** Every time an authorized action needs customer-facing copy.

**What it does:** Generates root-cause-specific, personalized message copy.

**Without AI:** `"Hi — your recent payment didn't go through. A ₹500 payment is pending."`

**With AI:** `"Hi! Your ₹500 payment was declined as your bank shows low balance. Please add funds and retry."`

**What it solves:**
- References the *actual* root cause (not generic "payment failed")
- Adapts tone to channel (shorter for SMS, longer for email)
- Never threatening — warm, action-oriented, Indian rupee formatting

**Safeguard:** Only writes *wording*. Never decides whether to contact someone.

### 3. Negotiation — `/negotiate` (Interactive Only)

**When:** On-demand from the dashboard's Promise Tracker or Negotiation page.

**What it does:** Multi-turn Hinglish conversation to collect payment or agree on a promise date.

**Example conversation:**
```
Agent:  "Namaste! Baat ho rahi hai ₹5,000 ke pending payment ki..."
Debtor: "Haan bhai, kal tak kar dunga"
Agent:  "Theek hai! Kal ka din set ho gaya. Dhanyavaad!"
        → outcome: "promised", promisedDate: "2026-09-01"
```

**What it solves:**
- B2B receivables where a human needs convincing
- Edge cases where rules can't help (stalling, negotiating, refusing)
- Compliance-aware conversation (no threats, graceful exit)

**Safeguards:**
1. Hard turn limit (8 max) enforced in code, not by the model
2. Structured outcome validation (zod schema)
3. Never writes to database directly
4. Same policy layer checks as every other action

---

## 8. Where Deterministic Code Handles Everything

| Layer | What It Does | Why Not AI? |
|---|---|---|
| **HMAC verification** | Verifies webhook signatures | Security — must be exact |
| **Idempotency** | Deduplicates webhooks | Data integrity — can't guess |
| **Policy rules** (8 functions) | AFA threshold, quiet hours, max retries, mandate revocation | Legal compliance — must be auditable |
| **Action authorization** | Decides allow/block for each action | Money moves — must be deterministic |
| **Razorpay API calls** | Executes retries, creates links | Wrong API call = lost money |
| **State machine** | Promise lifecycle transitions | State drift = broken promises |
| **Audit trail** | Logs every decision with reasoning | Evidence — must be immutable |
| **Stop rules** | Max attempts, cooldowns, opt-out | Enforcement — not "suggestions" |

---

## 9. The Compliance / Guardrail Layer

This is the **single most differentiating piece** of the system. Eight named, testable policy functions in `services/decision-engine/internal/policy/`:

| Rule | Function | What It Enforces |
|---|---|---|
| **RBI AFA threshold** | `IsBelowAFAThreshold` | Recurring charges ≥ ₹15,000 → `SEND_PAYMENT_LINK` instead of blind retry (RBI e-mandate rule) |
| **24h pre-debit notice** | `IsWithinPreDebitWindow` | Auto-debit blocked within 24h of customer notification (RBI rule) |
| **Mandate revoked** | `IsMandateRevoked` | Immediate `STOP_SEQUENCE` — never retries a revoked mandate |
| **Max retry attempts** | `HasExceededMaxAttempts` | After 3 attempts → `ESCALATE_TO_HUMAN` |
| **Exponential cooldown** | `IsWithinCooldown` | Respects scheduled next-attempt window |
| **Quiet hours** | `IsOutsideQuietHours` | No outbound contact outside 9am–7pm (RBI Fair Practices Code) |
| **Opt-out/DND** | `IsOptedOut` | Respects channel opt-out, falls back to lower-friction channel |
| **Escalation ceiling** | `HasExceededEscalationCeiling` | After 5 escalations across all channels → `STOP_SEQUENCE` |

### Why This Matters

A judge will ask: **"What stops your agent from moving money it shouldn't?"**

The answer: Point at `internal/policy/*.go`, list the 8 functions, show the audit log filtered to blocked actions (93 out of 220), and explain that every action passes through all of them before execution. Code is auditable; prompts aren't.

---

## 10. The Promise-to-Pay State Machine

For B2B receivables (overdue invoices), a debtor saying "I'll pay by Friday" triggers a state machine:

```
notified → awaiting_response → promised → due → kept
                │ (timeout)                 └→ broken → re_escalated → (loop)
                └→ re_escalated                             └→ written_off
```

**Key design choices:**
- **Pure transitions** — `(state, trigger) → state` table, no DB access (same discipline as policy functions)
- **Reuses the policy layer** — `broken` transition calls `HasExceededEscalationCeiling` (same guardrail that stops payment retries)
- **Single source of truth** — `state` column is the only status field (no `status` + `state` drift)
- **Escalation history** — each escalation appends to `escalation_history JSONB` with `{escalation_number, triggered_at, authorized_by_rule, action, channel, reasoning}`

---

## 11. The Hinglish Negotiation Channel

The most "AI-native" feature — a multi-turn conversation where the agent speaks natural Hinglish (Hindi-English code-switching) to collect payment.

**Architecture:**
```
Dashboard → Execution Service → LLM Orchestrator (/negotiate)
                                    │
                                    ├── System prompt (Hinglish, polite, bounded)
                                    ├── Turn limit (8 max, enforced in code)
                                    └── Structured outcome (paid_now | promised | declined | escalate)
```

**What makes it special:**
- **Same principle as every other action** — LLM proposes natural language + structured outcome; code validates and routes it
- **Hard turn limit in code** — model can't talk its way around it
- **Graceful escalation** — hostile debtor → agent stays polite, ends conversation, escalates to human
- **Zero changes to Decision Engine or policy layer** — proves the Phase 4 adapter interface was designed correctly

**Tested with 5 personas:** cooperative, evasive, hostile, can't_pay, stall_then_pay

---

## 12. The Dashboard

A Next.js app at `localhost:3000` with 6 pages:

### `/` — Overview
- Big ₹ recovered counter (₹23.16L of ₹38.85L = 59.6%)
- Funnel chart: Ingested → Classified → Decided → Dispatched → Blocked
- Compliance blocks (93) and unrecoverable (13) chips

### `/feed` — Live Feed
- Table of all 220 events with classification, decision, execution status
- Shows the pipeline working end-to-end

### `/audit` — Audit Log
- Filterable table over `events → classifications → decisions → actions`
- **"Blocked actions" filter** — toggle to see exactly what compliance refused
- Expandable reasoning traces showing *why* each decision was made

### `/promises` — Promise Tracker
- State machine view per invoice (27 kept, 4 written off)
- **"Simulate debtor response" buttons** — test the lifecycle live

### `/report` — Batch Report
- Recovery by leak type (4 types)
- Blocked-by-compliance breakdown (51 × pre-debit window, 42 × quiet hours)
- Rules vs LLM split (127 vs 0)
- Honest edge cases (one success + one failure)

### `/negotiate` — Negotiation Chat
- Invoice context header (order, amount, root cause)
- Chat transcript with agent/debtor bubbles
- Quick debtor presets (Cooperative, Evasive, Hostile, Can't Pay)
- Outcome banner (Paid Now / Promise / Declined / Escalated)

---

## 13. Synthetic Data & Batch Report

### How the Batch Generator Works

`data/synthetic-batch-generator/src/generate.ts`:

1. **Generates 220 synthetic events** with realistic distributions:
   - Log-normal amount distribution (median ~₹7.3k, long tail to lakhs)
   - Weighted failure reasons (`insufficient_funds` 30%, `bank_timeout` 18%, etc.)
   - All 4 leak types present
   - ~18% deliberately unrecoverable (revoked mandates, risk blocks)

2. **Spreads timestamps across 6 days** (Aug 27 → Sep 1)
   - Makes quiet-hours blocking realistic (not all-or-nothing based on wall-clock time)

3. **Inserts directly into Postgres** with `received_at` timestamps
   - Publishes to Redis for the Decision Engine to consume

4. **The pipeline processes everything** — events flow through the real pipeline, not pre-computed results

### Final Batch Numbers

| Metric | Value |
|--------|-------|
| **Total at-risk** | ₹38,85,212 (₹3.89 crore) |
| **Total recovered** | ₹23,16,408 (₹2.32 crore) |
| **Recovery rate** | **59.6%** |
| Actions recovered | ₹20,82,887 |
| Promises recovered | ₹2,33,521 |
| Unrecoverable (STOP_SEQUENCE) | 13 |
| Blocked by compliance | 93 (51 × PRE_DEBIT_NOTICE + 42 × QUIET_HOURS) |
| Rules vs LLM | 127 vs 0 |
| Promises kept / total | 27 / 33 (81.8%) |

### Recovery by Leak Type

| Leak Type | Events | At-risk | Recovered | Blocked |
|-----------|--------|---------|-----------|---------|
| Failed payment | 129 | ₹22,84,393 | ₹14,55,623 | 60 |
| Checkout abandonment | 45 | ₹11,40,943 | ₹6,27,265 | 0 |
| Receivables (overdue) | 33 | ₹2,83,298 | ₹2,33,521 | 33 |
| Subscription / mandate | 13 | ₹1,76,578 | ₹0 | 0 |

### Why These Numbers Are Honest

- **59.6% is believable** — not near 0%, not near 100%
- **13 unrecoverable** — revoked mandates and risk blocks correctly identified as dead-ends
- **93 blocked** — compliance layer refused actions outside quiet hours or within pre-debit windows
- **₹0 for subscription/mandate** — all triggered `STOP_SEQUENCE` (no compliant automated recovery exists for revoked mandates)
- **Promises counted separately** — ₹2.33L from kept promises (debtors paid after PTP follow-up)
- **One honest failure** — ₹33K `SEND_REMINDER` blocked by `OUTSIDE_QUIET_HOURS` (system refused to contact debtor outside 9am–7pm, by design)

---

## 14. How to Run Everything

### Prerequisites
- Docker Desktop installed

### Setup
```bash
# 1. Clone and configure
git clone <repo-url>
cd ai-revenue-recovery
cp .env.example .env

# 2. Add your keys to .env:
#    RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
#    RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxx
#    RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxx
#    GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxx

# 3. Start everything
make up

# 4. Wait ~30 seconds, then check health
curl localhost:8081/health  # ingestion
curl localhost:8082/health  # decision-engine
curl localhost:8083/health  # execution
curl localhost:8084/health  # llm-orchestrator

# 5. Generate synthetic batch and run pipeline
make seed

# 6. Open dashboard
open http://localhost:3000
open http://localhost:3000/report
```

### Useful Commands
```bash
make reset-data    # Wipe pipeline data, keep schema
make seed          # Re-run the 220-event batch
make test          # Run all tests (Go + TypeScript)
make down          # Stop everything
```

### What Each Make Target Does
| Target | What It Does |
|---|---|
| `make up` | Build and start all Docker containers |
| `make up-d` | Start in background (detached) |
| `make down` | Stop and remove all containers |
| `make seed` | Generate 220 synthetic events → run through pipeline |
| `make reset-data` | TRUNCATE pipeline tables (keep schema) |
| `make reset-db` | Nuke Postgres volume, re-apply from scratch |
| `make test` | Run Go + TypeScript test suites |
| `make test-go` | Run Go policy + state machine tests |
| `make test-ts` | Run TypeScript execution handler tests |
| `make logs` | Tail logs from every service |
| `make explain EVENT_ID=<uuid>` | Print reasoning trace for an event |

---

## 15. Design Decisions & Trade-offs

### Key Decisions (from `docs/decisions.md`)

| # | Decision | Why |
|---|---|---|
| 1 | Go + TypeScript split | Go for correctness-critical layers, TS for LLM/UI-fast layers |
| 2 | Verify raw bytes, not re-serialized JSON | HMAC is byte-sensitive |
| 3 | Idempotency via separate table | Cleaner than constraint errors in logs |
| 4 | Redis Streams for queue | At-least-once, resumable, non-fatal publish |
| 5 | Classification inside Decision Engine | One fewer service, natural sequential flow |
| 6 | Closed enum enforced at boundary | Invalid LLM output → `unknown`, never corrupts decisions |
| 7 | Checkout abandonment via polling | No webhook exists for absence-based detection |
| 8 | Pure policy functions | Testable without DB, auditable, composable |
| 9 | AFA transforms retry → payment link | Preserves recovery while restoring compliance |
| 10 | Decision traces stored verbatim | Never reconstructed — exact evidence |
| 11 | Idempotent per classification | No duplicate decisions on redelivery |
| 12 | Action payload mirrors schema | Prevents drift between Go and TS |
| 13 | SEND_PAYMENT_LINK recovers only on capture | Honest accounting — links don't recover money until customer pays |
| 14 | Promise state machine in Go | Needs policy layer directly, no network hop |
| 15 | Synthetic batch posts real webhooks | Pipeline does actual work, not pre-computed results |
| 16 | Text-transcript negotiation first | Zero integration risk on demo day |
| 17 | Retrospective | Timestamps, raw_payload, promise-ledger bridge — lessons learned |

### What We'd Do Differently

1. **Build timestamp spread into the batch generator from day one** — all events firing within 12 seconds made quiet-hours blocking all-or-nothing
2. **Store the full webhook envelope as `raw_payload` from the start** — storing inner payload caused 142 events to fall through to LLM as `unknown`
3. **Add the promise-to-ledger bridge earlier** — ₹2.34L in kept promises was invisible to the recovery ledger until Phase 6 reconciliation

### What We're Most Confident About

1. **The policy layer architecture** — pure, testable, auditable guardrails
2. **The adapter interface** — Phase 7 built without touching Decision Engine or policy layer
3. **The audit trail discipline** — one row per layer per event, including blocked decisions
4. **Honest metrics** — 59.6% includes failures, not cherry-picked happy path

---

## Summary

This is a **complete, working AI revenue recovery system** that demonstrates:

- **Real engineering discipline** — idempotency at every layer, honest metrics, visible audit trail
- **AI used thoughtfully** — LLM for classification/drafting/negotiation, deterministic code for authorization/execution
- **Compliance-aware design** — 8 named policy functions encoding RBI e-mandate rules, quiet hours, escalation ceilings
- **Honest evaluation** — 59.6% recovery rate includes deliberately-unrecoverable cases and compliance-blocked actions
- **Production-grade thinking** — two non-trivial bugs caught through verification (timestamp spread, raw_payload envelope, promise-ledger gap)

The system is designed to be **demoed, audited, and extended** — not just to recover money, but to prove that an AI agent can do so responsibly.

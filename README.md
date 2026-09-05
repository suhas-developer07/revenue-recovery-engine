# AI Revenue Recovery

An AI-powered system that detects payment failures, diagnoses root causes, decides compliant recovery actions through a deterministic policy layer, and executes recovery — with a full audit trail and honest batch metrics.

> **Recovered ₹23.16L of ₹38.85L at risk (59.6%)** across a 220-record synthetic batch, with 93 actions correctly blocked by compliance rules.

---

## The Problem

Razorpay merchants lose revenue across four disconnected leak points:

| Leak | What happens | Why it's hard |
|------|-------------|---------------|
| **Payment failures** | Card/UPI/netbanking transactions fail silently | Error codes are noisy — merchants don't know what to do |
| **Checkout abandonment** | Users drop off before paying | No retry mechanism by default |
| **Subscription failures** | UPI Autopay / e-mandate recurring debits fail | RBI e-mandate rules make blind retries non-compliant |
| **Overdue receivables** | B2B invoices go unpaid past due date | Chasing requires professional, rate-limited escalation |

Today each leak is handled by a different tool — or nothing at all. AI can close the loop from detection to compliant recovery, but only if you put deterministic guardrails around the AI so it can't move money it shouldn't.

---

## The Solution

A five-layer pipeline that runs a full closed loop:

```
Webhook in  →  Classify  →  Decide (policy)  →  Execute  →  Audit trail
                   ↑               ↑
              Rules + LLM    8 compliance rules
```

**Core principle: the LLM proposes, a deterministic policy layer disposes.** Every money-moving or customer-facing action passes through named, testable policy functions before execution. The LLM never authorizes anything — it generates text and structured guesses. Code validates everything.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  1. SIGNAL INGESTION (Go)                   │
│  Razorpay webhooks → Postgres + Redis       │
├─────────────────────────────────────────────┤
│  2. CLASSIFICATION (Go + TypeScript)        │
│  Rules engine handles ~80%                  │
│  LLM fallback for ambiguous cases           │
├─────────────────────────────────────────────┤
│  3. POLICY / DECISION (Go)                  │
│  8 deterministic guardrails authorize/block  │
├─────────────────────────────────────────────┤
│  4. EXECUTION (TypeScript)                  │
│  Razorpay API, SMS, email, WhatsApp, voice  │
├─────────────────────────────────────────────┤
│  5. AUDIT TRAIL & DASHBOARD                 │
│  Immutable event ledger → Next.js dashboard  │
└─────────────────────────────────────────────┘
```

**Go** handles correctness-critical layers — ingestion, classification, policy, and the promise state machine. **TypeScript** handles LLM integration, execution adapters, and the dashboard. The boundary is clean: Go decides, TypeScript executes.

![Architecture](docs/architecture.md)

---

## What Makes This Different

**1. Deterministic policy layer in front of the LLM.** Most systems let the LLM decide everything. Here, the LLM classifies and drafts — but eight named Go functions in `internal/policy/` authorize or block every action. This is exactly what a payments company needs and what most hackathon submissions skip.

**2. Real compliance rules, encoded as code.** RBI e-mandate thresholds, 24-hour pre-debit windows, mandate revocation kill-switches, quiet hours, opt-out handling, escalation ceilings — all implemented as testable functions with unit tests.

**3. Honest, non-cherry-picked metrics.** The 59.6% recovery rate includes deliberately unrecoverable cases (13 STOP_SEQUENCE) and compliance-blocked actions (93). A 100% recovery rate would read as fake.

**4. Full audit trail.** Every layer writes exactly one row per event: `events → classifications → decisions → actions`. The audit log has a "Blocked actions" filter and expandable reasoning traces — you can see exactly why any action was taken or refused.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend (policy, ingestion) | Go |
| Backend (execution, LLM, dashboard) | TypeScript |
| Database | PostgreSQL 16 |
| Queue | Redis 7 |
| Dashboard | Next.js + recharts |
| Payments | Razorpay test-mode APIs |
| LLM | Groq free tier (Llama 3.3 70B) via OpenAI-compatible API |
| Migrations | Goose |

---

## Getting Started

### Prerequisites

- Docker and Docker Compose
- A Razorpay test-mode account (free)
- A Groq API key (free, no credit card)

### 1. Clone and configure

```bash
git clone <your-repo-url>
cd ai-revenue-recovery
cp .env.example .env
```

Edit `.env` with your keys:

```bash
# Razorpay test-mode keys (from dashboard.razorpay.com → Settings → API Keys)
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxx
RAZORPAY_SUCCESS_RATE=0.6
RAZORPAY_SEED=phase6batch

# Groq API key (from console.groq.com → API Keys → Create Key)
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxx
GROQ_MODEL=openai/gpt-oss-120b
```

### 2. Start everything

```bash
make up
```

This starts 7 services: Postgres, Redis, Ingestion, Decision Engine, Execution, LLM Orchestrator, and Dashboard. Wait ~30 seconds for everything to build.

### 3. Verify health

```bash
curl localhost:8081/health   # ingestion
curl localhost:8082/health   # decision-engine
curl localhost:8083/health   # execution
curl localhost:8084/health   # llm-orchestrator
curl localhost:3000          # dashboard
```

### 4. Generate data and run the pipeline

```bash
make seed
```

This generates 220 synthetic payment events and pushes them through the real pipeline — ingest → classify → decide → execute → promise tracking. The dashboard populates with real data.

### 5. View results

```bash
open http://localhost:3000           # Dashboard overview
open http://localhost:3000/report    # Batch report with full metrics
```

### Useful commands

```bash
make reset-data     # Clear pipeline data (keep schema)
make seed           # Re-generate and run a fresh batch
make test           # Run all tests (Go + TypeScript)
make logs           # Tail all service logs
make down           # Stop all containers
```

---

## Dashboard

| Page | URL | What it shows |
|------|-----|---------------|
| **Overview** | `/` | ₹ recovered counter, recovery rate, funnel chart |
| **Live Feed** | `/feed` | Recent events with classification, decision, execution status |
| **Audit Log** | `/audit` | Filterable table with "Blocked actions" filter and expandable reasoning traces |
| **Promise Tracker** | `/promises` | Promise-to-pay state machine per invoice, with simulate-debtor-response buttons |
| **Negotiate** | `/negotiate` | Hinglish multi-turn negotiation chat with debtor presets |
| **Batch Report** | `/report` | Recovery by leak type, blocked count, rules-vs-LLM split, promise metrics |

---

## Batch Report Numbers

**220 synthetic records, 6-day timestamp spread**

| Metric | Value |
|--------|-------|
| Total at-risk | ₹38,85,212 |
| Total recovered | ₹23,16,408 |
| **Recovery rate** | **59.6%** |
| Unrecoverable (STOP_SEQUENCE) | 13 |
| Blocked by compliance | 93 |
| Promises kept / total | 27 / 33 (81.8%) |

**Recovery by leak type:**

| Leak type | Events | At-risk | Recovered | Blocked |
|-----------|--------|---------|-----------|---------|
| Failed payment | 129 | ₹22,84,393 | ₹14,55,623 | 60 |
| Checkout abandonment | 45 | ₹11,40,943 | ₹6,27,265 | 0 |
| Receivables (overdue) | 33 | ₹2,83,298 | ₹2,33,521 | 33 |
| Subscription / mandate | 13 | ₹1,76,578 | ₹0 | 0 |

**Edge cases:**
- **Success:** ₹2.48L AFA-threshold payment link captured in full — the policy layer correctly refused a blind retry and routed to an authenticated payment link instead
- **Honest failure:** ₹33K reminder blocked by `OUTSIDE_QUIET_HOURS` — the system refused to contact a debtor at 2 AM, by design

> Run `make reset-data && make seed` to reproduce these numbers.

---

## Compliance Rules

Eight named, testable policy functions in `internal/policy/`:

| Rule | Function | Effect |
|------|----------|--------|
| RBI AFA threshold | `IsBelowAFAThreshold` | Recurring charges ≥ ₹15,000 → payment link instead of blind retry |
| 24h pre-debit notice | `IsWithinPreDebitWindow` | Auto-debit blocked within 24h of customer notification |
| Mandate revoked | `IsMandateRevoked` | Immediate STOP_SEQUENCE — never retries a revoked mandate |
| Max retry attempts | `HasExceededMaxAttempts` | After 3 attempts → ESCALATE_TO_HUMAN |
| Exponential cooldown | `IsWithinCooldown` | Respects scheduled next-attempt window |
| Quiet hours | `IsOutsideQuietHours` | No outbound contact outside 9am–7pm |
| Opt-out / DND | `IsOptedOut` | Respects channel opt-out, falls back to lower-friction channel |
| Escalation ceiling | `HasExceededEscalationCeiling` | After 5 escalations across all channels → STOP_SEQUENCE |

---

## What's Real vs. Simulated

| Component | Status |
|-----------|--------|
| Razorpay webhook ingestion | **Real** — HMAC-SHA256 verification, idempotent persistence, Redis Stream publish |
| Policy layer / compliance rules | **Real** — deterministic Go functions with unit tests |
| Synthetic batch generator | **Real pipeline** — posts signed webhooks through the actual ingestion service |
| Dashboard / audit trail | **Real** — queries live Postgres data |
| Channel adapters (SMS, email, WhatsApp) | **Stubbed** — log what would be sent |
| Razorpay API calls (retry, payment link) | **Deterministic stub** — uses FNV-1a hash for per-order success/failure |
| Voice negotiation | **Text transcript** — LLM-powered Hinglish chat, no real audio |
| LLM calls | **Real** — Groq free tier for classification, drafting, and negotiation |

---

## Project Structure

```
├── services/
│   ├── ingestion/          # Go — Razorpay webhook ingestion
│   ├── decision-engine/    # Go — Classification, policy layer, promise state machine
│   │   ├── internal/
│   │   │   ├── classifier/ # Rules engine + LLM fallback
│   │   │   ├── policy/     # 8 compliance functions (the guardrails)
│   │   │   └── statemachine/ # Promise-to-pay state machine
│   │   └── cmd/server/     # HTTP server
│   ├── execution/          # TypeScript — Action execution, channel adapters
│   ├── llm-orchestrator/   # TypeScript — Groq-powered classify, draft, negotiate
│   └── dashboard/          # Next.js — Overview, feed, audit, promises, negotiate, report
├── data/
│   ├── synthetic-batch-generator/  # Generates 220 realistic test events
│   └── negotiation-simulator/      # Automated Hinglish negotiation tests
├── migrations/             # Goose SQL migrations
├── docs/
│   ├── decisions.md        # Architecture decisions log (17 entries)
│   ├── architecture.md     # Mermaid architecture diagram
│   ├── pitch-script.md     # 5-minute pitch video script
│   └── explanation.md      # Full project walkthrough
├── docker-compose.yml
├── Makefile
└── .env.example
```

---

## Design Decisions

Key trade-offs are documented in [`docs/decisions.md`](docs/decisions.md) — 17 entries covering:

- Why Go + TypeScript, and where the boundary sits
- Ingestion verifies raw bytes, not re-serialized JSON
- Idempotency via a separate table, checked before insert
- The policy layer is pure, ordered, and testable without a database
- Decision traces stored verbatim, never reconstructed
- Synthetic data methodology and recovery-accounting honesty
- Hinglish negotiation as text transcript, not real TTS

---

## What We'd Build Next

- Stream-based retry for execution reliability (currently fire-and-forget HTTP)
- Real TTS rendering on top of the negotiation transcript
- Webhook replay tooling for integration testing against real Razorpay test-mode events
- Real-time WebSocket feed for the dashboard
- Expand `escalation_history` granularity with timestamps per sub-action

---

## License

MIT

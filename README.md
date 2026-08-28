# AI Revenue Recovery

An AI-powered system that detects payment failures, classifies root causes, decides compliant recovery actions through a deterministic policy layer, and executes recovery — with a full audit trail and honest batch metrics.

## Problem

Razorpay merchants lose revenue across four disconnected leak points:
1. **Payment failures** — card/UPI/netbanking transactions fail silently
2. **Checkout abandonment** — users drop off before paying
3. **Subscription/mandate failures** — UPI Autopay fails (RBI e-mandate compliance required)
4. **Overdue B2B receivables** — unpaid invoices past due date

Today each leak is handled by a different, disconnected tool — or nothing at all.

## Architecture

```
┌─────────────────────────────────────────────┐
│  1. SIGNAL INGESTION (Go)                   │
│  Razorpay webhooks → Postgres               │
├─────────────────────────────────────────────┤
│  2. DETECTION & CLASSIFICATION              │
│  Rules engine (Go) + LLM fallback (TS)      │
├─────────────────────────────────────────────┤
│  3. DECISION / POLICY (Go)                  │
│  Deterministic guardrails authorize actions  │
├─────────────────────────────────────────────┤
│  4. EXECUTION (TypeScript)                  │
│  Razorpay API, SMS, email, WhatsApp, voice  │
├─────────────────────────────────────────────┤
│  5. AUDIT TRAIL & DASHBOARD                 │
│  Immutable event ledger → Next.js dashboard  │
└─────────────────────────────────────────────┘
```

> Architecture diagram placeholder — will be replaced with a clean render by Phase 8.

## Key Design Principle

**The LLM proposes, a deterministic policy layer disposes.** Every money-moving or customer-facing action must pass through named, testable policy functions before execution. The policy layer is the single most differentiating piece of this system.

## Tech Stack

- **Backend:** Go (Ingestion, Decision Engine) + TypeScript (Execution, LLM Orchestrator, Dashboard)
- **Database:** PostgreSQL 16
- **Cache/Queue:** Redis 7
- **Dashboard:** Next.js
- **Payments:** Razorpay test-mode APIs
- **LLM:** Claude (Anthropic)
- **Migrations:** Goose

## Getting Started

```bash
# 1. Copy and fill in your test-mode keys
cp .env.example .env

# 2. Start everything
make up

# 3. Apply database migrations
make db-up

# 4. Check service health
curl localhost:8081/health   # ingestion
curl localhost:8082/health   # decision-engine
curl localhost:8083/health   # execution
curl localhost:8084/health   # llm-orchestrator
curl localhost:3000          # dashboard
```

## What's Real vs. Simulated

- **Real:** Razorpay test-mode webhook ingestion, database schema, policy layer logic, compliance rules
- **Simulated:** Channel adapters (SMS/email/WhatsApp/voice) are stubs that log what would be sent. Voice negotiation is a text transcript. Dashboard data will come from synthetic batch in Phase 6.

## Metrics

> Populated after running the synthetic batch in Phase 6.

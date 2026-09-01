# AI Revenue Recovery

An AI-powered system that detects payment failures, classifies root causes, decides compliant recovery actions through a deterministic policy layer, and executes recovery — with a full audit trail and honest batch metrics.
freebuff --continue 2026-08-30T11-43-54.470Z
> **Recovered ₹23.16L of ₹38.85L at risk (59.6%)** across a 220-record synthetic batch, with 93 actions correctly blocked by compliance rules.
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

![Architecture](docs/architecture.png)

*Go handles correctness-critical layers (ingestion, policy, state machine). TypeScript handles LLM/UI-fast layers (execution, LLM orchestration, dashboard).*

## Key Design Principle

**The LLM proposes, a deterministic policy layer disposes.** Every money-moving or customer-facing action must pass through named, testable policy functions before execution. The policy layer is the single most differentiating piece of this system.

## Tech Stack

- **Backend:** Go (Ingestion, Decision Engine) + TypeScript (Execution, LLM Orchestrator, Dashboard)
- **Database:** PostgreSQL 16
- **Cache/Queue:** Redis 7
- **Dashboard:** Next.js
- **Payments:** Razorpay test-mode APIs
- **LLM:** Groq (free tier, Llama 3.3 70B) via OpenAI-compatible API
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

# 5. Run the synthetic batch (generates data → runs through pipeline → populates dashboard)
make seed

# 6. View the dashboard and batch report
open http://localhost:3000
open http://localhost:3000/report
```

## What's Real vs. Simulated

- **Real:** Razorpay test-mode webhook ingestion (HMAC signature verification + idempotent persistence to Postgres, with Redis Stream publish), database schema, policy layer logic, compliance rules, synthetic batch generator posting signed webhooks through the real pipeline, dashboard querying real Postgres data
- **Simulated:** Channel adapters (SMS/email/WhatsApp/voice) are stubs that log what would be sent. Voice negotiation is a text transcript. Razorpay API calls (payment retry, payment link creation) are deterministic stubs using `RAZORPAY_SUCCESS_RATE` — the calling convention matches the real SDKs so swapping in live keys is a drop-in change.

## Phase 1 — Ingestion (Done)

The **Ingestion** service (`services/ingestion`) receives Razorpay webhooks, verifies their HMAC-SHA256 signature against `RAZORPAY_WEBHOOK_SECRET`, dedupes on event ID, parses the minimal fields, persists each verified event to `events`, and publishes the new event ID to a Redis Stream (`new_events`).

Verify it end to end:

```bash
# Point the /webhook/razorpay endpoint at a live Razorpay test-mode webhook (via ngrok/cloudflared),
# then trigger a payment failure. Or replay a signed payload locally:
curl -X POST localhost:8081/webhook/razorpay -H "Content-Type: application/json" \
  -H "X-Razorpay-Signature: <hmac-sha256(body, webhook_secret)>" \
  -H "X-Razorpay-Event-Id: <unique-id>" \
  -d '{"event":"payment.failed","payload":{"payment":{"entity":{"order_id":"order_X","customer_id":"cust_Y","amount":25000}}}}'

# Confirm the row landed:
docker exec -it revenue-recovery-postgres psql -U postgres -d revenue_recovery \
  -c "SELECT event_type, order_id, amount_paise, received_at FROM events;"

# Confirm the queue entry:
docker exec -it revenue-recovery-redis redis-cli XLEN new_events
```

Spoofed/unsigned payloads are rejected with `401` and logged under "rejected webhook: invalid or missing signature".

## Phase 2 — Detection & Classification (Done)

The **Decision Engine** (`services/decision-engine`) classifies every ingested event into one of a closed set of `risk_category` values, writing exactly one row to `classifications` per event:

- **Rules engine** (`internal/classifier/rules.go`) — an ordered table of substring matchers grounded on realistic Razorpay error codes/reasons. Cheap, deterministic, handles the majority.
- **LLM fallback** — only when no rule matches. The Go service calls `llm-orchestrator`'s `/classify` endpoint (which validates against the same closed enum via zod). With no `GROQ_API_KEY` set, it falls back to a deterministic keyword heuristic so the pipeline stays fully testable.
- **Enum enforcement** — `ValidCategory()` is asserted on every result (rules and LLM alike) before writing, so a bad string can never corrupt Phase 3's policy matching.
- **`priority_score`** — `amount_paise/100 × recoverability_weight[category]`, stored at classification time to drive batch prioritization later.
- **checkout_abandoned sweep** — a `time.Ticker` background sweep detects orders past the 30-minute window that never reached a paid state (consult `internal/db/abandoned.go`). This is absence-based polling, not a webhook.
- **Publish** — each new classification is pushed to the `new_classifications` Redis stream for Phase 3.

The Decision Engine consumes `new_events` via a Redis Streams consumer group (at-least-once) and backfills any events missed on startup — guaranteeing "every event ⇒ exactly one classification".

Verify it:

```bash
# A rules-matched failure → classified by rules_engine
curl -s localhost:8084/classify -H "Content-Type: application/json" \
  -d '{"event_type":"payment.failed","signal":"bank declined insufficient funds"}'  # llm-orchestrator

# Inspect classifications
docker exec -it revenue-recovery-postgres psql -U postgres -d revenue_recovery \
  -c "SELECT e.order_id, c.risk_category, c.classified_by, round(c.priority_score::numeric,2) FROM classifications c JOIN events e ON e.id=c.event_id;"

# Rules vs LLM split
docker exec -it revenue-recovery-postgres psql -U postgres -d revenue_recovery \
  -c "SELECT classified_by, count(*) FROM classifications GROUP BY classified_by;"
```

## Phase 3 — Policy & Decision Engine (Done)

The **guardrail layer**: the thing that stops an autonomous agent from moving money it shouldn't. For every classified event the policy engine produces exactly **one** `decisions` row — either an **authorized** action or a **blocked** verdict — with the full reasoning chain captured as evidence.

- **Pure policy functions** (`internal/policy/*.go`) — no DB access. Each takes a `DecisionContext` and returns `(allowed bool, reason string)`. Checks run in a fixed order: hard kill-switches first, then soft rules.
- **Propose → Check → Authorize/Block** (`internal/policy/decide.go`):
  1. `IsMandateRevoked` — revoked mandate ⇒ `STOP_SEQUENCE` (the agent never touches that account again).
  2. `HasExceededEscalationCeiling` — cross-channel escalation exhausted ⇒ stop.
  3. `HasExceededMaxAttempts` — retry cap (3) ⇒ route to `ESCALATE_TO_HUMAN`.
  4. `IsWithinCooldown` — exponential backoff respects the scheduled next attempt.
  5. **Recurring/mandate only**: `IsBelowAFAThreshold` (RBI ₹15,000 AFA ceiling) + `IsWithinPreDebitWindow` (24h notice). Above ₹15k the candidate `RETRY_PAYMENT` **transforms** into `SEND_PAYMENT_LINK` — never a blind retry.
  6. `IsOptedOut` + `IsOutsideQuietHours` (9am–7pm) — channel opt-out fallback and nap-hours gating.
- **Explicit candidate mapping** (`CandidateFromRiskCategory`) — diagnosis → action is Go code, *not* inside the LLM.
- **Always writes a `decisions` row, including blocked ones** — blocked rows are compliance evidence.
- **Idempotent per classification** — `decisions.classification_id` has a UNIQUE constraint (Phase 3's equivalent of Phase 1's `processed_webhook_ids`), and the decider check-before-decides and replays the existing verdict. A redelivered `classification_id` (at-least-once consumer) can never create a duplicate row or re-count attempts / re-authorize a retry that already ran.
- **Trace is accumulated during the real run** (`internal/policy/decide.go` builds a `DecisionTrace` as it goes) and serialized to the `reasoning` column. `--explain` reads it back — it is *not* reconstructed after the fact.
- **Action payload is Phase-4-schema-faithful** — `DecisionTrace` carries `target {order_id, customer_id}` plus `action, channel, reasoning, authorized_by_rule, attempt_number, cooldown_until`, matching `docs/action.schema.json`. It validates cleanly against the execution service's zod `RecoveryActionSchema` (no drift that would reject execution).
- **Orchestration** (`internal/decider/service.go` + `internal/db/decisions.go`) — fetches mandate/opt-out/attempt history ONCE per event, builds the context, runs `Decide`, and persists exactly one row.

Verify it:

```bash
# Decide an event (classify + policy + persist)
curl -X POST localhost:8082/decide/<event-uuid>

# Playback the stored reasoning trace (the audit trail)
curl -s localhost:8082/decisions/<event-uuid>/explain | python3 -m json.tool
go run ./cmd/server --explain <event-uuid>        # Makefile: make explain EVENT_ID=<uuid>

# Inspect decisions evidence
docker exec -it revenue-recovery-postgres psql -U postgres -d revenue_recovery \
  -c "SELECT d.action, d.blocked, COALESCE(d.block_reason,'-') FROM decisions d;"
```

Key guarantees: a revoked mandate can never be retried; a recurring charge above ₹15,000 is never silently retried; a customer is never contacted outside 9am–7pm local; and retries stop after 3 attempts. Currency is integer paise throughout.

## Phase 4 — Execution & LLM Orchestrator (Done)

The **recovery layer**: authorized decisions become real (test-mode) Razorpay calls and real (or stubbed) customer contact. When the decision engine authorizes a non-blocked action, it POSTs the action (plus `decision_id`, `event_id`, `amount_paise`) to the Execution service over HTTP; the Execution service re-validates it, executes it, and writes exactly one `actions` row. The LLM Orchestrator's `/draft` writes the message copy.

- **Independent re-validation (`LLM proposes, code disposes`)** — the Execution service re-runs the action through its own TypeScript zod `RecoveryActionSchema`, independent of the Go decision engine's authorization. A malformed/unknown action is **rejected and logged, never partially executed** (a schema-drift class like the missing `target` would surface here, not as a silent failure).
- **Idempotent per decision** — `actions.decision_id` has a UNIQUE constraint (migration `0004`), and the executor checks `getActionByDecisionId` before dispatching. A redelivered decision (HTTP retry / stream at-least-once) returns the stored result instead of double-sending a payment link or double-attempting a retry — the same bug class guarded in Phases 1 & 3.
- **One `actions` row, always** (`internal` → `services/execution/src/handlers`) — every handler writes a `{success|failed|pending}` row with `outcome_payload`. Handlers: `RETRY_PAYMENT`, `SEND_PAYMENT_LINK`, `SEND_REMINDER` (→ `/draft` + channel adapter), `ESCALATE_TO_HUMAN` (pending human todo), `LOG_PROMISE_TO_PAY` (thin → Phase 5), `STOP_SEQUENCE` (terminal marker).
- **Swappable channel adapters** (`services/execution/src/adapters`) — `SmsAdapter` / `EmailAdapter` / `WhatsAppAdapter` / `VoiceAdapter` implementing one `send()` interface. Stubs log the send honestly (`[EMAIL] to=cust: "..."`) and return success; swapping in Twilio/Resend later, or adding a Hinglish voice adapter in Phase 7, touches nothing else.
- **`/draft` message copy** (`services/llm-orchestrator/src/draft.ts`) — given the risk category, the actual `root_cause_narrative` from Phase 2's classification, amount, channel and attempt number, it produces root-cause-specific copy ("looks like your bank declined this…") with a heuristic fallback when no `GROQ_API_KEY` is set. The LLM writes the wording only — it never decides whether or who to contact.
- **Honest recover accounting** (`amount_recovered_paise`) — `RETRY_PAYMENT` counts the full amount **only on a confirmed Razorpay capture** (never on "attempted"). `SEND_PAYMENT_LINK` is recorded `status: pending, amount 0` until a follow-up sweep confirms the linked payment actually captured — that's exactly when it flips to `success` + the real amount. Full methodology in `docs/decisions.md` #13.

Verify it:

```bash
# The Execution service re-validates + executes an action directly
curl -s -X POST localhost:8083/execute -H "Content-Type: application/json" -d '{
  "decision_id":"<decision-uuid>","event_id":"<event-uuid>","amount_paise":250000,
  "action":"SEND_PAYMENT_LINK","target":{"order_id":"<order>","customer_id":"<cust>"},
  "channel":"email","reasoning":"authorized","authorized_by_rule":"TEST_RULE",
  "attempt_number":1,"cooldown_until":null}'

# A zod-malformed action is rejected, not executed
curl -s -X POST localhost:8083/execute -H "Content-Type: application/json" \
  -d '{"decision_id":"x","action":"RETRY_PAYMENT","reasoning":"bad","attempt_number":1}'
# -> {"error":"invalid action", ...}

# Inspect the actions evidence (the recovery ledger)
docker exec -it revenue-recovery-postgres psql -U postgres -d revenue_recovery \
  -c "SELECT a.status, a.amount_recovered_paise, a.outcome_payload->>'kind' FROM actions a;"
```

The full pipeline is automatic: a signed webhook → ingested → classified → decided → dispatched → executed, with each layer leaving its own evidence row (`events` → `classifications` → `decisions` → `actions`).

## Phase 5 — Promise-to-Pay Tracker & Escalation (Done)

The **B2B receivables spine**: overdue invoices for which a human debtor replies "I'll pay by <date>" get tracked through a real state machine, checked when the date arrives, and escalated — or written off — with the same guardrail that stops payment retries. The state machine lives in the **Go decision-engine** (not the TS execution service), since its transitions need Phase 3's `HasExceededEscalationCeiling` directly.

```
notified → awaiting_response → promised → due → kept
                │ (timeout)                 └→ broken → re_escalated → (loop → awaiting_response)
                └→ re_escalated                             └→ written_off  (ceiling reached → STOP_SEQUENCE)
```

- **Pure, inspectable transitions** (`services/decision-engine/internal/statemachine`) — a `(state, trigger) → state` table with no DB access, mirroring the Phase 3 policy-function discipline. A `broken` promise forks through `policy.HasExceededEscalationCeiling`: under the ceiling → `re_escalated` (+ `escalation_count`), at/over it → `written_off`. The same guardrail layer that halts payment retries halts this sequence too.
- **`state` is the single source of truth** — the legacy 4-value `status` column is folded into the 8-value `state` column and dropped (migration `0005`), so there is no second field that can drift. `ApplyTransition` is one `UPDATE` moving `state`, `responded_at`, `resolved_at`, `escalation_count` together.
- **Single-row-with-timestamps, not an event log** — current state + `created_at/updated_at/responded_at/resolved_at` on the one `promises` row already computes every metric; a `promise_transitions` table would be redundant. Each escalation DOES append a granular entry to `escalation_history JSONB` (migration `0006`) — `{escalation_number, triggered_at, authorized_by_rule, action, channel, reasoning}` — so the promise row carries real audit detail (same trace-capture spirit as `decisions.reasoning`), not just an aggregate `escalation_count`. Rationale in `docs/decisions.md` #14.
- **Live "simulate debtor response" path** — `POST /promises/{id}/respond {promised_date}` acts as the debtor typing back a date; `POST /promises/{id}/advance {trigger}` walks the rest of the lifecycle (`request_response | date_arrives | paid | not_paid | timeout`).
- **Promote the Phase 4 thin handler** — the Execution `LOG_PROMISE_TO_PAY` handler now registers the promise in the decision-engine tracker (via `DECISION_ENGINE_URL`) instead of only writing an audit row.
- **Reusable escalation** — on each break the tracker re-runs `policy.Decide` with the promise's `escalation_count`: `SEND_REMINDER` escalations 0–4, then `STOP_SEQUENCE (ESCALATION_CEILING_REACHED_STOP)` at 5.

Verify it:

```bash
# Register an overdue invoice as a promise (starts in 'notified')
curl -s -X POST localhost:8082/promises -H "Content-Type: application/json" -d '{"event_id":"<event-uuid>"}'

# Simulate the debtor responding with a promised date (the live-demo button)
curl -s -X POST localhost:8082/promises/<promise-uuid>/respond \
  -H "Content-Type: application/json" -d '{"promised_date":"2026-09-05"}'

# Walk the lifecycle: date arrives -> not paid -> broken -> confirm -> re-escalated (or written_off)
curl -s -X POST localhost:8082/promises/<promise-uuid>/advance -H "Content-Type: application/json" -d '{"trigger":"date_arrives"}'
curl -s -X POST localhost:8082/promises/<promise-uuid>/advance -H "Content-Type: application/json" -d '{"trigger":"not_paid"}'

# Section 6 metrics (promise-keeping rate, time-to-promise, escalation depth, write-off rate)
curl -s localhost:8082/promises/metrics
```

## Phase 6 — Dashboard, Audit Trail & Batch Report (Done)

The **Dashboard** (`services/dashboard`) is a Next.js app that makes every prior phase visible and undeniable — the thing you screen-record for the pitch video.

### Synthetic Batch Generator

A realistic batch of 100–300 synthetic records is generated with:
- **Log-normal amount distribution** — many small transactions, a few large B2B invoices (median ~₹7.3k, long tail to lakhs)
- **Realistic failure-reason weighting** — `insufficient_funds` (30%) and `bank_timeout` (18%) dominate; `mandate_revoked` and `risk_block` are rarer
- **All four leak types** — payment failure, checkout abandonment, subscription/mandate, overdue receivables
- **Deliberately unrecoverable cases** (~18%) — revoked mandates, risk blocks, escalation ceiling write-offs — so the recovery rate is honest, not 100%
- **Simulated promise responses** — mix of kept, broken-then-recovered, and written-off, driving real variance in promise metrics

The generator posts signed webhooks to the real ingestion service — events flow through the *actual* pipeline (ingest → classify → decide → execute → promise tracking). Results are not pre-computed.

```bash
# Generate and run the synthetic batch
make seed

# Reset pipeline data for a reproducible fresh run
make reset-data
make seed
```

### Dashboard Pages

- **Overview** (`/`) — ₹ recovered counter, recovery rate, funnel chart (recharts), compliance/unrecoverable/promise chips
- **Live Feed** (`/feed`) — recent events with classification, decision, and execution status
- **Audit Log** (`/audit`) — filterable table over `events → classifications → decisions → actions`, with **"Blocked actions" filter** and expandable reasoning traces
- **Promise Tracker** (`/promises`) — PTP state machine per invoice, with live "simulate debtor response" buttons
- **Batch Report** (`/report`) — recovery by leak type, blocked-by-compliance count, rules-vs-LLM split, promise metrics, narrated edge case

### Batch Report Metrics

The report page (`/report`) generates:
- Total at-risk ₹ vs. total recovered ₹, with recovery rate
- Recovery rate broken down by leak type (payment failure / checkout / subscription / receivables)
- Blocked-by-compliance count with reasons
- Rules-vs-LLM classification split
- Promise-keeping rate, write-off rate, avg escalation depth
- One narrated edge case (success: the AFA-threshold payment link that captured in full)
- One narrated failure (the system refused to send a reminder outside quiet hours — honest miss, by design)

### Per-Order Deterministic Success Rate

The Razorpay stub (`services/execution/src/razorpay/client.ts`) uses `RAZORPAY_SUCCESS_RATE` (0–1) and `RAZORPAY_SEED` to decide per-order outcomes deterministically via FNV-1a hash — the same batch always produces the same recovery numbers, while still letting a believable fraction fail.

## Phase 7 — Hinglish Voice/Negotiation Channel (Done)

A multi-turn negotiation channel where the agent converses in Hinglish with a debtor to collect payment or agree on a promise date — built as a swappable adapter with zero changes to the Decision Engine or policy layer.

- **`/negotiate` endpoint** — Stateless, turn-limited (max 8 exchanges). The LLM converses in natural Hinglish and emits structured outcomes (`paid_now | promised | declined | escalate`).
- **Hard turn limit enforced in code** (`MAX_NEGOTIATION_TURNS = 8`), never relying on the model to self-limit.
- **Same principle applied to conversation** — the model proposes natural language + a structured outcome guess; the Execution Service validates and routes it downstream.
- **Promise registration** — a `promised` outcome creates a real `promises` row via the existing Phase 5 state machine endpoint.
- **Dashboard UI** (`/negotiate`) — Chat interface with quick debtor presets (Cooperative, Evasive, Hostile, Can't Pay).
- **Automated simulator** (`data/negotiation-simulator/`) — Tests 5 personas end-to-end without human input.

```bash
# Test the negotiation endpoint
curl -s -X POST localhost:8083/negotiate -H "Content-Type: application/json" -d '{
  "sessionContext":{"customerId":"cust_1","orderId":"ord_1","amountPaise":500000,
    "rootCauseNarrative":"insufficient funds","escalationCount":0},
  "transcript":[],"debtorMessage":""
}'

# Run automated persona tests
make simulate-negotiation
```

## Compliance Rules Summary

The policy layer enforces these rules as testable, named functions — this is the single biggest differentiator from a naive retry bot.

| Rule | Function | Effect |
|------|----------|--------|
| RBI AFA threshold | `IsBelowAFAThreshold` | Recurring charges ≥ ₹15,000 → `SEND_PAYMENT_LINK` instead of blind retry |
| 24h pre-debit notice | `IsWithinPreDebitWindow` | Auto-debit blocked within 24h of customer notification |
| Mandate revoked | `IsMandateRevoked` | Immediate `STOP_SEQUENCE` — never retries a revoked mandate |
| Max retry attempts | `HasExceededMaxAttempts` | After 3 attempts → `ESCALATE_TO_HUMAN` |
| Exponential cooldown | `IsWithinCooldown` | Respects scheduled next-attempt window |
| Quiet hours | `IsOutsideQuietHours` | No outbound contact outside 9am–7pm |
| Opt-out/DND | `IsOptedOut` | Respects channel opt-out, falls back to lower-friction channel |
| Escalation ceiling | `HasExceededEscalationCeiling` | After 5 escalations across all channels → `STOP_SEQUENCE` |

## Final Batch Report

**220 synthetic records, 6-day timestamp spread**

| Metric | Value |
|--------|-------|
| **Total at-risk** | **₹38,85,212 (₹3.89 crore)** |
| **Total recovered** | **₹23,16,408 (₹2.32 crore)** |
| **Recovery rate** | **59.6%** |
| Actions recovered | ₹20,82,887 |
| Promises recovered | ₹2,33,521 |
| Unrecoverable (STOP_SEQUENCE) | 13 |
| Blocked by compliance | 93 (51 × PRE_DEBIT_NOTICE_WINDOW, 42 × OUTSIDE_QUIET_HOURS) |
| Rules vs LLM | 127 vs 0 |
| Promises kept / total | 27 / 33 (81.8%) |

**Recovery by leak type:**

| Leak type | Events | At-risk | Recovered | Blocked |
|-----------|--------|---------|-----------|---------|
| Failed payment | 129 | ₹22,84,393 | ₹14,55,623 | 60 |
| Checkout abandonment | 45 | ₹11,40,943 | ₹6,27,265 | 0 |
| Receivables (overdue) | 33 | ₹2,83,298 | ₹2,33,521 | 33 |
| Subscription / mandate | 13 | ₹1,76,578 | ₹0 | 0 |

**Edge cases (honest, not cherry-picked):**
- **Success story:** ₹2.48L AFA-threshold payment link captured in full
- **Honest failure:** ₹33K `SEND_REMINDER` blocked by `OUTSIDE_QUIET_HOURS` — the system refused to contact a debtor outside 9am–7pm, by design

> Run `make reset-data && make seed` to reproduce. Dashboard at `localhost:3000/report`.

## What We'd Build Next

- Replace fire-and-forget HTTP dispatch with stream-based retry for execution reliability
- Expand `escalation_history` granularity with timestamps per sub-action
- Add real TTS rendering layer on top of the Phase 7 text transcript (ElevenLabs or similar)
- Add webhook replay tooling for integration testing against real Razorpay test-mode events
- Build a real-time WebSocket feed for the dashboard (currently polling-based)

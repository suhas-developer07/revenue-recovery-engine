# AI Revenue Recovery

An AI-powered system that detects payment failures, classifies root causes, decides compliant recovery actions through a deterministic policy layer, and executes recovery — with a full audit trail and honest batch metrics.
opencode -s ses_fb7a6b6e6ffeb1EMIkXaoxHYHQ
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

- **Real:** Razorpay test-mode webhook ingestion (HMAC signature verification + idempotent persistence to Postgres, with Redis Stream publish), database schema, policy layer logic, compliance rules
- **Simulated:** Channel adapters (SMS/email/WhatsApp/voice) are stubs that log what would be sent. Voice negotiation is a text transcript. Dashboard data will come from synthetic batch in Phase 6.

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
- **LLM fallback** — only when no rule matches. The Go service calls `llm-orchestrator`'s `/classify` endpoint (which validates against the same closed enum via zod). With no `ANTHROPIC_API_KEY` set, it falls back to a deterministic keyword heuristic so the pipeline stays fully testable.
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
- **`/draft` message copy** (`services/llm-orchestrator/src/draft.ts`) — given the risk category, the actual `root_cause_narrative` from Phase 2's classification, amount, channel and attempt number, it produces root-cause-specific copy ("looks like your bank declined this…") with a heuristic fallback when no `ANTHROPIC_API_KEY` is set. The LLM writes the wording only — it never decides whether or who to contact.
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

## Metrics

> Populated after running the synthetic batch in Phase 6.

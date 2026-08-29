# Architecture Decisions

> This file logs key trade-offs and design decisions, one per phase. By day 7 it reads like a senior engineer's design log.

## Decision #1 — Why Go + TypeScript, and where the boundary sits

**Decision:** Go for services that touch money directly (Ingestion, Decision Engine); TypeScript for services that touch external APIs and the dashboard (Execution, LLM Orchestrator, Dashboard).

**Reasoning:**
- Go's type safety and concurrency model are ideal for the policy layer — deterministic, testable, no runtime surprises when authorizing payment retries.
- TypeScript's ecosystem (Next.js for dashboard, Anthropic SDK for LLM, Razorpay's own TS SDK) makes the execution and orchestration layer faster to build.
- The boundary is clean: Go decides, TypeScript executes. The `action.schema.json` contract enforces this boundary at the data level, not just the architectural-diagram level.

**Trade-off acknowledged:** Running two language ecosystems in one repo adds operational complexity (two build pipelines, two dependency files per service). For a 7-day build, this is acceptable — the clarity of the Go/TS boundary is worth more than the simplicity of a single-language stack.

---

## Decision #2 — Ingestion verifies the raw body, not re-serialized JSON

**Decision:** HMAC-SHA256 verification runs against the `[]byte` captured by a single `io.ReadAll(r.Body)` *before* any `json.Unmarshal`. The same bytes are reused for parsing and stored as `raw_payload`.

**Reasoning:**
- HMAC is byte-sensitive — re-marshaling the JSON before verifying would produce a different byte sequence and fail even on genuine Razorpay payloads.
- Reading the body once into a `[]byte` avoids the classic "read the body twice" bug where the second read returns empty.

**Trade-off acknowledged:** We must store the full raw body (could be large) as `raw_payload`, but that's cheap and gives us an immutable audit source for replay/debugging.

---

## Decision #3 — Idempotency via a separate table, checked before insert
 
**Decision:** `processed_webhook_ids` table (keyed on `X-Razorpay-Event-Id`, falling back to `event + sha256(body)`) is checked *before* touching `events`.

**Reasoning:**
- Razorpay's own docs recommend expecting occasional duplicate deliveries (network retries). A pre-check means a duplicate costs one cheap lookup, not a failed insert we'd catch-and-swallow.
- Keeps `events` clean: one row per real event, always — which matters later when the batch-report metrics count rows.
- Returning `200` on a duplicate (rather than an error) prevents Razorpay from entering a retry storm on an event we've already accepted.

**Trade-off acknowledged:** A dedicated table is slightly more code than a unique constraint on `events`, but it avoids littering logs with constraint-violation errors that look like real bugs mid-demo.

---

## Decision #4 — Queue via Redis Streams, with a table-poll fallback

**Decision:** The Ingestion service publishes the new event UUID to a single Redis Stream (`new_events`) after a successful insert. Redis publish failure is logged but non-fatal.

**Reasoning:**
- Redis Streams (with `XReadGroup` in later phases) gives the Decision Engine an at-least-once, resumable reading model.
- Making the publish non-fatal (logging rather than erroring out) means a Redis hiccup can't lose a webhook that's already safely persisted — the Decision Engine can always poll `events` as a fallback if we take that path.

**Trade-off acknowledged:** For Phase 1–2 (few services) the queue adds a moving part. We keep it because it's cheap, gives the audit pipeline a real "new event" signal, and is exactly what Phase 3's consumer needs. If it feels like overhead, polling the table is a legitimate documented alternative.

---

## Decision #5 — Classification lives inside the Decision Engine (Option A), not a standalone service

**Date:** Day 2  
**Decision:** Fold the classification rules engine into `decision-engine` as an `internal/classifier/` package, running *before* the policy layer in the same Go process.

**Reasoning:**
- Classification and decision-making are naturally sequential steps over the same event; a separate service adds wire/compose overhead with no functional benefit at this scale.
- The README's layer-2 already reads "Rules engine (Go) + LLM fallback (TS)", so Option A matches the documented architecture — a diagram that doesn't match reality is worse than a simpler one that does.
- The LLM still lives in the TypeScript `llm-orchestrator`; the Go service just calls it over HTTP when rules can't decide.

**Trade-off acknowledged:** One fewer deployable service than the original 5-layer sketch implies. The drawing is updated to reflect that classification is an internal module of the decision-engine.

---

## Decision #6 — Rules table as data + closed enum, enforced at the boundary

**Date:** Day 2  
**Decision:** A single ordered list of substring matcher structs (`internal/classifier/rules.go`) maps signal text → risk category. The nine categories are a closed, exported list; `ValidCategory()` is asserted on *every* result — rules and LLM alike — before a row is written.

**Reasoning:**
- One file answers "here's every rule" for a reviewer, and a table-driven test asserts each mapping.
- Phase 3's policy layer pattern-matches on exact category strings, so a bad string from the LLM would silently corrupt decisions — the closed-enum check at the DB boundary prevents that whole class of bug.
- Substring matching on the concatenated signal (`event_type + error_code + error_description + description`) grounds classification on realistic Razorpay error reasons without brittle exact-keyword dependencies.

**Observed split (live run):** 3 of 6 events classified by `rules_engine`, 2 by the LLM/heuristic fallback, 1 by the checkout sweep. Rules dominate, but the ambiguous cases (an obscure gateway response, a card expiry phrased as "card has expired" rather than "card expired") genuinely needed the fallback — that's the 80/20 line we wanted.

**Trade-off acknowledged:** Substring rules can over-match (e.g. `/risk/` inside an unrelated word). Given a closed enum and `unknown` as the floor, this is acceptable for a hackathon and cheaper than an exact-match grammar.

---

## Decision #7 — checkout_abandoned via a polling sweep, not a webhook

**Date:** Day 2  
**Decision:** A `time.Ticker`-driven sweep queries `events` for orders past the 30-minute abandonment window that never reached a paid/captured state, and inserts a `checkout_abandoned` classification marked `classified_by: 'sweep'`.

**Reasoning:**
- There is no `checkout_abandoned` webhook — it is an *absence*-based, time-windowed concept. Forcing it into the webhook model can't work.
- It also foreshadows the general scheduler Phase 6 needs for batch processing.

**Trade-off acknowledged:** Sweep latency means abandonment isn't classified the instant it happens (bounded by the sweep interval, default 2 min). This is fine — recovery actions never need sub-second abandonment detection.

## Decision #8 — The guardrail layer is a pure, ordered policy engine

**Date:** Day 3  
**Decision:** Every classified event goes through `internal/policy/decide.go`, a *pure* orchestrator that returns a `DecisionTrace` (ordered check list + final verdict). Policy functions take a `DecisionContext` struct and return `(bool, string)` with **no DB access**. Checks run in a fixed order: hard kill-switches (mandate revoked, escalation ceiling) first, then soft rules (max attempts, cooldown, AFA/pre-debit for recurring debits, opt-out, quiet hours). Candidate action selection lives in `CandidateFromRiskCategory` — explicit Go code, deliberately **not** in the LLM.

**Reasoning:**
- This is the "what stops your agent from moving money it shouldn't?" differentiator. If policy depended on the LLM, a hallucinated classification could move money — the whole point is that on-chain guardrails catch policy violations deterministically.
- Pure functions make the logic trivially testable (no DB/mocks) and auditable — the exact inputs to every check are recorded in the trace.

**Trade-off acknowledged:** The `DecisionContext` must be assembled before deciding, so the DB orchestration (`internal/decider`) is separate from the pure policy code to keep the policy layer side-effect-free.

## Decision #9 — Above ₹15k a retry *transforms* into a payment link, and quiet hours gate proactive nudges only

**Date:** Day 3  
**Decision:** RBI's AFA threshold (₹15,000) is enforced as `IsBelowAFAThreshold`. When a recurring charge exceeds it, the candidate `RETRY_PAYMENT` is **not** just blocked — it *transforms* into an authorized `SEND_PAYMENT_LINK` (an authenticated, customer-initiated recovery) instead of a blind retry. Separately, quiet hours (9am–7pm local) block `SEND_REMINDER` (a proactive, unsolicited nudge), but **not** `SEND_PAYMENT_LINK`, which is an action-focused, expected response to a just-failed payment.

**Reasoning:**
- Above the AFA ceiling a silent auto-debit isn't just risky, it's non-compliant; but the recovery *is* still legitimate — routing to a payment link preserves recovery while restoring compliance.
- A payment link after a failed payment is expected and low-disruption; an unsolicited reminder at 10pm is a compliance nap-violation. Treating them differently is defensible and demonstrable regardless of the current clock, which keeps testing deterministic.

**Trade-off acknowledged:** This narrows the "quiet hours block all outbound contact" rule. Enforced at Phase 4 as well — batch scheduling must not send SEND_REMINDER outside the window.

## Decision #10 — Decision traces are stored verbatim as evidence, never reconstructed

**Date:** Day 3  
**Decision:** `Decide` accumulates a `DecisionTrace` (every `CheckResult` plus the final verdict) during the real run. It is JSON-serialized into the existing `decisions.reasoning` column at insert time. `--explain` and `GET /decisions/:event_id/explain` load that stored JSON and render it — they do **not** re-run the policy.

**Reasoning:**
- Reconstituting a past decision by re-running the policy is fragile: it depends on current code and data, not what actually happened. Storing the trace at decision time makes the audit trail exact and immutable.
- Storing JSON in `reasoning` avoids a schema migration / volume reset on the already-running stack; the schema's `reasoning` TEXT column doubles as the evidence store. A dedicated `trace JSONB` column is a clean Phase 4+ refinement.

## Decision #11 — Decisions are idempotent per classification (no duplicate / attempt inflation on redelivery)

**Date:** Day 3  
**Decision:** `decisions.classification_id UUID UNIQUE REFERENCES classifications(id)` — Phase 3's equivalent of Phase 1's `processed_webhook_ids`. The decider also check-before-decides (`GetDecisionTraceByClassification`); on a hit it returns the existing verdict without re-running policy, and a UNIQUE-violation on insert (concurrent redelivery) replays the stored trace.

**Reasoning:**
- `new_classifications` is consumed via a Redis Streams consumer group (**at-least-once**). A redelivered `classification_id` after a restart-before-ack would otherwise insert a second `decisions` row. Worse, `GetAttemptState` counts prior decisions, so the retry would re-declare a *higher* `attempt_number` — flipping an already-authorized retry into `ESCALATE_TO_HUMAN` or silently draining the retry budget. That is exactly the kind of silent double-move a guardrail layer exists to prevent.
- Verified: calling `/decide` twice on the same event yields exactly one row, `attempt_number = 1`, identical trace.

**Trade-off acknowledged:** A re-evaluation on genuinely new data requires removing the decision row first (as the integration tests do) or a future explicit "force re-decide" flag. For production delivery semantics this is correct — each classification is decided exactly once.

## Decision #12 — The produced action payload mirrors action.schema.json (target included), so Phase 4 zod cannot reject it

**Date:** Day 3  
**Decision:** `DecisionTrace` carries a `Target {order_id, customer_id}`, populated from the event, alongside `action, channel, reasoning, authorized_by_rule, attempt_number, cooldown_until`. The serialized trace therefore contains every field `docs/action.schema.json` (and the execution service's zod `RecoveryActionSchema`) marks required.

**Reasoning:**
- Phase 4's TypeScript execution service `safeParse`s every authorized decision against that schema before running it. A field-name or type drift here wouldn't surface in Phase 3 — it would surface as a **rejected action at execution time**. `target` was the missing required field; verifying it now (against the live zod `RecoveryActionSchema`) prevents that Phase 4 validation failure.
- Keeping the trace (evidence) and the exec payload identical means the audit trail *is* the thing that would run — no translation layer that could introduce drift.

**Trade-off acknowledged:** The trace also carries non-payload fields (`checks`, `candidate_action`, `blocked`, `block_reason`); the execution service validates the authorizable subset, and the extras are structured evidence rather than a contract violation.

## Decision #13 — Execution re-validates + is idempotent per decision; SEND_PAYMENT_LINK recovers only on confirmed capture

**Date:** Day 4  
**Decision:**
1. **Transport:** authorized (non-blocked) decisions are handed to the Execution service synchronously over HTTP (`/execute`) with `decision_id`, `event_id`, `amount_paise` plus the action. Dispatch is fire-and-forget & non-fatal — a failure never fails the already-persisted decision.
2. **Re-validation:** the Execution service runs every action through its own TypeScript zod `RecoveryActionSchema`, independently of the Go decision engine. `LLM proposes, code disposes` holds across the Go/TS boundary.
3. **Idempotency:** `actions.decision_id` is `UNIQUE` (migration `0004`); the executor checks `getActionByDecisionId` before dispatching. Redelivery returns the stored result — no double-send.
4. **Recover accounting:** `amount_recovered_paise` is populated precisely — `RETRY_PAYMENT` only on a **confirmed Razorpay capture**; `SEND_PAYMENT_LINK` as `pending/0` until a follow-up sweep confirms the linked payment captured (then `success` + real amount). Every other action contributes 0 directly.

**Reasoning:**
- Two independently-implemented checks on the same contract (Go producing, TS validating) catch drift one side would miss — the exact `target`-drift bug from Phase 3 would now be a logged rejection, not a silent failure.
- The pending-then-confirmed payment-link definition is the *honest* one: a link is created but doesn't recover money until the customer pays it. Counting a created link as recovered would inflate the Phase 6 ₹-recovered metric with an un-credited number. A follow-up sweep (like Phase 2's abandonment sweep) flips it only on actual capture.
- Same at-least-once discipline as Phases 1 & 3 — this bug class has appeared twice already in this architecture, so guarding execution is not hypothetical.

**Verified:** all six handlers write exactly one `actions` row; a `RETRY` without confirmed capture records `failed/0` while a confirmed one records `success/amount`; a `SEND_PAYMENT_LINK` stays `pending/0` and flips to `success/amount` only when the sweep observes capture; two `/execute` calls on the same `decision_id` yield one row (`deduplicated` on the second); malformed/unknown actions are rejected with `invalid action` and never partially executed.

**Trade-off acknowledged:** synchronous HTTP dispatch (chosen over a `new_decisions` Redis stream for this project's scale) means the Execution service is on the decision's critical path; the non-fatal, logged dispatch keeps a down execution service from corrupting the decision ledger, though a separate sweep would be needed to (re)dispatch actions decided while execution was down.


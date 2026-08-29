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


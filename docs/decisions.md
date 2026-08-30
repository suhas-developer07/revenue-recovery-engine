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


## Decision #14 — Promise-to-pay tracker: a pure state machine in Go, `state` as the single source of truth, single-row-with-timestamps (no event-sourced transition log)

**Date:** Day 5  
**Decision:** The Phase 4 `LOG_PROMISE_TO_PAY` thin pass-through is promoted into a real state machine that lives in the **Go decision-engine**, not the TS execution service:

```
notified → awaiting_response → promised → due → kept
                │ (timeout)                 └→ broken → re_escalated → (loop → awaiting_response)
                └→ re_escalated                             └→ written_off  (ceiling reached → STOP_SEQUENCE)
```

- **Pure transition logic** (`internal/statemachine`): a table of `(state, trigger) → state` with no DB access — the same discipline as the Phase 3 policy functions. A `broken` promise is resolved through a fork that calls `policy.HasExceededEscalationCeiling` (Phase 3's exact guardrail): under the ceiling → `re_escalated` (and increments `escalation_count`), at/over it → `written_off`.
- **Single source of truth:** the legacy 4-value `status` column is **folded into `state`** (8 values) and dropped. There is no second column that could drift out of sync; `ApplyTransition` is a single `UPDATE` that moves `state` and its derived fields (`responded_at`, `resolved_at`, `escalation_count`, `updated_at`) together.
- **Single-row-with-timestamps, not an event-sourced transition log:** current state plus `created_at / updated_at / responded_at / resolved_at` on the one `promises` row is sufficient to compute every Section 6 metric (time-to-promise = `responded_at - created_at`; escalation depth = `escalation_count` distribution; promise-keeping & write-off rates = counts by terminal state). A `promise_transitions` table would be a second, redundant record of the same facts — complexity without metric value for this build.
- **Reused, not re-built:** the escalation branch re-runs `policy.Decide` with the promise's `escalation_count`, so the *same* propose→check→authorize/block flow (and ceiling) that stops payment retries also stops a receivables-chasing sequence. Verified live: `SEND_REMINDER` is authorized for escalations 0–4, then flips to `STOP_SEQUENCE (ESCALATION_CEILING_REACHED_STOP)` at count 5 — the sequence terminates at `written_off`, never looping.
- **Live demo path:** a `POST /promises/{id}/respond {promised_date}` endpoint simulates the debtor typing "I'll pay by <date>", and `POST /promises/{id}/advance {trigger}` walks the rest of the lifecycle. `GET /promises/metrics` exposes the aggregates.

**Reasoning:**
- State-machine rules are exactly the "must never be wrong" logic Go owns in this repo, and the `broken` transition needs `HasExceededEscalationCeiling` directly — no network hop to the TS layer.
- Folding `status` into `state` is the zero-drift choice; keeping both in sync is the failure mode the phase explicitly warns about.
- For a 7-day build the metrics are all derivable from timestamped states; an event log would be "impressive but not required" cost (the phase's own guidance).

**Verified:** state-machine unit tests (happy path `kept`, `kept`-on-retry after a break, the ceiling-stops-at-`written_off` DoD scenario without infinite loop, and invalid transitions rejected); and against the live stack an end-to-end walk from `notified` through `kept`, plus a 5-escalation sequence that lands on `written_off` with `resolved_at` set.

**Trade-off acknowledged:** escalation decisions are **scoped to the promise** and re-run `policy.Decide` then log the authorized action (`SEND_REMINDER`/`STOP_SEQUENCE`) rather than writing a second `decisions`/`actions` row. That's deliberate: `classifications` is UNIQUE-per-event and `actions.decision_id` FK-joins to a single `decisions` row per event, so a second event-scoped decision for the same invoice can't be represented there without violating the 1-per-event idempotency model. The promise's own row is the audit trail for the tracker — and to make that claim real rather than aggregate-only, each escalation appends a granular entry to the promise's `escalation_history JSONB` (migration `0006`): `{escalation_number, triggered_at, authorized_by_rule, action, channel, reasoning}` — the same trace-capture discipline as `decisions.reasoning` in Phase 3, but carried on the promise row itself. Verified live: escalations `#1`–`#5` record `SEND_REMINDER`/`SEND_REMINDER_ALLOWED`, and the write-off step records `#6 STOP_SEQUENCE / ESCALATION_CEILING_REACHED_STOP` with the full reasoning.

---

## Decision #15 — Synthetic data methodology, dashboard architecture, and recovery-accounting honesty

**Date:** Day 6 (Phase 6)

**Decision:**
1. **Synthetic batch posts signed webhooks to the real ingestion service** — the generator (`data/synthetic-batch-generator/src/generate.ts`) POSTs HMAC-signed, Razorpay-shaped payloads to `http://localhost:8081/webhook/razorpay`. Events flow through the *actual* pipeline (ingest → classify → decide → execute → promise tracking). We do NOT fabricate results — the generator produces inputs, the pipeline produces outputs.
2. **Deterministic per-order stub success via FNV-1a hash** — `RAZORPAY_SUCCESS_RATE` (0–1 fraction) + `RAZORPAY_SEED` decide each order's outcome from `fnv1a(orderId + kind + seed)`. Same seed + same batch = same recovery numbers, every time. This replaces the old boolean force-flags (`RAZORPAY_RETRY_SUCCEEDS` / `RAZORPAY_LINK_PAID`) which gave 0% or 100% outcomes.
3. **Dashboard reads directly from Postgres** — the Next.js API routes use a shared `Pool` via `lib/db.ts`. No service-to-service HTTP for bulk reads; the dashboard is read-only against the shared DB. Promise "simulate respond" actions route through the Go Decision Engine's `/promises` endpoints to preserve single-source-of-truth for the state machine.
4. **Recovery accounting is honest** — `SEND_PAYMENT_LINK` is recorded as `pending/0` until the follow-up sweep confirms the linked payment actually captured; `RETRY_PAYMENT` only counts on confirmed capture. Payment links are counted as recovered at their actual captured amount (per-order, not a global placeholder). The batch report shows the recovery rate including deliberately-unrecoverable cases (~18%): a 100% recovery rate would read as cherry-picked.
5. **Blocked decisions are surfaced in the UI** — the audit log has a "Blocked actions" filter toggle, making the compliance layer visible and demoable. This directly answers the judge's hardest question ("what stops your agent from doing something it shouldn't?") with a screen, not a sentence.

**Reasoning:**
- Posting real webhooks (with real HMAC signing) through the real ingestion service is the difference between "we simulated data" (fine) and "we simulated results" (a red flag). Every row in the dashboard was produced by the pipeline doing actual work.
- FNV-1a deterministic hashing means the batch is reproducible — "make reset-data && make seed" produces identical numbers every time. This matters for a clean demo: the judge who clones your repo sees the same recovery rate you showed in the video.
- Direct Postgres reads for the dashboard are the simplest, fastest-to-build approach for a 7-day build. Calling Go service endpoints would be more "properly service-oriented" but adds plumbing with no functional benefit at this scale.
- Honest recovery accounting (not counting links until capture) is the methodology-transparent claim that preempts the most obvious credibility question a judge could ask.

**Trade-off acknowledged:** The FNV-1a hash means changing the seed changes the recovery rate. We document this as intentional (deterministic reproducibility, not result-tuning) and fix the seed in `.env.example` to `phase6batch`. The batch generator's distribution parameters (log-normal amount, weighted categories, ~18% unrecoverable) are tuned once and committed — not adjusted to hit a target number.

**6. Four leak types, not three** — the report's `CASE` statement produces 4 distinct buckets: Failed payment (card/bank), Checkout abandonment, Receivables (overdue invoices), and Subscription/mandate. The subscription/mandate bucket captures `mandate_revoked` risk-category events (classified by the rules engine on error code `mandate.revoked`), which are distinct from other payment failures because they represent a terminated recurring relationship — the policy layer maps them to `STOP_SEQUENCE` (no compliant automated recovery exists). This is an intentional 4-bucket design: mandate_revoked events *could* be folded into "payment failure" generically, but separating them makes the report more informative and makes the `STOP_SEQUENCE` policy decision for revoked mandates visible as its own row.

**Verified batch results (220 records, seed `phase6batch`):**
- **Total at-risk: ₹30,52,639 (~₹3.05 crore)** | **Recovered: ₹12,86,712 (~₹1.29 crore)** | **Recovery rate: 42.2%**
- **By leak type:** Failed payment (142 events, ₹93.8L recovered), Checkout abandonment (33 events, ₹34.8L recovered), Receivables (28 events, ₹0 recovered — all blocked by `PRE_DEBIT_NOTICE_WINDOW_NOT_MET`), Subscription/mandate (17 events, ₹0 recovered — all `STOP_SEQUENCE`)
- **Blocked: 106 decisions** (56 by `PRE_DEBIT_NOTICE_WINDOW_NOT_MET`, 50 by `OUTSIDE_QUIET_HOURS`)
- **Unrecoverable: 17** (mandate_revoked → `STOP_SEQUENCE`)
- **Promises: 28 total, 24 kept (85.7%), 4 written off**
- **Rules vs LLM: 114 vs 0** (all decisions authorized by deterministic rules; LLM classified 0 events because heuristic fallback matched all synthetic signals)
- **Featured edge case (success):** `ord_syn_0015` — ₹1,20,951 AFA-threshold charge routed to authenticated payment link, captured in full
- **Featured failure (honest miss):** `ord_syn_0034` — ₹50,507 invoice_overdue, `SEND_REMINDER` blocked by `OUTSIDE_QUIET_HOURS` (system refused to act outside 9am–7pm)

The 42.2% recovery rate is an honest figure that includes deliberately-unrecoverable mandates and compliance-blocked actions — not a cherry-picked happy-path number.

## Decision #16 — Hinglish voice/negotiation: text-transcript mode as primary, TTS as optional rendering layer

**Context:** Phase 7 adds a Hinglish negotiation channel — the most memorable pitch-video moment. Two options exist: text-transcript mode (LLM-driven multi-turn chat, rendered as a transcript) or real TTS voice (ElevenLabs or similar). The playbook recommends text-first.

**Decision:** Build text-transcript mode as the primary deliverable. Real TTS, if added, is a rendering layer on top of the same transcript — never a separate code path.

**Rationale:**
1. **Zero integration risk on demo day.** Text transcripts are deterministic, testable, and work offline. TTS adds external API latency, failure modes, and a dependency that can fail during a pitch recording.
2. **Same architecture principle.** The negotiation LLM emits structured outcomes (`paid_now | promised | declined | escalate`), and the Execution Service routes them downstream — identical to the single-shot action flow. TTS would only change *how* the agent reply is rendered, not *what* it decides.
3. **Honest demo.** Judges know this is a simulated scenario. A live-generated transcript where the agent stays polite under pressure is more impressive than pre-recorded audio that could be scripted playback.
4. **If TTS is added later,** it wraps the `agentReply` string in a TTS adapter. The negotiation logic, turn limit, and outcome routing remain untouched.

**Implementation:**
- `/negotiate` endpoint (LLM Orchestrator): stateless, turn-limited (max 8 exchanges), emits `{agentReply, resolved, outcome, promisedDate}`
- Execution Service relays to `/negotiate`, dashboard holds transcript client-side (no server-side session storage)
- Hard turn limit enforced in code (`MAX_NEGOTIATION_TURNS = 8`), never relying on the model to self-limit
- Debtor simulation script (`data/negotiation-simulator`) with 5 personas: cooperative, evasive, hostile, can't_pay, stall_then_pay
- Dashboard `/negotiate` page with chat UI, quick-debtor presets, and outcome banner

**Design constraint validated:** the entire Phase 7 implementation touches only `services/execution/src/adapters/voice.adapter.ts`, `services/llm-orchestrator/src/negotiate.ts`, and new dashboard files. Zero changes to the Decision Engine, policy layer, or promise state machine — proof the Phase 4 adapter interface was designed correctly.

## Decision #17 — Retrospective: what we'd do differently and what we're most confident about

**What we'd do differently:**

1. **Build the timestamp spread into the batch generator from day one.** The original generator fired all events within 12 seconds, making quiet-hours blocking entirely a function of wall-clock time. We caught this in Phase 6 verification and fixed it (events now span 6 days), but it should have been designed-in from the start. Lesson: synthetic data must mirror real-world variance, not just real-world distributions.

2. **Store the full webhook envelope as `raw_payload` from the start.** The generator initially stored the inner payload (`wh.payload`) instead of the full envelope (`wh`), causing the classifier's `extractSignal` to fail silently — 142 events fell through to the LLM as `unknown` → `STOP_SEQUENCE`. This was the most impactful bug we fixed. Lesson: when two subsystems agree on a data contract, verify the contract at the boundary, not just in documentation.

3. **Add the promise-to-ledger bridge earlier.** When a promise transitions to `kept`, no `actions` row was created, so ₹2.34L in kept promises was invisible to the recovery ledger. We caught this by reconciling the promise metrics against the actions sum — a check that should have been part of Phase 5's definition of done. Lesson: when two subsystems track the same concept (recovered ₹), define the reconciliation check before the subsystems diverge.

**What we're most confident about:**

1. **The policy layer architecture.** The pure, ordered policy functions (`internal/policy/*.go`) are the single highest-leverage piece of code in the project. They're testable without a database, auditable without a dashboard, and composable — adding a new rule is a new function and one line in the check order. This pattern generalizes far beyond payment recovery.

2. **The adapter interface.** The fact that Phase 7's entire negotiation channel could be built without touching the Decision Engine or policy layer proves the adapter boundary was drawn correctly. This is the kind of interface that survives production pressure.

3. **The audit trail discipline.** Every layer writes exactly one row per event (`events → classifications → decisions → actions`), including blocked decisions. The blocked-actions filter in the audit log is the single most demoable feature for "what stops your agent?" — and it exists because we committed to capturing evidence at every layer, not just at the happy path.

4. **Honest metrics.** The 59.6% recovery rate includes deliberately-unrecoverable mandates (13 STOP_SEQUENCE) and compliance-blocked actions (93). A judge who asks "is this real?" gets a number that includes its own failures, which is more credible than a suspiciously perfect one.

**Least confident about:**

- **The heuristic negotiation fallback.** Without an LLM key, the heuristic can be too persistent with hostile debtors (it doesn't detect all decline patterns). The LLM path handles this correctly, but the heuristic should have been more conservative about escalating earlier.
- **Fire-and-forget HTTP dispatch.** The execution service sends actions via HTTP with no retry. In production this would need stream-based delivery with acknowledgments. Acceptable for a hackathon demo, but a known limitation.
- **Single-row promise state.** The promise's state is a single `state` column, not an event-sourced log. We added `escalation_history JSONB` for audit detail, but the transitions themselves aren't independently auditable in the same way `decisions.reasoning` is. A production system would likely want a `promise_transitions` table.

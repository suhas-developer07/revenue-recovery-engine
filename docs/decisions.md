# Architecture Decisions

> This file logs key trade-offs and design decisions, one per phase. By day 7 it reads like a senior engineer's design log.

## Decision #1 — Why Go + TypeScript, and where the boundary sits

**Date:** Day 1  
**Decision:** Go for services that touch money directly (Ingestion, Decision Engine); TypeScript for services that touch external APIs and the dashboard (Execution, LLM Orchestrator, Dashboard).

**Reasoning:**
- Go's type safety and concurrency model are ideal for the policy layer — deterministic, testable, no runtime surprises when authorizing payment retries.
- TypeScript's ecosystem (Next.js for dashboard, Anthropic SDK for LLM, Razorpay's own TS SDK) makes the execution and orchestration layer faster to build.
- The boundary is clean: Go decides, TypeScript executes. The `action.schema.json` contract enforces this boundary at the data level, not just the architectural-diagram level.

**Trade-off acknowledged:** Running two language ecosystems in one repo adds operational complexity (two build pipelines, two dependency files per service). For a 7-day build, this is acceptable — the clarity of the Go/TS boundary is worth more than the simplicity of a single-language stack.

---

## Decision #2 — Ingestion verifies the raw body, not re-serialized JSON

**Date:** Day 1  
**Decision:** HMAC-SHA256 verification runs against the `[]byte` captured by a single `io.ReadAll(r.Body)` *before* any `json.Unmarshal`. The same bytes are reused for parsing and stored as `raw_payload`.

**Reasoning:**
- HMAC is byte-sensitive — re-marshaling the JSON before verifying would produce a different byte sequence and fail even on genuine Razorpay payloads.
- Reading the body once into a `[]byte` avoids the classic "read the body twice" bug where the second read returns empty.

**Trade-off acknowledged:** We must store the full raw body (could be large) as `raw_payload`, but that's cheap and gives us an immutable audit source for replay/debugging.

---

## Decision #3 — Idempotency via a separate table, checked before insert

**Date:** Day 1  
**Decision:** `processed_webhook_ids` table (keyed on `X-Razorpay-Event-Id`, falling back to `event + sha256(body)`) is checked *before* touching `events`.

**Reasoning:**
- Razorpay's own docs recommend expecting occasional duplicate deliveries (network retries). A pre-check means a duplicate costs one cheap lookup, not a failed insert we'd catch-and-swallow.
- Keeps `events` clean: one row per real event, always — which matters later when the batch-report metrics count rows.
- Returning `200` on a duplicate (rather than an error) prevents Razorpay from entering a retry storm on an event we've already accepted.

**Trade-off acknowledged:** A dedicated table is slightly more code than a unique constraint on `events`, but it avoids littering logs with constraint-violation errors that look like real bugs mid-demo.

---

## Decision #4 — Queue via Redis Streams, with a table-poll fallback

**Date:** Day 1  
**Decision:** The Ingestion service publishes the new event UUID to a single Redis Stream (`new_events`) after a successful insert. Redis publish failure is logged but non-fatal.

**Reasoning:**
- Redis Streams (with `XReadGroup` in later phases) gives the Decision Engine an at-least-once, resumable reading model.
- Making the publish non-fatal (logging rather than erroring out) means a Redis hiccup can't lose a webhook that's already safely persisted — the Decision Engine can always poll `events` as a fallback if we take that path.

**Trade-off acknowledged:** For Phase 1–2 (few services) the queue adds a moving part. We keep it because it's cheap, gives the audit pipeline a real "new event" signal, and is exactly what Phase 3's consumer needs. If it feels like overhead, polling the table is a legitimate documented alternative.

# Pitch Video Script — AI Revenue Recovery
### 5 minutes, tightly timed. Every second planned.

---

## [0:00–0:15] THE NUMBER — Lead with the result

**On screen:** Dashboard overview page, ₹ recovered counter prominently visible.

> "Our AI agent recovered **₹23.16 lakh** of ₹38.85 lakh at risk — that's a **59.6% recovery rate** — across a 220-transaction synthetic batch, with **93 actions correctly refused** by compliance rules. Here's how."

*Don't explain anything yet. Let the number land. This is the hook.*

---

## [0:15–1:00] THE PROBLEM — One breath

**On screen:** Dashboard overview, zoom into the funnel chart.

> "Indian merchants lose revenue in four places: payment failures, checkout abandonment, subscription mandate failures, and overdue B2B invoices. Today each leak is handled by a different tool — or nothing at all. The core challenge isn't just detecting failures — it's closing the loop from detection to compliant recovery without spamming customers or violating RBI rules."

---

## [1:00–2:15] THE LOOP — Detect → Diagnose → Decide → Act

**On screen:** Walk through the pipeline: ingestion → classification → decision → execution.

> "Here's the full loop. A Razorpay webhook arrives — our Go ingestion service verifies the HMAC signature, dedupes, and persists it. The rules engine classifies the root cause — most events match deterministic rules; ambiguous cases fall through to an LLM. The policy layer then decides: should we retry, send a payment link, or stop? Every decision is logged with its full reasoning chain."

**On screen:** The audit log's reasoning trace, expanded.

> "This is a real reasoning trace for one event. The policy checked eight rules in order — mandate revocation, escalation ceiling, max attempts, cooldown, AFA threshold, pre-debit window, quiet hours, opt-out — and authorized a payment link. The trace is stored verbatim, not reconstructed. You can query it for any event."

---

## [2:15–3:15] THE COMPLIANCE STORY — Don't rush this

**On screen:** Audit log with "Blocked actions" filter toggled on.

> "Now here's what makes this different from a retry bot. **93 actions were blocked** by compliance rules. Let me show you one."

**On screen:** Click on a specific blocked row — the OUTSIDE_QUIET_HOURS case.

> "This ₹33,000 invoice reminder was blocked because it was generated at 2 AM. The system refused to contact a debtor outside 9am–7pm. That's not a bug — that's RBI's Fair Practices Code encoded as a testable function. We have eight such rules: AFA threshold, pre-debit window, mandate revocation, max attempts, cooldown, quiet hours, opt-out, and escalation ceiling. Every one is a named Go function with unit tests."

**On screen:** *(Optional — if Phase 7 demo is ready)* Negotiate page with a hostile debtor.

> "Phase 7 adds a Hinglish negotiation channel. Watch what happens when a debtor is rude and refuses to pay. The agent stays polite, tries one more time, and then — after the debtor is clearly hostile — escalates gracefully to a human. No pressure tactics. No indefinite chasing. The turn limit is enforced in code, not by the model."

---

## [3:15–4:00] HONEST RESULTS

**On screen:** Report page with full metrics table.

> "The full batch: 220 events, ₹38.85 lakh at risk. 59.6% recovered — that's both payment link captures and promise-to-pay settlements. 13 events correctly identified as unrecoverable — revoked mandates and risk blocks that the system stopped retrying. 93 actions blocked by compliance."

> "The promise tracker: 33 promises made, 27 kept — that's an 81.8% keeping rate. The four written-off promises are the ones where the debtor never paid after exhausting the escalation ceiling."

> "This isn't a cherry-picked happy path. We deliberately built in unrecoverable cases. The recovery rate is honest."

---

## [4:00–4:30] ARCHITECTURE — 30 seconds

**On screen:** Architecture diagram.

> "Five layers: ingestion, classification, policy, execution, and audit. Go handles the correctness-critical layers — the policy functions that stop an autonomous agent from moving money. TypeScript handles the LLM integration and the dashboard. The key design principle: the LLM proposes, the code disposes. Every money-moving action passes through named, testable policy functions before execution."

---

## [4:30–5:00] CLOSE — What's next, loop back to the number

> "What we'd build next: stream-based retry for execution reliability, real TTS on top of the negotiation transcript, and webhook replay for integration testing."

> "But the core story is simple: **₹23.16 lakh recovered, 93 actions blocked, every decision auditable.** The agent proposes, the code disposes, and here's the receipt."

**On screen:** ₹ recovered counter one more time.

---

## Q&A Preparation

**Question: "What stops your agent from moving money it shouldn't?"**

> "Eight named policy functions in `internal/policy/*.go`. Every action passes through them in order: mandate revocation check, escalation ceiling, max attempts, cooldown, AFA threshold, pre-debit window, quiet hours, and opt-out. Blocked actions are logged as evidence — 93 out of 220 in our batch. The trace is stored verbatim for every decision, including blocked ones. You can verify it in the audit log."

*Say this in under 20 seconds, pointing at the specific file and number.*

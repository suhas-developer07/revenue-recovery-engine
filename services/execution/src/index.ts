import express from "express";
import { RecoveryActionSchema, RecoveryAction } from "./schema/action";
import * as db from "./db/pg";
import { runHandler } from "./handlers";
import { razorpayClient } from "./razorpay/client";

const app = express();
app.use(express.json());

// The send-payment-link amount-recovery follow-up sweep. A created payment link is
// recorded as 'pending' with amount 0; money is only counted once the linked payment
// actually captures. This sweep flips those rows to success + the real amount.
async function paymentLinkFollowUpSweep() {
  try {
    const pending = await db.listPendingPaymentLinks();
    for (const row of pending) {
      const check = await razorpayClient.checkPaymentLinkPayment(row.order_id);
      if (check.paid && check.amount_captured_paise > 0) {
        await db.confirmPaymentLink(row.id, check.amount_captured_paise, {
          kind: "payment_link",
          confirmed_at: new Date().toISOString(),
          razorpay: check,
        });
        console.log(`[execution] payment link confirmed recovered order=${row.order_id} amount=${check.amount_captured_paise}`);
      }
    }
  } catch (err: any) {
    console.error("payment-link sweep failed:", err?.message ?? err);
  }
}

function schedulePaymentLinkSweep() {
  const intervalMs = Number(process.env.PAYMENT_LINK_SWEEP_MS || "15000");
  setInterval(paymentLinkFollowUpSweep, intervalMs).unref();
  // run once shortly after boot too
  setTimeout(paymentLinkFollowUpSweep, 3000).unref();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "execution" });
});

// Execute an authorized recovery action. Re-validates the (Go-produced) action
// against the zod schema INDEPENDENTLY of the Decision Engine's authorization —
// "LLM proposes, code disposes" holds across the Go/TS boundary. It is also
// idempotent on decision_id: a redelivered decision never double-sends.
app.post("/execute", async (req, res) => {
  const raw = req.body ?? {};

  // Inspection: pull the top-level decision metadata (NOT part of the action schema).
  const decisionId = typeof raw.decision_id === "string" ? raw.decision_id : undefined;
  const eventId = typeof raw.event_id === "string" ? raw.event_id : undefined;
  const amountPaise =
    typeof raw.amount_paise === "number" && Number.isFinite(raw.amount_paise) ? raw.amount_paise : 0;

  const parsed = RecoveryActionSchema.safeParse(raw);
  if (!parsed.success) {
    // Refuse — never attempt to "fix" or partially execute a malformed action.
    // This is cross-boundary evidence the guardrails work.
    console.error("[execution] REJECTED invalid action", JSON.stringify(raw), parsed.error.issues);
    res.status(400).json({ error: "invalid action", details: parsed.error });
    return;
  }

  const action: RecoveryAction = parsed.data;

  if (!decisionId) {
    res.status(400).json({ error: "decision_id is required to correlate execution" });
    return;
  }

  try {
    // Idempotency: if this decision already executed, return the stored result
    // instead of double-sending a payment link or double-attempting a retry.
    const existing = await db.getActionByDecisionId(decisionId);
    if (existing) {
      console.log(`[execution] action already executed, skipping decision=${decisionId}`);
      res.json({ status: "deduplicated", action: action.action, existing });
      return;
    }

    const outcome = await runHandler({ decision_id: decisionId, event_id: eventId!, amount_paise: amountPaise, action });

    // Every handler writes exactly one actions row; UNIQUE(decision_id) backs it up.
    const row = await db.insertAction({
      decision_id: decisionId,
      status: outcome.status,
      amount_recovered_paise: outcome.amount_recovered_paise,
      outcome_payload: outcome.outcome_payload,
    });

    console.log(
      `[execution] recorded action decision=${decisionId} action=${action.action} status=${outcome.status} recovered=${outcome.amount_recovered_paise}`,
    );
    res.json({ status: outcome.status, action: action.action, recovered_paise: outcome.amount_recovered_paise, row });
  } catch (err: any) {
    console.error("[execution] handler error:", err?.message ?? err);
    res.status(500).json({ error: "execution failed", detail: String(err?.message ?? err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`execution service listening on :${PORT}`);
  schedulePaymentLinkSweep();
});

process.on("SIGTERM", async () => {
  await db.close();
  process.exit(0);
});

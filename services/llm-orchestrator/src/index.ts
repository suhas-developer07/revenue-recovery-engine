import express from "express";

import { classifyEvent } from "./classify";
import { draftMessage } from "./draft";
import { negotiate, NegotiateRequest } from "./negotiate";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "llm-orchestrator" });
});

//LLM classification fallback for the Decision Engine's rules engine.
// Input: event_type + compact signal text. Output: a valid, enum-constrained
// risk_category + narrative + confidence. Falls back to a deterministic heuristic
// when no GROQ_API_KEY is configured.
app.post("/classify", async (req, res) => {
  const { event_type, signal } = req.body ?? {};
  if (typeof event_type !== "string" || typeof signal !== "string") {
    res.status(400).json({ error: "event_type and signal are required" });
    return;
  }

  try {
    const result = await classifyEvent({ event_type, signal });
    res.json(result);
  } catch (err: any) {
    console.error("classify error:", err);
    res.status(500).json({ error: "classification failed" });
  }
});

// LLM message drafting for an ALREADY-AUTHORIZED, ALREADY-TARGETED
// customer-facing action. The LLM only words the message; it never decides whether
// or who to contact. Tight input, tight output, heuristic fallback without a key.
app.post("/draft", async (req, res) => {
  const { risk_category, root_cause_narrative, amount_paise, channel, attempt_number } = req.body ?? {};
  if (
    typeof risk_category !== "string" ||
    typeof root_cause_narrative !== "string" ||
    typeof amount_paise !== "number"
  ) {
    res.status(400).json({ error: "risk_category, root_cause_narrative and amount_paise are required" });
    return;
  }

  try {
    const result = await draftMessage({
      risk_category,
      root_cause_narrative,
      amount_paise,
      channel: typeof channel === "string" ? channel : "email",
      attempt_number: typeof attempt_number === "number" ? attempt_number : 1,
    });
    res.json(result);
  } catch (err: any) {
    console.error("draft error:", err);
    res.status(500).json({ error: "draft failed" });
  }
});

// /negotiate. Stateless multi-turn negotiation endpoint.
// All context comes in on every call — no server-side session storage.
// The LLM converses in Hinglish and emits a structured outcome that
// the Execution Service routes downstream.
app.post("/negotiate", async (req, res) => {
  const { sessionContext, transcript, debtorMessage } = req.body ?? {};

  if (
    !sessionContext ||
    typeof sessionContext.customerId !== "string" ||
    typeof sessionContext.orderId !== "string" ||
    typeof sessionContext.amountPaise !== "number"
  ) {
    res.status(400).json({
      error: "sessionContext with customerId, orderId, and amountPaise is required",
    });
    return;
  }

  const negotiateReq: NegotiateRequest = {
    sessionContext: {
      customerId: sessionContext.customerId,
      orderId: sessionContext.orderId,
      amountPaise: sessionContext.amountPaise,
      rootCauseNarrative: sessionContext.rootCauseNarrative ?? "",
      escalationCount: sessionContext.escalationCount ?? 0,
    },
    transcript: Array.isArray(transcript) ? transcript : [],
    debtorMessage: typeof debtorMessage === "string" ? debtorMessage : "",
  };

  try {
    const result = await negotiate(negotiateReq);
    res.json(result);
  } catch (err: any) {
    console.error("negotiate error:", err);
    res.status(500).json({ error: "negotiation failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`llm-orchestrator service listening on :${PORT}`);
});

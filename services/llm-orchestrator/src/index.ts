import express from "express";

import { classifyEvent } from "./classify";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "llm-orchestrator" });
});

// Phase 2 — LLM classification fallback for the Decision Engine's rules engine.
// Input: event_type + compact signal text. Output: a valid, enum-constrained
// risk_category + narrative + confidence. Falls back to a deterministic heuristic
// when no ANTHROPIC_API_KEY is configured.
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

app.post("/draft", (_req, res) => {
  // TODO: Phase 4 — LLM message drafting
  res.json({ message: "TODO: draft message based on classification" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`llm-orchestrator service listening on :${PORT}`);
});

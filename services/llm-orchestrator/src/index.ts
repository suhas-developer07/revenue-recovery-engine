import express from "express";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "llm-orchestrator" });
});

app.post("/classify", (req, res) => {
  // TODO: Phase 2 — LLM classification fallback
  res.json({ category: "unknown", classified_by: "pending" });
});

app.post("/draft", (req, res) => {
  // TODO: Phase 4 — LLM message drafting
  res.json({ message: "TODO: draft message based on classification" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`llm-orchestrator service listening on :${PORT}`);
});

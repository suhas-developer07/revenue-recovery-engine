import express from "express";
import { RecoveryActionSchema } from "./schema/action";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "execution" });
});

app.post("/execute", (req, res) => {
  const parsed = RecoveryActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid action", details: parsed.error });
    return;
  }

  const action = parsed.data;
  console.log(`[execution] dispatching action=${action.action} channel=${action.channel}`);

  // TODO: Phase 4 — dispatch to channel adapters (SMS, email, WhatsApp, Razorpay API)
  res.json({ status: "dispatched", action: action.action, channel: action.channel });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`execution service listening on :${PORT}`);
});

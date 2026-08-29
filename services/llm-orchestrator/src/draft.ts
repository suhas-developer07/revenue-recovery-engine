import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Phase 4 — /draft. Generates message copy for an ALREADY-AUTHORIZED,
 * ALREADY-TARGETED customer-facing action. The LLM's only job is wording; it never
 * decides whether/who to contact. Same discipline as /classify (Phase 2): tight
 * input, tight output, deterministic heuristic fallback when no LLM key exists.
 */

export type DraftRequest = {
  risk_category: string;
  root_cause_narrative: string;
  amount_paise: number;
  channel: string;
  attempt_number: number;
};

const draftSchema = z.object({ message: z.string().min(1).max(700) });

const SYSTEM_PROMPT = `You are the message copywriter for an Indian fintech's revenue-recovery assistant.
Given the failure root cause and context for an already-authorized recovery action, write ONE short,
friendly, specific message body for the customer.

Rules:
- Respond with raw JSON only: {"message": "<the copy>"}.
- Reference the actual root cause (e.g. "looks like your bank declined this — worth checking your balance")
  rather than generic "your payment failed" copy.
- Include a clear next step (retry, use the payment link, or update card).
- Respect the channel: keep SMS/WhatsApp short (≤160 chars), email may be a bit longer.
- Never be threatening or legalistic. Keep it warm and action-oriented.
- Use Indian rupees formatting (₹) when mentioning amounts.`;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Deterministic heuristic fallback when no ANTHROPIC_API_KEY is configured. Produces
// genuinely root-cause-sensitive copy (the "obviously not templated" bar in the
// execution plan) so the pipeline stays testable without burning LLM calls.
export function heuristicDraft(req: DraftRequest): string {
  const amount = `₹${(req.amount_paise / 100).toFixed(2)}`;

  const nextStep =
    req.risk_category === "expired_card" || req.risk_category === "risk_block"
      ? "please add a fresh card to complete your payment"
      : req.risk_category === "otp_failure"
        ? "please re-try once with a fresh OTP when you're ready"
        : req.risk_category === "checkout_abandoned" || req.risk_category === "invoice_overdue"
          ? "your secure payment link is ready below"
          : "please try the payment again when you're able";

  const root = req.root_cause_narrative
    ? req.root_cause_narrative.trim()
    : "your recent payment didn't go through";

  const attemptLine = req.attempt_number > 1 ? ` (attempt ${req.attempt_number})` : "";
  return `Hi — ${root}. A ${amount} payment to us is still pending${attemptLine}. To keep your account current, ${nextStep}.`;
}

/**
 * Drafts a message. Tries the LLM first; falls back to the deterministic heuristic
 * when the LLM is unavailable or its output fails validation.
 */
export async function draftMessage(req: DraftRequest): Promise<{ message: string; source: "llm" | "heuristic" }> {
  if (!anthropic) {
    return { message: heuristicDraft(req), source: "heuristic" };
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `risk_category: ${req.risk_category}
root_cause_narrative: ${req.root_cause_narrative}
amount_paise: ${req.amount_paise}
channel: ${req.channel}
attempt_number: ${req.attempt_number}
\nRespond with JSON: {"message": "..."}`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();

    const parsed = draftSchema.safeParse(JSON.parse(text.trim()));
    if (parsed.success) {
      return { message: parsed.data.message, source: "llm" };
    }
    console.warn("LLM draft output failed validation, falling back to heuristic", parsed.error.issues);
    return { message: heuristicDraft(req), source: "heuristic" };
  } catch (err: any) {
    console.warn("LLM draft failed, falling back to heuristic:", err?.message);
    return { message: heuristicDraft(req), source: "heuristic" };
  }
}

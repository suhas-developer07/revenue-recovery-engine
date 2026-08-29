import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Closed set of risk categories. Must mirror the Go rules table exactly — the
 * model is instructed to pick from these ONLY, and the returned value is
 * validated against this enum before being trusted. An unvalidated LLM string
 * must never reach the risk_category column.
 */
export const RISK_CATEGORIES = [
  "insufficient_funds",
  "bank_timeout",
  "expired_card",
  "otp_failure",
  "risk_block",
  "mandate_revoked",
  "checkout_abandoned",
  "invoice_overdue",
  "unknown",
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];

const classifySchema = z.object({
  category: z.enum(RISK_CATEGORIES),
  narrative: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
});

export type ClassifyRequest = {
  event_type: string;
  signal: string;
};

export type ClassifyResult = {
  category: RiskCategory;
  narrative: string;
  confidence: number;
  source: "llm" | "heuristic";
};

const SYSTEM_PROMPT = `You are a payment-failure root-cause classifier for an Indian fintech (Razorpay).
You will be given a description of a failed payment event and must classify it into EXACTLY ONE of these categories:

${RISK_CATEGORIES.join(", ")}

Rules:
- Respond with raw JSON only, no markdown, no prose.
- Pick from the provided list ONLY. Never invent a new category.
- "unknown" is the last resort when nothing clearly matches.
- Keep narrative to one short sentence explaining the likely root cause.`;

/**
 * Deterministic heuristic fallback used when no ANTHROPIC_API_KEY is configured
 * (or the API call fails). Mirrors the Go rules table with a small keyword map.
 * This keeps the classification pipeline fully testable without burning LLM
 * calls, while still demonstrating the "rules dominate, LLM for the remainder"
 * split.
 */
const KEYWORD_MAP: [RegExp, RiskCategory][] = [
  [/insufficient|balance/i, "insufficient_funds"],
  [/timeout|gateway|unavailable/i, "bank_timeout"],
  [/expired/i, "expired_card"],
  [/otp|3ds|3d secure|authentication|verification/i, "otp_failure"],
  [/fraud|risk|blocked|suspicious/i, "risk_block"],
  [/mandate|revok|cancel.*subscription/i, "mandate_revoked"],
  [/abandon/i, "checkout_abandoned"],
  [/overdue|invoice.due|past due/i, "invoice_overdue"],
];

export function heuristicClassify(req: ClassifyRequest): ClassifyResult {
  const signal = `${req.event_type} ${req.signal}`;
  for (const [re, category] of KEYWORD_MAP) {
    if (re.test(signal)) {
      return {
        category,
        narrative: `Heuristic match on "${re}" (no LLM key configured)`,
        confidence: 0.5,
        source: "heuristic",
      };
    }
  }
  return {
    category: "unknown",
    narrative: "No heuristic match; no LLM key configured to disambiguate",
    confidence: 0.2,
    source: "heuristic",
  };
}

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/**
 * Classifies an ambiguous event. Tries the LLM first; if the LLM is unavailable
 * or its output fails enum validation, falls back to the deterministic heuristic
 * and finally "unknown". The category is ALWAYS one of RISK_CATEGORIES.
 */
export async function classifyEvent(req: ClassifyRequest): Promise<ClassifyResult> {
  if (!anthropic) {
    return heuristicClassify(req);
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `event_type: ${req.event_type}\nsignal: ${req.signal}
\nRespond with JSON: {"category": "...", "narrative": "...", "confidence": 0.0-1.0}`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();

    const parsed = classifySchema.safeParse(JSON.parse(text.trim()));
    if (parsed.success) {
      return {
        category: parsed.data.category,
        narrative: parsed.data.narrative,
        confidence: parsed.data.confidence,
        source: "llm",
      };
    }
    console.warn("LLM output failed enum validation, falling back to heuristic", parsed.error.issues);
    return heuristicClassify(req);
  } catch (err: any) {
    console.warn("LLM classify failed, falling back to heuristic:", err.message);
    return heuristicClassify(req);
  }
}

import { Adapter } from "./adapter.interface";

/**
    Voice/Negotiation Adapter.
 *
 * Unlike the other adapters (SMS, Email, WhatsApp) which send a single message,
 * the VoiceAdapter orchestrates a full multi-turn negotiation via the LLM
 * Orchestrator's /negotiate endpoint. It follows the same Adapter interface
 * for compatibility with the existing dispatch pipeline, but internally manages
 * the conversation loop.
 *
 * Design: the negotiation is STATELESS from the server's perspective — the
 * dashboard holds the transcript client-side and resends it each turn. This
 * adapter just forwards each turn to /negotiate and returns the result.
 *
 * When a terminal outcome is reached (paid_now, promised, declined, escalate),
 * the DASHBOARD is responsible for routing it to the appropriate downstream
 * endpoint (e.g., POST /promises for "promised"). This adapter does NOT write
 * to the database directly — "LLM proposes, code disposes" holds here too.
 */

const LLM_ORCHESTRATOR_URL = process.env.LLM_ORCHESTRATOR_URL || "http://localhost:8084";

export type TranscriptTurn = {
  role: "agent" | "debtor";
  text: string;
};

export type NegotiateSessionContext = {
  customerId: string;
  orderId: string;
  amountPaise: number;
  rootCauseNarrative: string;
  escalationCount: number;
};

export type NegotiateResult = {
  agentReply: string;
  resolved: boolean;
  outcome?: "paid_now" | "promised" | "declined" | "escalate";
  promisedDate?: string;
  turnNumber: number;
  maxTurns: number;
};

/**
 * Send one turn of a negotiation to the LLM Orchestrator.
 *
 * @param context — customer/order context for the negotiation
 * @param transcript — the full conversation history so far
 * @param debtorMessage — the debtor's latest message ("" for opening line)
 * @returns the agent's reply and whether the conversation resolved
 */
export async function negotiateTurn(
  context: NegotiateSessionContext,
  transcript: TranscriptTurn[],
  debtorMessage: string,
): Promise<NegotiateResult> {
  const resp = await fetch(`${LLM_ORCHESTRATOR_URL}/negotiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionContext: context,
      transcript,
      debtorMessage,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`/negotiate failed: ${resp.status} ${text}`);
  }

  return resp.json() as Promise<NegotiateResult>;
}

/**
 * Implements the Adapter interface for compatibility with the dispatch pipeline.
 * The `message` field is used as the negotiation context (JSON-encoded).
 * For single-shot voice reminders (non-negotiation), this delegates to the
 * SMS adapter's pattern — just logs the message. Real negotiation goes through
 * negotiateTurn() directly from the dashboard API route.
 */
export class VoiceAdapter implements Adapter {
  async send(params: { to: string; message: string; metadata?: Record<string, unknown> }) {
    // For the standard Adapter.send() path (single-shot reminders),
    // log the voice message. Actual negotiation bypasses this via negotiateTurn().
    console.log(`[VOICE] to=${params.to} message=${params.message}`);
    return { success: true, messageId: `voice-stub-${Date.now()}` };
  }
}

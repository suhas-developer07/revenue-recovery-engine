import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 *  /negotiate. A stateless, turn-limited multi-turn negotiation
 * endpoint. The LLM converses in Hinglish to collect either immediate payment
 * or a promised payment date. It NEVER writes to the database — its only output
 * is a structured outcome object that the Execution Service routes downstream.
 *
 * The same "LLM proposes, code disposes" principle applies: the model generates
 * natural language AND a structured outcome guess, but the Execution Service
 * validates the outcome before acting on it.
 */

export type TranscriptTurn = {
  role: "agent" | "debtor";
  text: string;
};

export type NegotiateRequest = {
  sessionContext: {
    customerId: string;
    orderId: string;
    amountPaise: number;
    rootCauseNarrative: string;
    escalationCount: number;
  };
  transcript: TranscriptTurn[];
  debtorMessage: string; // latest turn, or "" to get the opening line
};

export type NegotiateResponse = {
  agentReply: string;
  resolved: boolean;
  outcome?: "paid_now" | "promised" | "declined" | "escalate";
  promisedDate?: string; // ISO date, only if outcome === "promised"
  turnNumber: number;
  maxTurns: number;
};

export const MAX_NEGOTIATION_TURNS = 8;

const outcomeSchema = z.object({
  outcome: z.enum(["paid_now", "promised", "declined", "escalate"]),
  promisedDate: z.string().optional(),
});

/**
 * Deterministic heuristic negotiation — used when no ANTHROPIC_API_KEY is set.
 * Plays a scripted 3-turn negotiation that ends in "promised" with a date.
 */
export function heuristicNegotiate(req: NegotiateRequest): NegotiateResponse {
  const amount = `₹${(req.sessionContext.amountPaise / 100).toLocaleString("en-IN")}`;
  const turns = req.transcript.length;
  const turnNumber = Math.floor(turns / 2) + 1;

  // Turn limit check
  if (turnNumber > MAX_NEGOTIATION_TURNS) {
    return {
      agentReply: "I understand this is difficult. Let me connect you with our team for further assistance. Thank you for your time.",
      resolved: true,
      outcome: "escalate",
      turnNumber,
      maxTurns: MAX_NEGOTIATION_TURNS,
    };
  }

  // Opening line
  if (turns === 0) {
    return {
      agentReply: `Namaste! Baat ho rahi hai ${amount} ke pending payment ki. Yeh aapka ${req.sessionContext.rootCauseNarrative} se related hai. Kya aap abhi payment kar sakte hain ya koi date fix kar sakte hain?`,
      resolved: false,
      turnNumber,
      maxTurns: MAX_NEGOTIATION_TURNS,
    };
  }

  // Check both the latest debtorMessage AND the last transcript entry
  const lastDebtorMsg = (
    req.debtorMessage || req.transcript[turns - 1]?.text || ""
  ).toLowerCase();

  // Check if debtor already offered to pay now
  if (lastDebtorMsg.includes("pay now") || lastDebtorMsg.includes("kar deta") || lastDebtorMsg.includes("abhi kar")) {
    return {
      agentReply: `Bahut achha! Aapka payment ${amount} ka link bhej rahe hain. Jaise hi aap pay karenge, sab sorted ho jayega. Dhanyavaad!`,
      resolved: true,
      outcome: "paid_now",
      turnNumber,
      maxTurns: MAX_NEGOTIATION_TURNS,
    };
  }

  // Check if debtor clearly declined
  if (
    lastDebtorMsg.includes("can't pay") ||
    lastDebtorMsg.includes("nahi kar") ||
    lastDebtorMsg.includes("nahi dunga") ||
    lastDebtorMsg.includes("kabhi nahi") ||
    lastDebtorMsg.includes("block karo") ||
    lastDebtorMsg.includes("impossible")
  ) {
    return {
      agentReply: "Koi baat nahi, main samajh sakta hoon. Main aapke case ko hamare team ke paas forward kar deta hoon jo aapko aur better assist kar sakenge. Thank you for your time.",
      resolved: true,
      outcome: "escalate",
      turnNumber,
      maxTurns: MAX_NEGOTIATION_TURNS,
    };
  }

  // Check for a date promise from debtor
  if (lastDebtorMsg.includes("next week") || lastDebtorMsg.includes("friday") || lastDebtorMsg.includes("15 ") || lastDebtorMsg.includes("date")) {
    return {
      agentReply: `Theek hai, ${amount} ka payment aapne promise kiya hai. Agar date tak payment nahi hota toh hum ek reminder bhejenge. Aapka cooperation ke liye dhanyavaad!`,
      resolved: true,
      outcome: "promised",
      promisedDate: "2026-09-15",
      turnNumber,
      maxTurns: MAX_NEGOTIATION_TURNS,
    };
  }

  // Follow-up based on escalation count
  if (req.sessionContext.escalationCount === 0) {
    return {
      agentReply: `Samajh sakta hoon. Lekin ${amount} ka payment pending hai aur yeh aapke account ke liye important hai. Kya aap ek specific date bata sakte hain jab tak yeh sort ho jayega?`,
      resolved: false,
      turnNumber,
      maxTurns: MAX_NEGOTIATION_TURNS,
    };
  }

  return {
    agentReply: `Yeh aapka ${req.sessionContext.escalationCount + 1} follow-up hai. Hum aapko方便 dena chahte hain — kya aap ek specific date bata sakte hain? Agar nahi toh hum aapke case ko escalate kar denge.`,
    resolved: false,
    turnNumber,
    maxTurns: MAX_NEGOTIATION_TURNS,
  };
}

const SYSTEM_PROMPT = `You are a friendly, respectful payment recovery agent for an Indian fintech company (Razorpay).
You are having a conversation with a debtor to collect a pending payment.

CRITICAL RULES:
1. Speak in natural Hinglish (Hindi-English code-switching, NOT translated English).
2. Your ONLY goal is to collect payment now or get a specific promised date.
3. Never be threatening, legalistic, or aggressive. Stay warm and understanding.
4. If the debtor says "I can't pay" or clearly refuses, accept gracefully and escalate.
5. Always offer a graceful exit — "I understand, let me connect you with our team."
6. Accept "I need to check and get back to you" as a valid non-refusal.
7. Maximum 8 exchanges — after that, end gracefully.

OUTPUT FORMAT:
After each reply, include a structured outcome guess as JSON on a NEW LINE after your reply:
{"outcome": "paid_now|promised|declined|escalate", "promisedDate": "ISO date if promised"}

The outcome is your best guess at the conversation state. The system will validate it.
- "paid_now": debtor committed to paying right now
- "promised": debtor gave a specific future date
- "declined": debtor clearly said they won't/can't pay
- "escalate": conversation exhausted or debtor unresponsive — hand to human

Always output your reply FIRST, then the JSON on the next line.`;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/**
 * Core negotiation logic. Stateless — all context comes in on every call.
 * Enforces hard turn limit in code, never relies on the model to self-limit.
 */
export async function negotiate(req: NegotiateRequest): Promise<NegotiateResponse> {
  const turns = req.transcript.length;
  const turnNumber = Math.floor(turns / 2) + 1;

  // HARD turn limit — enforced in code, not by the model
  if (turnNumber > MAX_NEGOTIATION_TURNS) {
    return {
      agentReply:
        "I understand this is difficult. Let me connect you with our senior team who can help you further. Thank you for your time — we'll be in touch.",
      resolved: true,
      outcome: "escalate",
      turnNumber,
      maxTurns: MAX_NEGOTIATION_TURNS,
    };
  }

  if (!anthropic) {
    return heuristicNegotiate(req);
  }

  const amount = `₹${(req.sessionContext.amountPaise / 100).toLocaleString("en-IN")}`;
  const remainingTurns = MAX_NEGOTIATION_TURNS - turnNumber;

  // Build the message history for the LLM
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  // System context as the first user message
  const contextMsg = [
    `DEBTOR CONTEXT:`,
    `- Order: ${req.sessionContext.orderId}`,
    `- Amount pending: ${amount}`,
    `- Root cause: ${req.sessionContext.rootCauseNarrative}`,
    `- Escalation attempts so far: ${req.sessionContext.escalationCount}`,
    `- You have ${remainingTurns} exchanges remaining before forced escalation.`,
    ``,
    `Transcript so far:`,
    ...req.transcript.map((t) => `${t.role === "agent" ? "Agent" : "Debtor"}: ${t.text}`),
    ``,
    req.debtorMessage
      ? `Debtor's latest message: "${req.debtorMessage}"`
      : `Generate your opening line to start the negotiation.`,
  ].join("\n");

  messages.push({ role: "user", content: contextMsg });

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages,
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();

    // Parse the reply and structured outcome
    // The reply is everything before the last JSON line
    const lines = text.split("\n");
    let agentReply = "";
    let outcomeGuess: { outcome: string; promisedDate?: string } | null = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed);
          const validated = outcomeSchema.safeParse(parsed);
          if (validated.success) {
            outcomeGuess = validated.data;
            agentReply = lines.slice(0, i).join("\n").trim();
            break;
          }
        } catch {
          // Not valid JSON, treat as part of reply
        }
      }
    }

    if (!agentReply) agentReply = text;
    if (!outcomeGuess) {
      outcomeGuess = { outcome: "escalate" };
    }

    return {
      agentReply,
      resolved: true,
      outcome: outcomeGuess.outcome as NegotiateResponse["outcome"],
      promisedDate: outcomeGuess.promisedDate,
      turnNumber,
      maxTurns: MAX_NEGOTIATION_TURNS,
    };
  } catch (err: any) {
    console.warn("LLM negotiate failed, falling back to heuristic:", err?.message);
    return heuristicNegotiate(req);
  }
}

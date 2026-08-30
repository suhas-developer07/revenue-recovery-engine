import { NextResponse } from "next/server";

/**
 * Phase 7 — /api/negotiate. Dashboard BFF that proxies negotiation turns
 * to the Execution Service → LLM Orchestrator chain. Stateless — the full
 * transcript is sent on every call.
 *
 * On terminal outcomes ("promised"), the dashboard also calls the Decision
 * Engine's /promises endpoint to register the promise in the state machine —
 * the same path the batch pipeline uses. This keeps the negotiation outcome
 * flowing through the same subsystem as every other promise in the system.
 */

export const dynamic = "force-dynamic";

const EXECUTION_URL = process.env.EXECUTION_URL || "http://localhost:8083";
const DECISION_ENGINE_URL = process.env.DECISION_ENGINE_URL || "http://localhost:8082";

type TranscriptTurn = { role: "agent" | "debtor"; text: string };

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { sessionContext, transcript, debtorMessage, eventId } = body as {
    sessionContext?: {
      customerId: string;
      orderId: string;
      amountPaise: number;
      rootCauseNarrative: string;
      escalationCount: number;
    };
    transcript?: TranscriptTurn[];
    debtorMessage?: string;
    eventId?: string;
  };

  if (!sessionContext || typeof sessionContext.customerId !== "string" || typeof sessionContext.orderId !== "string") {
    return NextResponse.json({ error: "sessionContext with customerId and orderId is required" }, { status: 400 });
  }

  try {
    // Forward to execution service's /negotiate
    const resp = await fetch(`${EXECUTION_URL}/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionContext, transcript: transcript ?? [], debtorMessage: debtorMessage ?? "" }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return NextResponse.json({ error: `execution negotiate failed: ${resp.status} ${text}` }, { status: 502 });
    }

    const result = (await resp.json()) as {
      agentReply: string;
      resolved: boolean;
      outcome?: string;
      promisedDate?: string;
      turnNumber: number;
      maxTurns: number;
    };

    // If the negotiation resolved with "promised", register the promise
    // in the Decision Engine's state machine — same path as the batch pipeline.
    if (result.resolved && result.outcome === "promised" && eventId) {
      try {
        const promiseResp = await fetch(`${DECISION_ENGINE_URL}/promises`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event_id: eventId }),
        });

        if (promiseResp.ok) {
          const promiseData = (await promiseResp.json()) as { id?: string };
          // Advance the promise to "promised" state with the date
          if (promiseData.id && result.promisedDate) {
            await fetch(`${DECISION_ENGINE_URL}/promises/${promiseData.id}/respond`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ promised_date: result.promisedDate }),
            });
          }
          result.outcome = "promised";
        }
      } catch (err: any) {
        console.warn("promise registration failed after negotiation:", err?.message);
      }
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}

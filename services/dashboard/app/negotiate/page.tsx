"use client";

import { useCallback, useState } from "react";

/**
 * Phase 7 — Negotiation Chat UI.
 *
 * A conversational interface where the agent (LLM) negotiates with a debtor
 * in Hinglish. The dashboard holds the transcript client-side and resends
 * it on every turn — no server-side session storage.
 *
 * The "Start Negotiation" button on the Promise Tracker page links here
 * with query params pre-filled from the invoice context.
 */

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

type TranscriptTurn = { role: "agent" | "debtor"; text: string };

type NegotiateResponse = {
  agentReply: string;
  resolved: boolean;
  outcome?: "paid_now" | "promised" | "declined" | "escalate";
  promisedDate?: string;
  turnNumber: number;
  maxTurns: number;
};

type Props = {
  searchParams: {
    orderId?: string;
    customerId?: string;
    amountPaise?: string;
    rootCause?: string;
    escalationCount?: string;
    eventId?: string;
  };
};

export default function NegotiatePage({ searchParams }: Props) {
  const orderId = searchParams.orderId ?? "";
  const customerId = searchParams.customerId ?? "";
  const amountPaise = Number(searchParams.amountPaise ?? "0");
  const rootCause = searchParams.rootCause ?? "pending payment";
  const escalationCount = Number(searchParams.escalationCount ?? "0");
  const eventId = searchParams.eventId ?? "";

  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<NegotiateResponse | null>(null);
  const [started, setStarted] = useState(false);

  const sendTurn = useCallback(
    async (debtorMsg: string) => {
      setLoading(true);
      try {
        const resp = await fetch("/api/negotiate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionContext: {
              customerId,
              orderId,
              amountPaise,
              rootCauseNarrative: rootCause,
              escalationCount,
            },
            transcript,
            debtorMessage: debtorMsg,
            eventId,
          }),
        });
        const data = (await resp.json()) as NegotiateResponse;

        // Add both turns to transcript
        if (debtorMsg) {
          setTranscript((prev) => [...prev, { role: "debtor", text: debtorMsg }]);
        }
        setTranscript((prev) => [...prev, { role: "agent", text: data.agentReply }]);

        if (data.resolved) {
          setOutcome(data);
        }
      } catch (err: any) {
        setTranscript((prev) => [
          ...prev,
          { role: "agent", text: `[System error: ${err?.message ?? "unknown"}]` },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [transcript, customerId, orderId, amountPaise, rootCause, escalationCount, eventId],
  );

  const handleStart = () => {
    setStarted(true);
    sendTurn("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading || outcome) return;
    sendTurn(input.trim());
    setInput("");
  };

  const OUTCOME_LABEL: Record<string, { label: string; color: string }> = {
    paid_now: { label: "💰 Paid Now", color: "#16a34a" },
    promised: { label: "📅 Promise to Pay", color: "#2563eb" },
    declined: { label: "❌ Declined", color: "#dc2626" },
    escalate: { label: "🔄 Escalated to Human", color: "#d97706" },
  };

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <h1>Hinglish Negotiation</h1>

      {/* Invoice context header */}
      <div
        style={{
          padding: "1rem",
          background: "#f8f8f8",
          borderRadius: "10px",
          marginBottom: "1.5rem",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0.5rem",
          fontSize: "0.9rem",
        }}
      >
        <div><strong>Order:</strong> {orderId}</div>
        <div><strong>Amount:</strong> {inr.format(amountPaise)}</div>
        <div><strong>Root cause:</strong> {rootCause}</div>
        <div><strong>Escalation #:</strong> {escalationCount}</div>
      </div>

      {/* Chat transcript */}
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: "10px",
          padding: "1rem",
          minHeight: 300,
          maxHeight: 500,
          overflowY: "auto",
          background: "#fff",
          marginBottom: "1rem",
        }}
      >
        {!started && (
          <div style={{ textAlign: "center", color: "#888", padding: "3rem 0" }}>
            <p>Click below to start the negotiation conversation.</p>
            <button
              onClick={handleStart}
              style={{
                padding: "0.6rem 1.5rem",
                borderRadius: "8px",
                border: "none",
                background: "#2563eb",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
                fontSize: "0.95rem",
              }}
            >
              Start Negotiation
            </button>
          </div>
        )}

        {transcript.map((turn, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: turn.role === "agent" ? "flex-start" : "flex-end",
              marginBottom: "0.75rem",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "0.6rem 1rem",
                borderRadius: "12px",
                background: turn.role === "agent" ? "#f0f4ff" : "#dcfce7",
                fontSize: "0.9rem",
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontSize: "0.75rem", color: "#888", marginBottom: "0.2rem" }}>
                {turn.role === "agent" ? "🤖 Agent" : "👤 Debtor"}
              </div>
              {turn.text}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ textAlign: "center", color: "#888", padding: "0.5rem" }}>
            Agent is typing...
          </div>
        )}
      </div>

      {/* Outcome banner */}
      {outcome && (
        <div
          style={{
            padding: "1rem",
            borderRadius: "10px",
            background: "#f8f8f8",
            border: `2px solid ${OUTCOME_LABEL[outcome.outcome ?? "escalate"]?.color ?? "#ccc"}`,
            marginBottom: "1rem",
          }}
        >
          <div style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "0.3rem" }}>
            {OUTCOME_LABEL[outcome.outcome ?? "escalate"]?.label ?? "Unknown"}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#666" }}>
            {outcome.outcome === "promised" && outcome.promisedDate && (
              <>Promised payment date: <strong>{outcome.promisedDate}</strong></>
            )}
            {outcome.outcome === "paid_now" && <>Debtor committed to paying immediately.</>}
            {outcome.outcome === "declined" && <>Debtor declined to pay. Routed to human review.</>}
            {outcome.outcome === "escalate" && <>Conversation exhausted. Escalated to human team.</>}
          </div>
          <div style={{ fontSize: "0.8rem", color: "#888", marginTop: "0.3rem" }}>
            Turn {outcome.turnNumber} of {outcome.maxTurns}
          </div>
        </div>
      )}

      {/* Input */}
      {started && !outcome && (
        <form onSubmit={handleSubmit} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type as the debtor... (Hinglish welcome)"
            disabled={loading}
            style={{
              flex: 1,
              padding: "0.6rem 1rem",
              borderRadius: "8px",
              border: "1px solid #ccc",
              fontSize: "0.9rem",
            }}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            style={{
              padding: "0.6rem 1.2rem",
              borderRadius: "8px",
              border: "none",
              background: loading ? "#ccc" : "#2563eb",
              color: "#fff",
              fontWeight: 600,
              cursor: loading ? "default" : "pointer",
            }}
          >
            Send
          </button>
        </form>
      )}

      {/* Quick debtor presets */}
      {started && !outcome && !loading && (
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {[
            { label: "Cooperative", msg: "Haan bhaiya, abhi kar deta hoon payment." },
            { label: "Evasive", msg: "Haan next week kar dunga, abhi忙 hoon." },
            { label: "Can't pay", msg: "Bhai abhi bilkul nahi ho payega, account mein balance nahi hai." },
            { label: "Rude", msg: "Tum log har roz call karte ho, bahut pareshan kar diya." },
            { label: "Promises date", msg: "Theek hai, 15 tak kar dunga payment, pakka." },
          ].map((preset) => (
            <button
              key={preset.label}
              onClick={() => {
                sendTurn(preset.msg);
                setInput("");
              }}
              disabled={loading}
              style={{
                padding: "0.3rem 0.7rem",
                borderRadius: "6px",
                border: "1px solid #ddd",
                background: "#fff",
                cursor: "pointer",
                fontSize: "0.8rem",
              }}
              title={preset.msg}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

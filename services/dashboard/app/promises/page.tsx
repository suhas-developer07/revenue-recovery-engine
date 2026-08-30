"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

type PromiseItem = {
  id: string;
  orderId: string;
  amountPaise: number;
  state: string;
  promisedDate: string | null;
  escalationCount: number;
  createdAt: string;
};

type Metrics = {
  total: number;
  kept: number;
  writtenOff: number;
  promiseKeepingRatePct: number;
  avgEscalationDepth: number;
};

const STATE_COLOR: Record<string, string> = {
  kept: "#16a34a",
  written_off: "#dc2626",
  promised: "#2563eb",
  due: "#d97706",
  broken: "#9333ea",
  notified: "#64748b",
  awaiting_response: "#64748b",
  re_escalated: "#7c3aed",
};

export default function PromisesPage() {
  const [promises, setPromises] = useState<PromiseItem[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await fetch("/api/promises").then((r) => r.json());
    setPromises(d.promises);
    setMetrics(d.metrics);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: string, action: string) => {
    setBusyId(id);
    const isRespond = action === "respond";
    await fetch("/api/promises", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, promised_date: "2026-09-10" }),
    });
    setBusyId(null);
    await load();
    if (isRespond) void 0;
  };

  const triggerBtn = (id: string, action: string, label: string) => (
    <button
      onClick={() => act(id, action)}
      disabled={busyId === id}
      style={{ padding: "0.3rem 0.7rem", borderRadius: "6px", border: "1px solid #ccc", background: "#fff", cursor: "pointer", fontSize: "0.8rem" }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <h1>Promise-to-Pay Tracker</h1>
      {metrics && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem", margin: "1.5rem 0" }}>
          <Stat label="Open promise tracks" value={String(metrics.total)} />
          <Stat label="Promises kept (paid)" value={String(metrics.kept)} color="#16a34a" />
          <Stat label="Written off" value={String(metrics.writtenOff)} color="#dc2626" />
          <Stat label="Keeping rate" value={`${metrics.promiseKeepingRatePct.toFixed(1)}%`} />
        </div>
      )}

      <p style={{ color: "#888", fontSize: "0.9rem" }}>
        Simulate a debtor&apos;s behaviour on a live track to drive it through the state machine.
      </p>

      {promises.length === 0 ? (
        <p style={{ color: "#888" }}>No promises yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr style={{ background: "#f8f8f8", textAlign: "left" }}>
              <th style={th}>Order</th>
              <th style={th}>Amount</th>
              <th style={th}>State</th>
              <th style={th}>Promised</th>
              <th style={th}>Escalations</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {promises.map((p) => {
              const terminal = p.state === "kept" || p.state === "written_off";
              return (
                <tr key={p.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={td}>{p.orderId}</td>
                  <td style={td}>{inr.format(p.amountPaise)}</td>
                  <td style={td}><span style={{ color: STATE_COLOR[p.state] ?? "#333", fontWeight: 600 }}>{p.state}</span></td>
                  <td style={td}>{p.promisedDate ?? "—"}</td>
                  <td style={td}>{p.escalationCount}</td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                      {!terminal && (
                        <>
                          {triggerBtn(p.id, "respond", "Debtor responds")}
                          {triggerBtn(p.id, "date_arrives", "Date arrives")}
                          {triggerBtn(p.id, "paid", "Paid")}
                          {triggerBtn(p.id, "not_paid", "Missed")}
                        </>
                      )}
                      <Link
                        href={`/negotiate?orderId=${encodeURIComponent(p.orderId)}&customerId=${encodeURIComponent(p.orderId)}&amountPaise=${p.amountPaise}&rootCause=pending%20invoice%20payment&escalationCount=${p.escalationCount}`}
                        style={{
                          padding: "0.3rem 0.7rem",
                          borderRadius: "6px",
                          border: "1px solid #2563eb",
                          background: terminal ? "#f0f0f0" : "#eff6ff",
                          color: terminal ? "#888" : "#2563eb",
                          cursor: terminal ? "default" : "pointer",
                          fontSize: "0.8rem",
                          textDecoration: "none",
                          fontWeight: 600,
                          pointerEvents: terminal ? "none" : "auto",
                        }}
                      >
                        🎙️ Negotiate
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value, color = "#111" }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: "1rem", border: "1px solid #eee", borderRadius: "10px", background: "#fff" }}>
      <div style={{ fontSize: "0.8rem", color: "#666" }}>{label}</div>
      <div style={{ fontSize: "1.6rem", fontWeight: "bold", color, marginTop: "0.3rem" }}>{value}</div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.75rem", borderBottom: "2px solid #eee" };
const td: React.CSSProperties = { padding: "0.6rem 0.75rem" };

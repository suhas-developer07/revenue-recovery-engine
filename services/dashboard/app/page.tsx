"use client";

import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  FunnelChart,
  Funnel,
  LabelList,
  Cell,
} from "recharts";

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

type Summary = {
  atRiskPaise: number;
  recoveredPaise: number;
  recoveryRatePct: number;
  events: number;
  decided: number;
  dispatched: number;
  blocked: number;
  unrecoverable: number;
  promiseKept: number;
  promiseWrittenOff: number;
};

const FUNNEL_COLORS = ["#6366f1", "#3b82f6", "#22c55e", "#eab308", "#94a3b8", "#f43f5e", "#a855f7"];

export default function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [funnel, setFunnel] = useState<{ stage: string; count: number }[]>([]);

  useEffect(() => {
    fetch("/api/summary").then((r) => r.json()).then(setSummary).catch(() => {});
    fetch("/api/funnel").then((r) => r.json()).then((d) => setFunnel(d.stages)).catch(() => {});
  }, []);

  const card = (label: string, value: string, color = "#111") => (
    <div style={{ padding: "1.5rem", border: "1px solid #eee", borderRadius: "10px", background: "#fff" }}>
      <div style={{ fontSize: "0.85rem", color: "#666" }}>{label}</div>
      <div style={{ fontSize: "2rem", fontWeight: "bold", color, marginTop: "0.4rem" }}>{value}</div>
    </div>
  );

  return (
    <div>
      <h1>Revenue Recovery — Batch Overview</h1>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1.5rem", marginTop: "1.5rem" }}>
        {card("Total at-risk ₹", summary ? inr.format(summary.atRiskPaise) : "—")}
        {card("Recovered ₹", summary ? inr.format(summary.recoveredPaise) : "—", "#16a34a")}
        {card("Recovery rate", summary ? `${summary.recoveryRatePct.toFixed(1)}%` : "—", "#2563eb")}
      </div>

      <div style={{ display: "flex", gap: "1rem", marginTop: "1rem", flexWrap: "wrap" }}>
        <span style={chip("#7c3aed")}>Blocked (compliance) · {summary?.blocked ?? "—"}</span>
        <span style={chip("#f43f5e")}>Unrecoverable (STOP) · {summary?.unrecoverable ?? "—"}</span>
        <span style={chip("#16a34a")}>Promises kept · {summary?.promiseKept ?? "—"}</span>
        <span style={chip("#94a3b8")}>Promises written off · {summary?.promiseWrittenOff ?? "—"}</span>
      </div>

      <div style={{ marginTop: "2.5rem", border: "1px solid #eee", borderRadius: "10px", padding: "1.5rem", background: "#fff" }}>
        <h3>Recovery funnel</h3>
        {funnel.length > 0 ? (
          <ResponsiveContainer width="100%" height={340}>
            <FunnelChart margin={{ top: 20, right: 40, bottom: 20, left: 40 }}>
              <Funnel
                dataKey="count"
                data={funnel}
                isAnimationActive
                label={{ fill: "#333", fontSize: 13 }}
              >
                {funnel.map((_, i) => (
                  <Cell key={i} fill={FUNNEL_COLORS[i % FUNNEL_COLORS.length]} stroke="#fff" />
                ))}
                <LabelList position="right" dataKey="stage" fill="#333" stroke="none" fontSize={13} />
              </Funnel>
            </FunnelChart>
          </ResponsiveContainer>
        ) : (
          <p style={{ color: "#888" }}>Loading funnel…</p>
        )}
      </div>
    </div>
  );
}

function chip(color: string): React.CSSProperties {
  return {
    padding: "0.4rem 0.8rem",
    borderRadius: "999px",
    border: "1px solid",
    borderColor: color,
    color,
    fontSize: "0.85rem",
    fontWeight: 600,
  };
}

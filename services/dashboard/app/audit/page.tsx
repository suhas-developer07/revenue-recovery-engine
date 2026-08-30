"use client";

import { Fragment, useEffect, useState } from "react";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

type AuditEntry = {
  decisionId: string;
  eventType: string;
  orderId: string | null;
  amountPaise: number;
  riskCategory: string | null;
  action: string | null;
  channel: string | null;
  authorizedByRule: string | null;
  blocked: boolean;
  blockReason: string | null;
  createdAt: string;
  actionStatus: string | null;
  recoveredPaise: number;
  trace: { ruleName: string; inputs: string; passed: boolean; reason: string }[] | null;
};

type Filter = "all" | "blocked" | "authorized";

export default function AuditPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [traceOpen, setTraceOpen] = useState<string | null>(null);

  useEffect(() => {
    const q = filter === "all" ? "" : `?blocked=${filter === "blocked" ? "true" : "false"}`;
    fetch(`/api/audit${q}`)
      .then((r) => r.json())
      .then((d) => setAudits(d.audits))
      .catch(() => setAudits([]));
  }, [filter]);

  const btn = (f: Filter, label: string) => (
    <button
      onClick={() => setFilter(f)}
      style={{
        padding: "0.5rem 1rem",
        borderRadius: "8px",
        border: "1px solid #ccc",
        background: filter === f ? "#2563eb" : "#fff",
        color: filter === f ? "#fff" : "#333",
        cursor: "pointer",
        fontWeight: 600,
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <h1>Audit Log</h1>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
        {btn("all", "All")}
        {btn("blocked", "Blocked actions")}
        {btn("authorized", "Authorized actions")}
      </div>

      {audits.length === 0 ? (
        <p style={{ color: "#888" }}>No audits for this filter.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr style={{ background: "#f8f8f8", textAlign: "left" }}>
              <th style={th}>Event</th>
              <th style={th}>Order</th>
              <th style={th}>Amount</th>
              <th style={th}>Risk</th>
              <th style={th}>Action</th>
              <th style={th}>Verdict</th>
              <th style={th}>Recovered</th>
              <th style={th}>Trace</th>
            </tr>
          </thead>
          <tbody>
            {audits.map((a) => (
              <Fragment key={a.decisionId}>
                <tr style={{ borderBottom: "1px solid #eee" }}>
                  <td style={td}>{a.eventType}</td>
                  <td style={td}>{a.orderId ?? "—"}</td>
                  <td style={td}>{inr.format(a.amountPaise)}</td>
                  <td style={td}>{a.riskCategory ?? "—"}</td>
                  <td style={td}>
                    {a.action ?? "—"}
                    {a.action === "SEND_PAYMENT_LINK" ? ` · ${a.channel ?? ""}` : ""}
                  </td>
                  <td style={td}>
                    {a.blocked ? (
                      <span style={{ color: "#dc2626", fontWeight: 600 }}>Blocked — {a.blockReason}</span>
                    ) : (
                      <span style={{ color: "#16a34a", fontWeight: 600 }}>
                        {a.authorizedByRule ?? "Authorized"}
                      </span>
                    )}
                  </td>
                  <td style={td}>{a.recoveredPaise > 0 ? <b style={{ color: "#16a34a" }}>{inr.format(a.recoveredPaise)}</b> : "0"}</td>
                  <td style={td}>
                    {a.trace ? (
                      <button onClick={() => setTraceOpen(traceOpen === a.decisionId ? null : a.decisionId)} style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer" }}>
                        {traceOpen === a.decisionId ? "Hide" : "View"}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                {traceOpen === a.decisionId && a.trace && (
                  <tr key={`${a.decisionId}-t`}>
                    <td colSpan={8} style={{ background: "#fafafa", padding: "0.75rem" }}>
                      <ol style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.8rem" }}>
                        {a.trace.map((c, i) => (
                          <li key={i} style={{ margin: "0.2rem 0" }}>
                            <span style={{ fontWeight: 600 }}>{c.ruleName}</span>{" "}
                            <span style={{ color: c.passed ? "#16a34a" : "#dc2626" }}>
                              {c.passed ? "PASS" : "FAIL"}
                            </span>
                            {c.inputs ? ` · ${c.inputs}` : ""}
                            {c.reason ? ` — ${c.reason}` : ""}
                          </li>
                        ))}
                      </ol>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.75rem", borderBottom: "2px solid #eee" };
const td: React.CSSProperties = { padding: "0.6rem 0.75rem" };

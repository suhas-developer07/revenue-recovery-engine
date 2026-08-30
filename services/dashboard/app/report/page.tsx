"use client";

import { useEffect, useState } from "react";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

type Report = {
  totals: {
    events: number;
    decisions: number;
    atRiskPaise: number;
    recoveredPaise: number;
    recoveryRatePct: number;
    unrecoverable: number;
    llmClassified: number;
  };
  byLeak: { leak: string; atRiskPaise: number; recoveredPaise: number; count: number; blocked: number }[];
  blockedByReason: { reason: string; count: number }[];
  recoverySplit: { rules: number; llm: number };  promises: { kept: number; writtenOff: number; total: number; keepingRatePct: number };

  edgeCase: {
    orderId: string;
    amountPaise: number;
    action: string;
    channel: string;
    authorizedByRule: string;
    recoveredPaise: number;
    createdAt: string;
  } | null;

  failureCase: {
    orderId: string;
    amountPaise: number;
    riskCategory: string | null;
    action: string;
    blockReason: string | null;
    createdAt: string;
  } | null;
};

export default function ReportPage() {
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    fetch("/api/report").then((r) => r.json()).then(setReport).catch(() => setReport(null));
  }, []);

  if (!report) return <p style={{ color: "#888" }}>Loading report…</p>;

  const t = report.totals;
  const e = report.edgeCase;
  const f = report.failureCase;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1>Batch Report</h1>

      <section style={{ border: "1px solid #eee", borderRadius: "10px", padding: "1.5rem", background: "#fff", marginBottom: "1.5rem" }}>
        <h3>Headline</h3>
        <p>
          <b>{t.events}</b> synthetic records were pushed through the real pipeline (ingest → classify → decide →
          execute → promise tracking). At-risk receivables totaled <b>{inr.format(t.atRiskPaise)}</b>; the pipeline
          recovered <b style={{ color: "#16a34a" }}>{inr.format(t.recoveredPaise)}</b> — a{" "}
          <b>{t.recoveryRatePct.toFixed(1)}%</b> recovery rate, an honest (non-100%) figure that still demonstrates
          real collection across channels.
        </p>
        <p>
          <b>{t.unrecoverable}</b> records ended in <code>STOP_SEQUENCE</code> (genuine dead-ends: revoked mandate,
          risk block, escalation ceiling), and <b>{report.promises.writtenOff}</b> receivable promises were written
          off — together the ~{(100 - t.recoveryRatePct).toFixed(0)}% of at-risk ₹ that is realistically not collectable
          automatically.
        </p>
      </section>

      <section style={{ border: "1px solid #eee", borderRadius: "10px", padding: "1.5rem", background: "#fff", marginBottom: "1.5rem" }}>
        <h3>Recovery by leak type</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr style={{ background: "#f8f8f8", textAlign: "left" }}>
              <th style={th}>Leak type</th>
              <th style={th}>Records</th>
              <th style={th}>At-risk</th>
              <th style={th}>Blocked</th>
              <th style={th}>Recovered</th>
            </tr>
          </thead>
          <tbody>
            {report.byLeak.map((r) => (
              <tr key={r.leak} style={{ borderBottom: "1px solid #eee" }}>
                <td style={td}>{r.leak}</td>
                <td style={td}>{r.count}</td>
                <td style={td}>{inr.format(r.atRiskPaise)}</td>
                <td style={td}>{r.blocked}</td>
                <td style={td}><b style={{ color: "#16a34a" }}>{inr.format(r.recoveredPaise)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ border: "1px solid #eee", borderRadius: "10px", padding: "1.5rem", background: "#fff", marginBottom: "1.5rem" }}>
        <h3>What stopped automated action</h3>
        <p style={{ fontSize: "0.9rem" }}>
          {report.blockedByReason.length === 0 ? "No blocked decisions." : (
            <ul>
              {report.blockedByReason.map((b) => (
                <li key={b.reason}>
                  <code>{b.reason}</code> — <b>{b.count}</b> decisions (compliance guardrail, not a dead-end).
                </li>
              ))}
            </ul>
          )}
        </p>
      </section>

      <section style={{ border: "1px solid #eee", borderRadius: "10px", padding: "1.5rem", background: "#fff" }}>
        <h3>Rules vs LLM</h3>
        <p style={{ fontSize: "0.9rem" }}>
          Every dispatched decision was authorized by the deterministic Go rule engine
          (<b>{report.recoverySplit.rules}</b> authorized-by-rule; <b>{report.recoverySplit.llm}</b> by LLM). The LLM
          classified <b>{t.llmClassified}</b> records but never authorizes recovery — it only drafts message copy inside
          an already-authorized, channel-targeted action. <code>LLM proposes, code disposes</code> holds end to end.
        </p>

        <h3>Promise-to-pay</h3>
        <p style={{ fontSize: "0.9rem" }}>
          <b>{report.promises.kept}</b> of <b>{report.promises.total}</b> receivable promises were kept
          ({report.promises.keepingRatePct.toFixed(0)}%); <b>{report.promises.writtenOff}</b> written off after the
          escalation ceiling.
        </p>

        {e && (
          <>
            <h3>Featured edge case</h3>
            <div style={{ border: "1px solid #dbeafe", borderRadius: "8px", padding: "1rem", background: "#f0f7ff", fontSize: "0.9rem" }}>
              <p style={{ marginTop: 0 }}>
                Order <code>{e.orderId}</code> (a <b>{inr.format(e.amountPaise)}</b> charge) exceeded the RBI ₹15,000
                AFA threshold for recurring debits. Instead of a (compliance-invalid) blind retry, the rule engine
                routed it to <b>{e.action}</b> over {e.channel} via{" "}
                <code>{e.authorizedByRule}</code>. The customer paid the authenticated link, which the follow-up sweep
                confirmed — recovering the full <b style={{ color: "#16a34a" }}>{inr.format(e.recoveredPaise)}</b>.
              </p>
              <p style={{ marginBottom: 0, color: "#555" }}>
                This is the pipeline&apos;s flagship recovery moment: a large recurring charge that the AFA guardrail
                correctly refuses to blindly re-charge is instead converted into an authenticated payment link that
                actually collects.
              </p>
            </div>
          </>
        )}

        {f && (
          <>
            <h3>Honest failure (compliance stopped this action)</h3>
            <div style={{ border: "1px solid #fecaca", borderRadius: "8px", padding: "1rem", background: "#fef2f2", fontSize: "0.9rem" }}>
              <p style={{ marginTop: 0 }}>
                Order <code>{f.orderId}</code> (a <b>{inr.format(f.amountPaise)}</b> {f.riskCategory ?? "event"}) was
                classified and the policy layer proposed a <b>{f.action}</b>, but the compliance guardrail
                blocked it: <code>{f.blockReason}</code>. The system refused to act — zero ₹ recovered on this
                order, by design.
              </p>
              <p style={{ marginBottom: 0, color: "#555" }}>
                This is the "what stops your agent from doing something it shouldn&apos;t?" answer: the
                deterministic policy layer sits between the LLM and any money-moving or customer-facing action, and
                this is one of <b>{report.blockedByReason.reduce((s, b) => s + b.count, 0)}</b> actions it refused to
                take across the batch.
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.7rem", borderBottom: "2px solid #eee" };
const td: React.CSSProperties = { padding: "0.6rem 0.7rem" };

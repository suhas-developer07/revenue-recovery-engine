import { NextResponse } from "next/server";
import { qOne, q } from "../../lib/db";

// Phase 6 batch report: one endpoint that returns the whole narrative dataset so the
// report page renders recovery-by-leak-type, blocked/unrecoverable tallies, the
// rules-vs-LLM split, promise metrics, and a single narrated edge case.
export const dynamic = "force-dynamic";

function leakOf(eventType: string, riskCategory: string): string {
  if (eventType === "invoice.expired") return "Receivables (overdue invoices)";
  if (eventType === "checkout.abandoned") return "Checkout abandonment";
  if (riskCategory === "mandate_revoked") return "Subscription / mandate";
  return "Failed payment (card/bank)";
}

export async function GET() {
  const totals = await qOne<{
    at_risk: string;
    recovered: string;
    recovered_from_promises: string;
    events: string;
    decisions: string;
  }>(
    `SELECT (SELECT coalesce(sum(e.amount_paise),0) FROM events e)::text AS at_risk,
            (SELECT coalesce(sum(a.amount_recovered_paise),0) FROM actions a)::text AS recovered,
            (SELECT coalesce(sum(e.amount_paise),0) FROM promises p JOIN events e ON e.id=p.event_id WHERE p.state='kept')::text AS recovered_from_promises,
            (SELECT count(*) FROM events e)::text AS events,
            (SELECT count(*) FROM decisions d)::text AS decisions`,
  );

  const byLeak = await q<{
    leak: string;
    at_risk: string;
    recovered: string;
    count: string;
    blocked: string;
  }>(`
    SELECT base.leak, base.at_risk::text, (base.recovered_actions + coalesce(prom.recovered_promises,0))::text AS recovered, base.count, base.blocked
    FROM (
      SELECT CASE
               WHEN e.event_type='invoice.expired' THEN 'Receivables (overdue invoices)'
               WHEN e.event_type='checkout.abandoned' THEN 'Checkout abandonment'
               WHEN c.risk_category='mandate_revoked' THEN 'Subscription / mandate'
               ELSE 'Failed payment (card/bank)'
             END AS leak,
             coalesce(sum(e.amount_paise),0) AS at_risk,
             coalesce(sum(a.amount_recovered_paise),0) AS recovered_actions,
             count(DISTINCT e.id) AS count,
             count(DISTINCT d.id) FILTER (WHERE d.blocked) AS blocked
      FROM events e
      LEFT JOIN classifications c ON c.event_id=e.id
      LEFT JOIN decisions d ON d.event_id=e.id
      LEFT JOIN actions a ON a.decision_id=d.id
      GROUP BY 1
    ) base
    LEFT JOIN (
      SELECT CASE
               WHEN e.event_type='invoice.expired' THEN 'Receivables (overdue invoices)'
               WHEN e.event_type='checkout.abandoned' THEN 'Checkout abandonment'
               WHEN c.risk_category='mandate_revoked' THEN 'Subscription / mandate'
               ELSE 'Failed payment (card/bank)'
             END AS leak,
             coalesce(sum(e.amount_paise),0) AS recovered_promises
      FROM promises p
      JOIN events e ON e.id=p.event_id
      LEFT JOIN classifications c ON c.event_id=e.id
      WHERE p.state='kept'
      GROUP BY 1
    ) prom ON prom.leak = base.leak
    ORDER BY base.count DESC`);

  const blockedByReason = await q<{ reason: string | null; count: string }>(
    `SELECT d.block_reason AS reason, count(*)::text AS count
     FROM decisions d WHERE d.blocked GROUP BY 1 ORDER BY 2 DESC`,
  );

  const rulesVsLlm = await q<{ source: string; count: string }>(`
    SELECT CASE WHEN coalesce(d.authorized_by_rule,'')='' THEN 'llm' ELSE 'rules' END AS source,
           count(*)::text AS count
    FROM decisions d WHERE NOT d.blocked GROUP BY 1`);

  const unrecoverable = await qOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM decisions WHERE action='STOP_SEQUENCE'`,
  );

  const promised = await qOne<{ kept: string; written_off: string; total: string }>(
    `SELECT count(*) FILTER (WHERE state='kept')::text AS kept,
            count(*) FILTER (WHERE state='written_off')::text AS written_off,
            count(*)::text AS total FROM promises`,
  );

  const LLM_HANDLED = await qOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM classifications WHERE classified_by='llm'`,
  );

  // Edge case: the largest AFA-threshold-routed payment link that captured in full.
  const edgeCase = await qOne<{
    order_id: string;
    amount_paise: string;
    action: string;
    channel: string;
    authorized_by_rule: string | null;
    recov_paise: string;
    created_at: string;
  }>(
    `SELECT e.order_id, e.amount_paise::text AS amount_paise, d.action, d.channel,
            d.authorized_by_rule, a.amount_recovered_paise::text AS recov_paise, d.created_at
     FROM decisions d
     JOIN events e ON e.id=d.event_id
     LEFT JOIN actions a ON a.decision_id=d.id
     WHERE d.blocked = false AND coalesce(a.amount_recovered_paise,0) > 0
     ORDER BY a.amount_recovered_paise DESC
     LIMIT 1`,
  );

  // Honest failure: the largest blocked decision — a correctly-refused action the
  // system was asked to take but compliance rules stopped. This is the "what stops
  // your agent" answer in data form, and the honest miss for the pitch.
  const failureCase = await qOne<{
    order_id: string;
    amount_paise: string;
    risk_category: string | null;
    action: string;
    block_reason: string | null;
    created_at: string;
  }>(
    `SELECT e.order_id, e.amount_paise::text AS amount_paise, c.risk_category,
            d.action, d.block_reason, d.created_at
     FROM decisions d
     JOIN events e ON e.id=d.event_id
     LEFT JOIN classifications c ON c.event_id=e.id
     WHERE d.blocked = true
     ORDER BY e.amount_paise DESC
     LIMIT 1`,
  );

  const atRisk = Number(totals?.at_risk ?? 0);
  const recoveredActions = Number(totals?.recovered ?? 0);
  const recoveredPromises = Number(totals?.recovered_from_promises ?? 0);
  // Total recovered = actions ledger + kept promises. The actions table captures
  // Razorpay-confirmed recoveries (payment links captured, retries confirmed);
  // kept promises capture the receivables channel where debtors paid after PTP
  // follow-up. Both represent real money recovered, neither double-counts the
  // other (kept promises only exist for invoice_overdue events whose original
  // decisions were blocked — no actions row exists for them).
  const recovered = recoveredActions + recoveredPromises;

  const e = edgeCase;
  const f = failureCase;
  const recoverySplit = Object.fromEntries(
    rulesVsLlm.map((r) => [r.source, Number(r.count)]),
  );

  return NextResponse.json({
    totals: {
      events: Number(totals?.events ?? 0),
      decisions: Number(totals?.decisions ?? 0),
      atRiskPaise: atRisk,
      recoveredPaise: recovered,
      recoveredActionsPaise: recoveredActions,
      recoveredPromisesPaise: recoveredPromises,
      recoveryRatePct: atRisk ? (recovered / atRisk) * 100 : 0,
      unrecoverable: Number(unrecoverable?.count ?? 0),
      llmClassified: Number(LLM_HANDLED?.count ?? 0),
    },
    byLeak: byLeak.map((r) => ({
      leak: r.leak,
      atRiskPaise: Number(r.at_risk),
      recoveredPaise: Number(r.recovered),
      count: Number(r.count),
      blocked: Number(r.blocked),
    })),
    blockedByReason: blockedByReason.map((r) => ({
      reason: r.reason ?? "unknown",
      count: Number(r.count),
    })),
    recoverySplit: {
      rules: recoverySplit.rules ?? 0,
      llm: recoverySplit.llm ?? 0,
    },
    promises: {
      kept: Number(promised?.kept ?? 0),
      writtenOff: Number(promised?.written_off ?? 0),
      total: Number(promised?.total ?? 0),
      keepingRatePct: Number(promised?.total ?? 0) ? (Number(promised?.kept ?? 0) / Number(promised?.total ?? 0)) * 100 : 0,
    },
    edgeCase: e
      ? {
          orderId: e.order_id,
          amountPaise: Number(e.amount_paise),
          action: e.action,
          channel: e.channel,
          authorizedByRule: e.authorized_by_rule,
          recoveredPaise: Number(e.recov_paise),
          createdAt: e.created_at,
        }
      : null,
    failureCase: f
      ? {
          orderId: f.order_id,
          amountPaise: Number(f.amount_paise),
          riskCategory: f.risk_category,
          action: f.action,
          blockReason: f.block_reason,
          createdAt: f.created_at,
        }
      : null,
  });
}

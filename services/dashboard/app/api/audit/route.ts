import { NextResponse } from "next/server";
import { q } from "../../lib/db";

// Audit log: every decision with its action, channel, gateway verdict (authorized /
// blocked + reason), and the full Phase 3 reasoning trace so it can be rendered
// readably. Supports a ?blocked= filter (true/false) keyed to the user directive to
// build the blocked-actions filter first.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const blockedFilter = url.searchParams.get("blocked"); // "true" | "false" | undefined

  const where = (() => {
    if (blockedFilter === "true") return "WHERE d.blocked = true";
    if (blockedFilter === "false") return "WHERE d.blocked = false";
    return "";
  })();

  const rows = await q<{
    decision_id: string;
    event_type: string;
    order_id: string;
    amount_paise: string;
    risk_category: string;
    action: string;
    channel: string;
    authorized_by_rule: string | null;
    blocked: boolean;
    block_reason: string | null;
    created_at: string;
    action_status: string | null;
    recovered_paise: string;
    reasoning: string | null;
    reason_pruned: string | null;
  }>(
    `SELECT d.id AS decision_id, e.event_type, e.order_id, e.amount_paise::text AS amount_paise,
            c.risk_category, d.action, d.channel, d.authorized_by_rule,
            d.blocked, d.block_reason, d.created_at,
            a.status AS action_status, coalesce(a.amount_recovered_paise,0)::text AS recovered_paise,
            d.reasoning
     FROM decisions d
     JOIN events e ON e.id = d.event_id
     LEFT JOIN classifications c ON c.event_id = e.id
     LEFT JOIN actions a ON a.decision_id = d.id
     ${where}
     ORDER BY d.created_at DESC
     LIMIT 200`,
  );

  return NextResponse.json({
    blockedFilter: blockedFilter ?? "all",
    audits: rows.map((r) => {
      // The reasoning column holds the verbatim Phase 3 DecisionTrace JSON. Keep it,
      // and also produce a compact checks shorthand for the expandable trace.
      let trace: unknown[] | null = null;
      if (r.reasoning) {
        try {
          trace = (JSON.parse(r.reasoning) as { checks?: unknown[] }).checks ?? null;
        } catch {
          trace = null;
        }
      }
      return {
        decisionId: r.decision_id,
        eventType: r.event_type,
        orderId: r.order_id,
        amountPaise: Number(r.amount_paise),
        riskCategory: r.risk_category,
        action: r.action,
        channel: r.channel,
        authorizedByRule: r.authorized_by_rule,
        blocked: r.blocked,
        blockReason: r.block_reason,
        createdAt: r.created_at,
        actionStatus: r.action_status,
        recoveredPaise: Number(r.recovered_paise),
        trace,
      };
    }),
  });
}

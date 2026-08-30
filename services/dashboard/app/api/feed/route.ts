import { NextResponse } from "next/server";
import { q } from "../../lib/db";

// Live feed: the most recent events and what the pipeline decided + did for each.
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await q<{
    event_id: string;
    event_type: string;
    order_id: string;
    customer_id: string;
    amount_paise: string;
    received_at: string;
    risk_category: string;
    action: string;
    channel: string;
    blocked: boolean;
    block_reason: string | null;
    action_status: string | null;
    recovered_paise: string;
  }>(`
    SELECT e.id AS event_id, e.event_type, e.order_id, e.customer_id,
           e.amount_paise::text AS amount_paise, e.received_at,
           c.risk_category, d.action, d.channel, d.blocked, d.block_reason,
           a.status AS action_status, coalesce(a.amount_recovered_paise,0)::text AS recovered_paise
    FROM events e
    LEFT JOIN classifications c ON c.event_id = e.id
    LEFT JOIN decisions d ON d.event_id = e.id
    LEFT JOIN actions a ON a.decision_id = d.id
    ORDER BY e.received_at DESC
    LIMIT 40`);

  return NextResponse.json({
    feed: rows.map((r) => ({
      eventId: r.event_id,
      eventType: r.event_type,
      orderId: r.order_id,
      customerId: r.customer_id,
      amountPaise: Number(r.amount_paise),
      receivedAt: r.received_at,
      riskCategory: r.risk_category,
      action: r.action,
      channel: r.channel,
      blocked: r.blocked,
      blockReason: r.block_reason,
      actionStatus: r.action_status,
      recoveredPaise: Number(r.recovered_paise),
    })),
  });
}

import { NextResponse } from "next/server";
import { q } from "../../lib/db";
import { DECISION_ENGINE_URL } from "../../lib/db";

// Promise-to-pay tracker: list + metrics for reads, and a "simulate respond" action
// that drives the SAME Go state machine endpoint the pipeline uses (single source of
// truth for the promise lifecycle), so the dashboard stays a thin surface on top of it.
export const dynamic = "force-dynamic";

export async function GET() {
  const [promises, metrics] = await Promise.all([
    q<{
      id: string;
      order_id: string;
      amount_paise: string;
      state: string;
      promised_date: string | null;
      escalation_count: string;
      created_at: string;
    }>(
      `SELECT p.id, e.order_id, e.amount_paise::text AS amount_paise,
              p.state, p.promised_date::text AS promised_date,
              p.escalation_count::text AS escalation_count, p.created_at
       FROM promises p
       JOIN events e ON e.id = p.event_id
       ORDER BY p.created_at DESC`,
    ),
    q<{ metric: string; value: string }>(`
      SELECT 'kept' AS metric, count(*) FILTER (WHERE state='kept')::text AS value FROM promises
      UNION ALL SELECT 'written_off', count(*) FILTER (WHERE state='written_off')::text FROM promises
      UNION ALL SELECT 'total', count(*)::text FROM promises
      UNION ALL SELECT 'escalation_depth_avg', round(avg(escalation_count),2)::text FROM promises`),
  ]);

  const m = Object.fromEntries(metrics.map((r) => [r.metric, Number(r.value)]));

  return NextResponse.json({
    metrics: {
      total: m.total ?? 0,
      kept: m.kept ?? 0,
      writtenOff: m.written_off ?? 0,
      promiseKeepingRatePct: m.total ? ((m.kept ?? 0) / m.total) * 100 : 0,
      avgEscalationDepth: m.escalation_depth_avg ?? 0,
    },
    promises: promises.map((p) => ({
      id: p.id,
      orderId: p.order_id,
      amountPaise: Number(p.amount_paise),
      state: p.state,
      promisedDate: p.promised_date,
      escalationCount: Number(p.escalation_count),
      createdAt: p.created_at,
    })),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { id, action, promised_date } = body as {
    id?: string;
    action?: string;
    promised_date?: string;
  };
  if (!id || !action) {
    return NextResponse.json({ error: "id and action are required" }, { status: 400 });
  }

  try {
    if (action === "respond") {
      const resp = await fetch(`${DECISION_ENGINE_URL}/promises/${id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promised_date: promised_date ?? "2026-09-10" }),
      });
      const data = await resp.json().catch(() => ({}));
      return NextResponse.json({ ok: resp.ok, state: (data as { state?: string }).state ?? null }, { status: resp.status });
    }
    const resp = await fetch(`${DECISION_ENGINE_URL}/promises/${id}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: action }),
    });
    const data = await resp.json().catch(() => ({}));
    return NextResponse.json({ ok: resp.ok, state: (data as { state?: string }).state ?? null }, { status: resp.status });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}

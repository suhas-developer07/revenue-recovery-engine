import { NextResponse } from "next/server";
import { q } from "../../lib/db";

// Recovery funnel: how many records survive each stage, and where the ₹ comes from.
export const dynamic = "force-dynamic";

export async function GET() {
  const [stages] = await Promise.all([
    q<{ stage: string; count: string }>(`
      SELECT 'ingested' AS stage, (SELECT count(*)::text FROM events e) AS count
      UNION ALL SELECT 'classified', (SELECT count(*)::text FROM classifications c)
      UNION ALL SELECT 'decided',    (SELECT count(*)::text FROM decisions d)
      UNION ALL SELECT 'dispatched', (SELECT count(*)::text FROM decisions d WHERE NOT d.blocked)
      UNION ALL SELECT 'executed',   (SELECT count(*)::text FROM actions a)
      UNION ALL SELECT 'blocked',    (SELECT count(*)::text FROM decisions d WHERE d.blocked)
      UNION ALL SELECT 'unrecoverable', (SELECT count(*)::text FROM decisions d WHERE d.action='STOP_SEQUENCE')`),
  ]);

  const byAction = await q<{ action: string; count: string; recovered_paise: string }>(`
    SELECT d.action,
           count(*)::text AS count,
           coalesce(sum(a.amount_recovered_paise),0)::text AS recovered_paise
    FROM decisions d
    LEFT JOIN actions a ON a.decision_id = d.id
    WHERE NOT d.blocked
    GROUP BY d.action ORDER BY count(*) DESC`);

  return NextResponse.json({
    stages: stages.map((s) => ({ stage: s.stage, count: Number(s.count) })),
    byAction: byAction.map((r) => ({
      action: r.action,
      count: Number(r.count),
      recoveredPaise: Number(r.recovered_paise),
    })),
  });
}

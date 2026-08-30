import { NextResponse } from "next/server";
import { qOne } from "../../lib/db";

// Header + live counters for the dashboard: the ₹ at-risk, ₹ recovered, recovery
// rate, and the funnel/status counts that tell the "is this working?" story at a glance.
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await qOne<{
    at_risk: number;
    recovered: number;
    events: number;
    decided: number;
    dispatched: number;
    blocked: number;
    unrecoverable: number;
    promise_kept: number;
    promise_written_off: number;
  }>(
    `SELECT
       (SELECT coalesce(sum(e.amount_paise),0) FROM events e)                                        AS at_risk,
       (SELECT coalesce(sum(a.amount_recovered_paise),0) FROM actions a)                              AS recovered,
       (SELECT count(*) FROM events e)                                                               AS events,
       (SELECT count(*) FROM decisions d)                                                            AS decided,
       (SELECT count(*) FROM decisions d WHERE NOT d.blocked)                                        AS dispatched,
       (SELECT count(*) FROM decisions d WHERE d.blocked)                                            AS blocked,
       (SELECT count(*) FROM decisions d
          WHERE d.action = 'STOP_SEQUENCE')                                                          AS unrecoverable,
       (SELECT count(*) FROM promises p WHERE p.state = 'kept')                                      AS promise_kept,
       (SELECT count(*) FROM promises p WHERE p.state = 'written_off')                               AS promise_written_off`,
  );

  const recoveryRate =
    data && data.at_risk > 0 ? (data.recovered / data.at_risk) * 100 : 0;

  return NextResponse.json({
    atRiskPaise: data?.at_risk ?? 0,
    recoveredPaise: data?.recovered ?? 0,
    recoveryRatePct: recoveryRate,
    events: data?.events ?? 0,
    decided: data?.decided ?? 0,
    dispatched: data?.dispatched ?? 0,
    blocked: data?.blocked ?? 0,
    unrecoverable: data?.unrecoverable ?? 0,
    promiseKept: data?.promise_kept ?? 0,
    promiseWrittenOff: data?.promise_written_off ?? 0,
  });
}

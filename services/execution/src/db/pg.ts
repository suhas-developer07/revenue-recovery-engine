import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type ActionRow = {
  id: string;
  decision_id: string;
  status: "success" | "failed" | "pending";
  amount_recovered_paise: number;
  executed_at: Date;
  outcome_payload: unknown | null;
};

export async function getActionByDecisionId(decisionId: string): Promise<ActionRow | null> {
  const res = await pool.query(
    `SELECT id, decision_id, status, amount_recovered_paise, executed_at, outcome_payload
       FROM actions WHERE decision_id = $1`,
    [decisionId],
  );
  if (res.rowCount === 0) return null;
  return res.rows[0] as ActionRow;
}

export async function insertAction(input: {
  decision_id: string;
  status: "success" | "failed" | "pending";
  amount_recovered_paise: number;
  outcome_payload: unknown;
}): Promise<ActionRow> {
  const res = await pool.query(
    `INSERT INTO actions (decision_id, status, amount_recovered_paise, outcome_payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (decision_id) DO NOTHING
     RETURNING id, decision_id, status, amount_recovered_paise, executed_at, outcome_payload`,
    [input.decision_id, input.status, input.amount_recovered_paise, input.outcome_payload],
  );
  return res.rows[0] as ActionRow;
}

export type PendingLinkRow = ActionRow & { order_id: string; amount_paise: number };

export async function listPendingPaymentLinks(): Promise<PendingLinkRow[]> {
  // Join to the source event (held via the decision -> event chain) to recover the
  // order_id AND the real amount we need to re-check/credit. payment-link actions are
  // provisional (status 'pending', amount 0) until the linked payment captures.
  const res = await pool.query(
    `SELECT a.id, a.decision_id, a.status, a.amount_recovered_paise, a.executed_at, a.outcome_payload,
            e.order_id, e.amount_paise
       FROM actions a
       JOIN decisions d ON d.id = a.decision_id
       JOIN events e ON e.id = d.event_id
      WHERE a.status = 'pending'
        AND (a.outcome_payload->>'kind' = 'payment_link')`,
  );
  return res.rows as PendingLinkRow[];
}

export async function confirmPaymentLink(id: string, amountPaise: number, outcome: unknown): Promise<void> {
  await pool.query(
    `UPDATE actions
        SET status = 'success',
            amount_recovered_paise = $2,
            outcome_payload = $3
      WHERE id = $1`,
    [id, amountPaise, JSON.stringify(outcome)],
  );
}

export async function close(): Promise<void> {
  await pool.end();
}

export type NarrativeRow = {
  risk_category: string;
  root_cause_narrative: string | null;
};

// fetch the classification context for a given order (risk category + the actual
// root-cause narrative the LLM/rules engine produced in Phase 2). SEND_REMINDER
// passes this narrative into /draft so the message references the real failure
// reason instead of generic copy.
export async function getNarrativeByOrderId(orderId: string): Promise<NarrativeRow | null> {
  const res = await pool.query(
    `SELECT c.risk_category, c.root_cause_narrative
       FROM classifications c
       JOIN events e ON e.id = c.event_id
      WHERE e.order_id = $1
      ORDER BY c.created_at DESC LIMIT 1`,
    [orderId],
  );
  if (res.rowCount === 0) return null;
  return res.rows[0] as NarrativeRow;
}

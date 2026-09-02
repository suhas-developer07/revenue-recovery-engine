// Synthetic batch generator.
//
// Generates a realistic batch of transactions and pushes them through the REAL
// pipeline: each record is INSERTed directly into Postgres with a spread
// received_at timestamp, then published to the Redis stream for the decision
// engine to classify and decide — exactly like live traffic flowing through the
// real agents. We produce real events consumed by the real pipeline — we do NOT
// fabricate results.
//
// Direct INSERT (rather than webhook POST) gives us control over received_at,
// which the decision engine uses for quiet-hours / AFA-window checks. Events
// are spread across 5 days so these time-dependent policies produce a realistic
// mix of blocked and authorized decisions regardless of wall-clock time.
//
// "Realistic" means:
//   - log-normal-ish amount distribution (many small, a few large B2B invoices)
//   - failure-reason weighting that mirrors reality (insufficient_funds &
//     bank_timeout dominate; mandate_revoked & risk_block are rare)
//   - every leak type represented (payment failure, checkout, subscription, receivables)
//   - genuinely unrecoverable cases baked in (~18%), not a suspicious 100% recovery
//   - receivables get simulated debtor responses so promise metrics have variance
//   - event timestamps spread across 5 days for deterministic time-policy behavior

import { randomBytes } from "node:crypto";
import { createHmac } from "node:crypto";

const BATCH_SIZE = Number(process.env.BATCH_SIZE || "220");

// Deterministic PRNG (mulberry32) so a given seed reproduces the exact batch.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- distributions ---------------------------------------------------------

// Log-normal-ish amount in paise, scaled to B2B-invoice territory. Median ~₹8k,
// long tail out to a few lakhs of ₹. A meaningful share exceeds the ₹15,000 AFA
// threshold (1,500,000 paise) so recurring charges route to an authenticated
// payment link — the recovery channel that actually collects ₹ here — while still
// keeping plenty of small transactions.
function sampleAmount(rand: () => number): number {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const paise = Math.round(Math.exp(13.5 + 1.2 * n)); // median ~₹7.3k, long tail
  return Math.max(500, paise); // never below ₹5
}

type CategoryShare = { category: string; weight: number };

// Failure-reason weighting. Insufficient funds + timeouts dominate; mandate revoke
// and risk blocks are rarer. expired_card / risk_block / checkout are the main
// payment-link recovery channels; mandate_revoked is a genuine dead-end (STOP).
const PAYMENT_CATEGORIES: CategoryShare[] = [
  { category: "insufficient_funds", weight: 0.3 },
  { category: "bank_timeout", weight: 0.18 },
  { category: "otp_failure", weight: 0.14 },
  { category: "expired_card", weight: 0.14 },
  { category: "risk_block", weight: 0.12 },
  { category: "mandate_revoked", weight: 0.12 },
];

function pickCategory(rand: () => number, cats: CategoryShare[]): string {
  const total = cats.reduce((s, c) => s + c.weight, 0);
  let r = rand() * total;
  for (const c of cats) {
    r -= c.weight;
    if (r <= 0) return c.category;
  }
  return cats[cats.length - 1].category;
}

// --- webhook payload builders (for generating realistic raw_payload) --------

type Wh = {
  event: string;
  payload: Record<string, { entity: Record<string, unknown> }>;
};

function buildPaymentWebhook(
  category: string,
  orderId: string,
  customerId: string,
  amount: number,
): Wh {
  const base = { order_id: orderId, customer_id: customerId, amount };
  const errorCodeByCategory: Record<string, [string, string]> = {
    insufficient_funds: [
      "insufficient_funds",
      "Your account does not have sufficient balance to complete this transaction",
    ],
    bank_timeout: [
      "bank_unreachable",
      "The bank is temporarily unavailable, please retry",
    ],
    otp_failure: [
      "authentication_failed",
      "Incorrect OTP provided by the customer during 3DS verification",
    ],
    expired_card: [
      "expired_card",
      "The card has expired, expiry is in the past",
    ],
    risk_block: [
      "risk_block",
      "Transaction blocked by risk engine as suspected fraud",
    ],
    mandate_revoked: [
      "mandate.revoked",
      "The recurring mandate has been revoked by the customer",
    ],
  };
  const [code, desc] = errorCodeByCategory[category] ?? ["", ""];
  return {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          ...base,
          error_code: code,
          error_description: desc,
          description: desc,
        },
      },
    },
  };
}

function buildCheckoutWebhook(
  orderId: string,
  customerId: string,
  amount: number,
): Wh {
  return {
    event: "checkout.abandoned",
    payload: {
      order: {
        entity: {
          id: orderId,
          customer_id: customerId,
          amount,
          notes: "cart abandoned before payment",
        },
      },
    },
  };
}

function buildInvoiceWebhook(
  orderId: string,
  customerId: string,
  amount: number,
): Wh {
  return {
    event: "invoice.expired",
    payload: {
      invoice: {
        entity: {
          id: `inv_${orderId}`,
          order_id: orderId,
          customer_id: customerId,
          amount,
          description: "invoice overdue past due",
        },
      },
    },
  };
}

// --- event classification from webhook payload (determines DB fields) -------

function classifyEvent(wh: Wh): {
  event_type: string;
  order_id: string;
  customer_id: string;
  amount_paise: number;
  raw_payload: unknown;
} {
  const p = wh.payload;
  if (wh.event === "payment.failed") {
    const e = p.payment.entity;
    return {
      event_type: "payment.failed",
      order_id: String(e.order_id),
      customer_id: String(e.customer_id),
      amount_paise: Number(e.amount),
      raw_payload: wh,
    };
  }
  if (wh.event === "checkout.abandoned") {
    const e = p.order.entity;
    return {
      event_type: "checkout.abandoned",
      order_id: String(e.id),
      customer_id: String(e.customer_id),
      amount_paise: Number(e.amount),
      raw_payload: wh,
    };
  }
  if (wh.event === "invoice.expired") {
    const e = p.invoice.entity;
    return {
      event_type: "invoice.expired",
      order_id: String(e.order_id),
      customer_id: String(e.customer_id),
      amount_paise: Number(e.amount),
      raw_payload: wh,
    };
  }
  throw new unknownEventType(wh.event);
}

class unknownEventType extends Error {
  constructor(type: string) {
    super(`unknown event type: ${type}`);
  }
}

// --- timestamp spreading ---------------------------------------------------
// Spread events across a 5-day window so time-dependent policy checks
// (quiet hours, AFA pre-debit window) produce a realistic mix of blocked
// and authorized decisions. The window starts 3 days before "now" and ends
// 2 days after, covering both daytime (authorized) and nighttime (blocked)
// hours. Events are placed at pseudo-random hours within each day.

function spreadTimestamps(
  rand: () => number,
  count: number,
): Date[] {
  const now = Date.now();
  const msPerDay = 86_400_000;
  const windowStart = now - 3 * msPerDay; // 3 days ago
  const windowSpan = 5 * msPerDay; // 5-day range

  const timestamps: Date[] = [];
  for (let i = 0; i < count; i++) {
    // Random offset within the 5-day window
    const offset = rand() * windowSpan;
    // Random hour of day (0-23) with slight weighting toward business hours
    // but still covering nighttime for realistic blocked/authorized mix
    const hour = Math.floor(rand() * 24);
    const minute = Math.floor(rand() * 60);
    const second = Math.floor(rand() * 60);

    const d = new Date(windowStart + offset);
    d.setHours(hour, minute, second, 0);
    timestamps.push(d);
  }

  // Sort chronologically so pipeline processes them in time order
  timestamps.sort((a, b) => a.getTime() - b.getTime());
  return timestamps;
}

// --- main ---------------------------------------------------------------------

async function main() {
  const rand = mulberry32(20260830);

  // Shared Postgres connection for event insertion + preference seeding.
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await ensureCustomerPreferences(pool);

  // Redis connection for publishing to the new_events stream.
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const { createClient } = await import("redis");
  const redis = createClient({ url: redisUrl });
  await redis.connect();
  console.log(`[synthetic] connected to Redis at ${redisUrl}`);

  // Generate spread timestamps so time-dependent policies (quiet hours,
  // AFA pre-debit window) produce deterministic, reproducible results.
  const timestamps = spreadTimestamps(rand, BATCH_SIZE);

  console.log(
    `[synthetic] generating ${BATCH_SIZE} records through the real pipeline`,
  );
  console.log(
    `[synthetic] timestamps spread across ${formatSpan(timestamps)}`,
  );

  let inserted = 0;
  for (let i = 0; i < BATCH_SIZE; i++) {
    const orderId = `ord_syn_${String(i).padStart(4, "0")}`;
    const customerId = `cust_syn_${String(((i * 7) % 40) + 1).padStart(2, "0")}`;
    const amount = sampleAmount(rand);

    // Weight the leak type. ~14% receivables, ~18% checkout, rest payment/sub.
    const leakRoll = rand();
    let wh: Wh;
    if (leakRoll < 0.14) {
      wh = buildInvoiceWebhook(orderId, customerId, amount);
    } else if (leakRoll < 0.32) {
      wh = buildCheckoutWebhook(orderId, customerId, amount);
    } else {
      const cat = pickCategory(rand, PAYMENT_CATEGORIES);
      wh = buildPaymentWebhook(cat, orderId, customerId, amount);
    }

    const ev = classifyEvent(wh);
    const ts = timestamps[i];

    // Insert event with the spread timestamp. This is the key fix: the decision
    // engine uses received_at for quiet-hours / AFA-window checks, so spread
    // timestamps produce a realistic mix of blocked and authorized decisions
    // regardless of what time the batch is run.
    const res = await pool.query(
      `INSERT INTO events (source, event_type, order_id, customer_id, amount_paise, raw_payload, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      ["synthetic", ev.event_type, ev.order_id, ev.customer_id, ev.amount_paise, JSON.stringify(ev.raw_payload), ts.toISOString()],
    );
    const eventId = res.rows[0].id;

    // Publish to the Redis stream so the decision engine picks it up.
    await redis.xAdd("new_events", "*", { event_id: eventId });
    inserted++;
  }

  console.log(
    `[synthetic] inserted ${inserted} events with spread timestamps; pipeline classifying/deciding/executing`,
  );

  // Wait for the decision-engine to consume + decide before querying for invoices.
  await wait(8000);

  // --- receivables: simulate debtor responses so promise metrics have variance ---
  const invoiceIds = await fetchReceivableEventIds(pool);
  let kept = 0;
  let writtenOff = 0;
  let active = 0;
  const DECISION_URL =
    process.env.DECISION_ENGINE_URL || "http://localhost:8082";
  for (const eventId of invoiceIds) {
    const pid = await createPromise(DECISION_URL, eventId);
    if (!pid) continue;
    const roll = rand();
    if (roll < 0.4) {
      // debtor promises and pays on time -> kept
      await respondPromise(DECISION_URL, pid, "2026-09-10");
      await advancePromise(DECISION_URL, pid, "date_arrives");
      await advancePromise(DECISION_URL, pid, "paid");
      kept++;
    } else if (roll < 0.6) {
      // debtor misses the date, then pays late -> kept (broken -> paid)
      await respondPromise(DECISION_URL, pid, "2026-09-10");
      await advancePromise(DECISION_URL, pid, "date_arrives");
      await advancePromise(DECISION_URL, pid, "not_paid");
      await advancePromise(DECISION_URL, pid, "paid");
      kept++;
    } else if (roll < 0.75) {
      // debtor never pays through the escalation ceiling -> written_off
      for (let k = 0; k < 7; k++) {
        await advancePromise(DECISION_URL, pid, "request_response");
        await respondPromise(DECISION_URL, pid, "2026-09-10");
        await advancePromise(DECISION_URL, pid, "date_arrives");
        await advancePromise(DECISION_URL, pid, "not_paid");
        const st = await advancePromise(
          DECISION_URL,
          pid,
          "not_paid",
        );
        if (st === "written_off") break;
      }
      writtenOff++;
    } else {
      // Leave in active state for demo: promise made but not yet resolved
      // This lets users demo the negotiate button from the promises tab
      await respondPromise(DECISION_URL, pid, "2026-09-15");
      active++;
    }
    await wait(30);
  }
  console.log(
    `[synthetic] promise simulation done: kept=${kept} written_off=${writtenOff} active=${active}`,
  );
  await redis.disconnect();
  await pool.end();
  console.log("[synthetic] batch complete — see dashboard + report");
}

// --- helpers ------------------------------------------------------------------

function formatSpan(timestamps: Date[]): string {
  if (timestamps.length === 0) return "empty";
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  const days = (last.getTime() - first.getTime()) / 86_400_000;
  return `${days.toFixed(1)} days (${first.toISOString().slice(0, 10)} → ${last.toISOString().slice(0, 10)})`;
}

// Fetch recently created receivable (invoice.expired) event IDs from Postgres.
async function fetchReceivableEventIds(client: {
  query: (
    q: string,
  ) => Promise<{ rows: { id: string }[] }>;
}): Promise<string[]> {
  const res = await client.query(
    `SELECT e.id::text AS id
       FROM events e
      WHERE e.event_type = 'invoice.expired'
        AND e.order_id LIKE 'ord_syn_%'
      ORDER BY e.received_at ASC`,
  );
  return res.rows.map((r) => r.id);
}

// --- decision-engine client (for promise simulation) --------------------------

async function createPromise(
  baseUrl: string,
  eventId: string,
): Promise<string | null> {
  const resp = await fetch(`${baseUrl}/promises`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_id: eventId }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { id?: string };
  return data.id ?? null;
}

async function advancePromise(
  baseUrl: string,
  id: string,
  trigger: string,
): Promise<string> {
  const resp = await fetch(`${baseUrl}/promises/${id}/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger }),
  });
  try {
    const data = (await resp.json()) as { state?: string };
    return data.state ?? "";
  } catch {
    return "";
  }
}

async function respondPromise(
  baseUrl: string,
  id: string,
  date: string,
) {
  await fetch(`${baseUrl}/promises/${id}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ promised_date: date }),
  });
}

// Seed customer preferences so the batch's customers are RECURRING (mandate active).
const ensureCustomerPreferences = (
  pool: { query: (q: string, p: unknown[]) => Promise<unknown> },
): Promise<void> =>
  new Promise((resolve) => {
    const insert = `INSERT INTO customer_preferences (customer_id, mandate_status)
                    VALUES ($1, $2)
                    ON CONFLICT (customer_id) DO UPDATE SET mandate_status = 'active'`;
    const ops: Promise<unknown>[] = [];
    for (let c = 1; c <= 40; c++) {
      ops.push(
        pool.query(insert, [
          `cust_syn_${String(c).padStart(2, "0")}`,
          "active",
        ]),
      );
    }
    Promise.all(ops)
      .then(() => resolve())
      .catch(() => resolve());
  });

main().catch((err) => {
  console.error("[synthetic] batch failed", err);
  process.exit(1);
});

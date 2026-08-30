// Razorpay client — test-mode stubs wired from environment keys.
// Honest limitation, documented in the README: we don't hold real dual-purpose keys
// in the repo, so external calls are stubbed with the same calling convention the
// live SDKs use. RETRY_PAYMENT / SEND_PAYMENT_LINK / link-payment confirmation all
// flow through here so swapping in the real SDK later is a drop-in change.

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

function flag(name: string): boolean {
  return process.env[name] === "1" || process.env[name] === "true";
}

// Deterministic per-order success for the synthetic batch.
//
// The existing bool flags (RAZORPAY_RETRY_SUCCEEDS / RAZORPAY_LINK_PAID) are kept
// as force-on/force-off. When neither is set and RAZORPAY_SUCCESS_RATE is present
// (a 0..1 fraction), each order's outcome is decided deterministically from a hash
// of order_id + kind + seed — so a batch run reproduces the exact same set of
// confirmed recoveries every time, while still letting a believable fraction of
// orders fail (a 100% recovery rate would read as cherry-picked).
function orderSucceeds(orderId: string, kind: string): boolean {
  // Backward-compatible force flags (Phase 4): RAZORPAY_RETRY_SUCCEEDS / RAZORPAY_LINK_PAID.
  const forceFlag = kind === "RETRY_SUCCEEDS" ? "RAZORPAY_RETRY_SUCCEEDS" : "RAZORPAY_LINK_PAID";
  const forced = process.env[forceFlag];
  if (forced === "1" || forced === "true") return true;
  if (forced === "0" || forced === "false") return false;

  const raw = process.env.RAZORPAY_SUCCESS_RATE;
  if (raw === undefined || raw === "") return false;
  const rate = Number(raw);
  if (!Number.isFinite(rate)) return false;

  const seed = process.env.RAZORPAY_SEED || "demo";
  const h = fnv1a(`${kind}:${orderId}:${seed}`);
  return (h % 100000) / 100000 < rate;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const razorpayClient = {
  async createPaymentLink(params: { amount: number; customerId: string; orderId: string }) {
    console.log(
      `[Razorpay:STUB] creating payment link order=${params.orderId} amount_paise=${params.amount} key=${RAZORPAY_KEY_ID ? "set" : "unset"}`,
    );
    return {
      // In stub mode the "payment link" is a deterministic, traceable placeholder.
      short_url: `https://rzp.t/pay/${params.orderId}`,
      amount: params.amount,
      status: "created",
      kind: "payment_link",
    };
  },

  async retryPayment(orderId: string) {
    const succeeded = orderSucceeds(orderId, "RETRY_SUCCEEDS");
    console.log(
      `[Razorpay:STUB] retrying order=${orderId} -> ${
        succeeded ? "confirmed_capture" : "attempted_no_confirmation"
      }`,
    );
    // Only a *confirmed* capture counts as recovered. The stub reports confirmed
    // capture only when the per-order decision says so; otherwise it stays
    // "attempted" (status=failed, amount not counted) — mirroring the real
    // "don't count until Razorpay confirms capture" rule.
    return {
      status: succeeded ? "confirmed_capture" : "attempted",
      order_id: orderId,
      razorpay_confirmed: succeeded,
    };
  },

  // Used by the SEND_PAYMENT_LINK pending-then-confirmed sweep. Returns whether the
  // linked payment has actually been captured and the REAL per-order amount that
  // captured (passed in from the source event) — so recovered ₹ is truthful, not a
  // single global placeholder. Stub: honors per-order decision (and the
  // RAZORPAY_LINK_PAID force flag), otherwise the link stays unpaid (pending).
  async checkPaymentLinkPayment(orderId: string, amount_paise: number) {
    const paid = orderSucceeds(orderId, "LINK_PAID");
    const forceAmount = Number(process.env.RAZORPAY_LINK_PAID_AMOUNT || "0");
    const amount = paid ? (amount_paise > 0 ? amount_paise : forceAmount) : 0;
    console.log(`[Razorpay:STUB] checking link payment order=${orderId} -> ${paid ? "captured" : "unpaid"}`);
    return { paid, amount_captured_paise: amount, order_id: orderId };
  },
};

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
    const succeeded = flag("RAZORPAY_RETRY_SUCCEEDS");
    console.log(
      `[Razorpay:STUB] retrying order=${orderId} -> ${
        succeeded ? "confirmed_capture" : "attempted_no_confirmation"
      }`,
    );
    // Only a *confirmed* capture counts as recovered. The stub reports confirmed
    // capture only when the RAZORPAY_RETRY_SUCCEEDS flag is set; otherwise it
    // stays "attempted" (status=failed, amount not counted) — mirroring the real
    // "don't count until Razorpay confirms capture" rule.
    return {
      status: succeeded ? "confirmed_capture" : "attempted",
      order_id: orderId,
      razorpay_confirmed: succeeded,
    };
  },

  // Used by the SEND_PAYMENT_LINK pending-then-confirmed sweep. Returns whether the
  // linked payment has actually been captured. Stub: honors RAZORPAY_LINK_PAID flag,
  // otherwise the link stays unpaid (pending) until a real integration confirms it.
  async checkPaymentLinkPayment(orderId: string) {
    const paid = flag("RAZORPAY_LINK_PAID");
    const amount = Number(process.env.RAZORPAY_LINK_PAID_AMOUNT || "0");
    console.log(`[Razorpay:STUB] checking link payment order=${orderId} -> ${paid ? "captured" : "unpaid"}`);
    return { paid, amount_captured_paise: paid ? amount : 0, order_id: orderId };
  },
};

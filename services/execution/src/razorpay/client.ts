// Razorpay client stub — will be wired with real API in Phase 4
// Uses test-mode keys from environment variables

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

export const razorpayClient = {
  async createPaymentLink(params: { amount: number; customerId: string; orderId: string }) {
    console.log(`[Razorpay] creating payment link for order=${params.orderId} amount=${params.amount}`);
    return {
      short_url: `https://rzp.t/${params.orderId}`,
      amount: params.amount,
      status: "created",
    };
  },

  async retryPayment(orderId: string) {
    console.log(`[Razorpay] retrying payment for order=${orderId}`);
    return { status: "attempted", order_id: orderId };
  },
};

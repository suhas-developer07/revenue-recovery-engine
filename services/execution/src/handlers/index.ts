import { RecoveryAction } from "../schema/action";
import { razorpayClient } from "../razorpay/client";
import * as db from "../db/pg";
import { EmailAdapter } from "../adapters/email.adapter";
import { SMSAdapter } from "../adapters/sms.adapter";
import { WhatsAppAdapter } from "../adapters/whatsapp.adapter";
import { VoiceAdapter } from "../adapters/voice.adapter";

const sms = new SMSAdapter();
const email = new EmailAdapter();
const whatsapp = new WhatsAppAdapter();
const voice = new VoiceAdapter();

const LLM_ORCHESTRATOR_URL = process.env.LLM_ORCHESTRATOR_URL || "http://localhost:8084";

export type HandlerOutcome = {
  status: "success" | "failed" | "pending";
  amount_recovered_paise: number;
  outcome_payload: unknown;
};

export type DispatchInput = {
  decision_id: string;
  event_id: string;
  amount_paise: number;
  action: RecoveryAction;
};

async function draftReminder(action: RecoveryAction, amountPaise: number): Promise<string> {
  const narrative = await db.getNarrativeByOrderId(action.target.order_id);
  const riskCategory = narrative?.risk_category ?? "unknown";
  const rootCause = narrative?.root_cause_narrative ?? "";

  // Ask the LLM Orchestrator for message copy. Tight input, tight output — the LLM
  // never decides *whether* or *who* to contact; it only words the message on an
  // already-authorized, already-targeted action.
  const resp = await fetch(`${LLM_ORCHESTRATOR_URL}/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      risk_category: riskCategory,
      root_cause_narrative: rootCause,
      amount_paise: amountPaise,
      channel: action.channel,
      attempt_number: action.attempt_number,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`draft endpoint failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { message?: string };
  if (typeof data.message !== "string" || data.message.length === 0) {
    throw new Error("draft endpoint returned no message");
  }
  return data.message;
}

async function sendThroughAdapter(params: {
  channel: string;
  customerId: string;
  orderId: string;
  message: string;
}): Promise<{ ok: boolean; detail: string }> {
  const to = params.customerId;
  switch (params.channel) {
    case "email": {
      const r = await email.send({ to, message: params.message });
      return { ok: r.success, detail: r.messageId };
    }
    case "sms": {
      const r = await sms.send({ to, message: params.message });
      return { ok: r.success, detail: r.messageId };
    }
    case "whatsapp": {
      const r = await whatsapp.send({ to, message: params.message });
      return { ok: r.success, detail: r.messageId };
    }
    case "voice": {
      const r = await voice.send({ to, message: params.message });
      return { ok: r.success, detail: r.messageId };
    }
    default:
      // 'in_app' / 'none' have no outbound adapter; treat as a logged delivery.
      console.log(`[CHANNEL:${params.channel}] staged message for order=${params.orderId}: "${params.message}"`);
      return { ok: true, detail: `logged for channel ${params.channel}` };
  }
}

export async function runHandler(input: DispatchInput): Promise<HandlerOutcome> {
  const { action, amount_paise, event_id } = input;
  const orderId = action.target.order_id;
  const customerId = action.target.customer_id ?? "";

  switch (action.action) {
    case "RETRY_PAYMENT": {
      const result = await razorpayClient.retryPayment(orderId);
      // Only a *confirmed* capture counts as recovered. Otherwise failed + 0.
      if (result.razorpay_confirmed) {
        return {
          status: "success",
          amount_recovered_paise: amount_paise,
          outcome_payload: { kind: "retry", razorpay: result },
        };
      }
      return {
        status: "failed",
        amount_recovered_paise: 0,
        outcome_payload: {
          kind: "retry",
          razorpay: result,
          note: "retry attempted but capture not confirmed — recovery not counted",
        },
      };
    }

    case "SEND_PAYMENT_LINK": {
      const link = await razorpayClient.createPaymentLink({
        amount: amount_paise,
        customerId,
        orderId,
      });
      // Recover accounting methodology: a payment link does NOT recover money the
      // moment it is created — the customer paying it later does. So this action is
      // recorded as 'pending' with amount 0, and a follow-up sweep flips it to
      // 'success' + the real amount once the linked payment actually captures.
      return {
        status: "pending",
        amount_recovered_paise: 0,
        outcome_payload: { kind: "payment_link", link },
      };
    }

    case "SEND_REMINDER": {
      let message: string;
      try {
        message = await draftReminder(action, amount_paise);
      } catch (err: any) {
        console.error("draft failed for reminder", err);
        return {
          status: "failed",
          amount_recovered_paise: 0,
          outcome_payload: { kind: "reminder", error: String(err?.message ?? err) },
        };
      }
      const sent = await sendThroughAdapter({
        channel: action.channel,
        customerId,
        orderId,
        message,
      });
      return {
        status: sent.ok ? "success" : "failed",
        amount_recovered_paise: 0,
        outcome_payload: {
          kind: "reminder",
          channel: action.channel,
          message,
          delivery: sent.detail,
        },
      };
    }

    case "ESCALATE_TO_HUMAN": {
      // Soft landing, not a dead end: surface as a human todo in the dashboard.
      // No external call — just an audit row (status pending).
      return {
        status: "pending",
        amount_recovered_paise: 0,
        outcome_payload: {
          kind: "escalation",
          reason: action.reasoning,
          event_id,
          note: "queued for human review in dashboard",
        },
      };
    }

    case "LOG_PROMISE_TO_PAY": {
      // Thin pass-through: Phase 5 promotes this into a real promises row. For now,
      // record the audit row so the intent is visible and countable.
      return {
        status: "success",
        amount_recovered_paise: 0,
        outcome_payload: {
          kind: "promise_to_pay",
          order_id: orderId,
          note: "promise-to-pay recorded; Phase 5 promotes this into the promises state machine",
        },
      };
    }

    case "STOP_SEQUENCE": {
      // Terminal marker: no external call, audit row confirming deliberate halt.
      return {
        status: "success",
        amount_recovered_paise: 0,
        outcome_payload: {
          kind: "stop_sequence",
          order_id: orderId,
          reason: action.reasoning,
        },
      };
    }

    default:
      return {
        status: "failed",
        amount_recovered_paise: 0,
        outcome_payload: { kind: "unknown_action", action: action.action },
      };
  }
}

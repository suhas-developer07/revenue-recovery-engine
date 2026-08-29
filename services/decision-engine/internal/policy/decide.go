package policy

import (
	"fmt"
	"time"
)

// Decide runs the full propose → check → authorize/block flow for one classified
// event. It always returns a complete DecisionTrace with an ordered list of the
// checks run, ending in either an authorized action (AuthorizedByRule set) or a
// blocked decision (Blocked=true, BlockReason set). Nothing executes outside this.
func Decide(ctx DecisionContext) DecisionTrace {
	if ctx.Now.IsZero() {
		ctx.Now = time.Now()
	}
	if ctx.AttemptNumber == 0 {
		ctx.AttemptNumber = 1
	}

	t := DecisionTrace{
		EventID:         ctx.EventID,
		CandidateAction: CandidateFromRiskCategory(ctx.RiskCategory),
		Target:          Target{OrderID: ctx.OrderID, CustomerID: ctx.CustomerID},
		AttemptNumber:   ctx.AttemptNumber,
	}

	add := func(name, inputs string, passed bool, reason string) {
		t.Checks = append(t.Checks, CheckResult{RuleName: name, Inputs: inputs, Passed: passed, Reason: reason})
	}

	// ---- Phase 1: hard kill-switches (dead-on-arrival checks) ----------------
	if passed, reason := IsMandateRevoked(ctx.MandateStatus); !passed {
		add("IsMandateRevoked", fmt.Sprintf("mandate_status=%s", ctx.MandateStatus), false, reason)
		return finalize(&t, ActionStopSequence, ChannelNone, "MANDATE_REVOKED_STOP_SEQUENCE", false,
			"recurring mandate revoked — stopping all automated recovery", nil)
	}
	add("IsMandateRevoked", fmt.Sprintf("mandate_status=%s", ctx.MandateStatus), true, "")

	if passed, reason := HasExceededEscalationCeiling(ctx.EscalationCount, DefaultEscalationCeiling); !passed {
		add("HasExceededEscalationCeiling", fmt.Sprintf("escalation_count=%d/ceiling=%d", ctx.EscalationCount, DefaultEscalationCeiling), false, reason)
		return finalize(&t, ActionStopSequence, ChannelNone, "ESCALATION_CEILING_REACHED_STOP", false,
			"total escalation attempts exhausted — downgrading to human review", nil)
	}
	add("HasExceededEscalationCeiling", fmt.Sprintf("escalation_count=%d/ceiling=%d", ctx.EscalationCount, DefaultEscalationCeiling), true, "")

	// ---- Phase 2: candidate-action authorization -------------------------------
	action := t.CandidateAction
	channel := ChannelNone
	authorizedBy := ""

	// Family-specific checks (cooldown / AFA / pre-debit) apply to retries.
	switch action {
	case ActionRetryPayment, ActionStopSequence:
		// For a stop-sequence candidate, nothing further needs routing to a channel.
		if action == ActionStopSequence {
			return finalize(&t, ActionStopSequence, ChannelNone, "STOP_SEQUENCE_DEFAULT", false,
				"no compliant automated recovery for this classification", nil)
		}

		// Retry ceiling: don't fire a 4th+ auto-retry.
		if passed, reason := HasExceededMaxAttempts(ctx.AttemptNumber, DefaultMaxAttempts); !passed {
			add("HasExceededMaxAttempts", fmt.Sprintf("attempt_number=%d/cap=%d", ctx.AttemptNumber, DefaultMaxAttempts), false, reason)
			return finalize(&t, ActionEscalateToHuman, ChannelNone, "MAX_ATTEMPTS_EXCEEDED_ROUTES_TO_ESCALATION", false,
				"max auto-retries exhausted — escalating to human review", nil)
		}
		add("HasExceededMaxAttempts", fmt.Sprintf("attempt_number=%d/cap=%d", ctx.AttemptNumber, DefaultMaxAttempts), true, "")

		// Backoff: respect the scheduled next-attempt time.
		if passed, reason := IsWithinCooldown(ctx.CooldownUntil, ctx.Now); !passed {
			add("IsWithinCooldown", "cooldown_until", false, reason)
			return finalize(&t, ActionRetryPayment, ChannelNone, "", true, reason, ctx.CooldownUntil)
		}
		add("IsWithinCooldown", "cooldown_until", true, "")

		// Recurrence-specific compliance: AFA threshold + pre-debit notice apply
		// ONLY to auto-debits (mandates), not one-time payments.
		if ctx.Recurring {
			// AFA threshold: above ₹15k a recurring charge can't be blindly retried —
			// route to an authenticated payment link instead (the AFA branching moment).
			if passed, reason := IsBelowAFAThreshold(ctx.AmountPaise); !passed {
				add("IsBelowAFAThreshold", fmt.Sprintf("amount_paise=%d", ctx.AmountPaise), false, reason)
				return finalize(&t, ActionSendPaymentLink, ChannelEmail, "AFA_THRESHOLD_EXCEEDED_ROUTES_TO_PAYMENT_LINK", false,
					"recurring charge above ₹15,000 AFA threshold — sending authenticated payment link instead of blind retry", nil)
			}
			add("IsBelowAFAThreshold", fmt.Sprintf("amount_paise=%d", ctx.AmountPaise), true, "")

			// Pre-debit notice window: customer must have been notified ≥24h before the debit.
			if passed, reason := IsWithinPreDebitWindow(ctx.PreDebitNoticeAt, ctx.Now); !passed {
				add("IsWithinPreDebitWindow", "pre_debit_notice", false, reason)
				return finalize(&t, ActionRetryPayment, ChannelNone, "", true, reason, nil)
			}
			add("IsWithinPreDebitWindow", "pre_debit_notice", true, "")
		}

		authorizedBy = "RETRY_ALLOWED_BELOW_15K_AFA_THRESHOLD"

	case ActionSendPaymentLink, ActionSendReminder:
		sel, ok := selectChannel(ctx.OptedOutChannels)
		if !ok {
			add("IsOptedOut", fmt.Sprintf("opted_out=%v", ctx.OptedOutChannels), false, "CUSTOMER_OPTED_OUT_OF_CHANNEL")
			return finalize(&t, action, ChannelNone, "", true, "CUSTOMER_OPTED_OUT_OF_CHANNEL", nil)
		}
		channel = sel
		add("IsOptedOut", fmt.Sprintf("opted_out=%v selected=%s", ctx.OptedOutChannels, sel), true, "")

		// Quiet hours gate PROACTIVE nudges (SEND_REMINDER) only. A SEND_PAYMENT_LINK
		// is an action-focused, expected recovery after a failed payment — it is not
		// a nap-disrupting unsolicited contact, so it is not quiet-hour-blocked.
		if action == ActionSendReminder && channel != ChannelInApp {
			if passed, reason := IsOutsideQuietHours(ctx.Now, ctx.Timezone); !passed {
				add("IsOutsideQuietHours", fmt.Sprintf("now=%s tz=%s", ctx.Now.Format(time.RFC3339), ctx.Timezone), false, reason)
				return finalize(&t, action, channel, "", true, reason, nil)
			}
			add("IsOutsideQuietHours", fmt.Sprintf("now=%s tz=%s", ctx.Now.Format(time.RFC3339), ctx.Timezone), true, "")
		}

		if action == ActionSendPaymentLink {
			authorizedBy = "SEND_AUTHENTICATED_PAYMENT_LINK_ALLOWED"
		} else {
			authorizedBy = "SEND_REMINDER_ALLOWED"
		}

	default:
		return finalize(&t, action, ChannelNone, "STOP_SEQUENCE_DEFAULT", false,
			"no compliant automated recovery path for this classification", nil)
	}

	var cooldown *time.Time
	if action == ActionRetryPayment {
		// Authorized retry: record the scheduled next-attempt backoff in the trace,
		// so the serialized action carries cooldown_until (Phase 4 zod expects it).
		cooldown = BackoffCooldown(ctx.AttemptNumber, ctx.Now)
	}
	return finalize(&t, action, channel, authorizedBy, false, "all policy checks passed", cooldown)
}

// selectChannel picks the first allowed customer-facing channel, preferring
// higher-friction preferences in order, falling back to in-app when outbound
// channels are all opted out. Returns ok=false if in-app itself is opted out.
func selectChannel(optedOut []Channel) (Channel, bool) {
	candidates := []Channel{ChannelEmail, ChannelSMS, ChannelWhatsApp, ChannelInApp}
	isOpt := func(c Channel) bool {
		for _, o := range optedOut {
			if o == c {
				return true
			}
		}
		return false
	}
	for _, c := range candidates {
		if !isOpt(c) {
			return c, true
		}
	}
	return ChannelNone, false
}

// finalize populates the stop fields of a trace and returns it.
func finalize(t *DecisionTrace, action Action, channel Channel, authorizedBy string, blocked bool, reasoning string, cooldown *time.Time) DecisionTrace {
	t.FinalAction = action
	t.FinalChannel = channel
	t.AuthorizedByRule = authorizedBy
	t.Blocked = blocked
	t.Reasoning = reasoning
	t.CooldownUntil = cooldown
	if blocked {
		t.BlockReason = reasoning
		t.FailedCheck = lastFailedRule(t)
	}
	return *t
}

func lastFailedRule(t *DecisionTrace) string {
	for i := len(t.Checks) - 1; i >= 0; i-- {
		if !t.Checks[i].Passed {
			return t.Checks[i].RuleName
		}
	}
	return ""
}

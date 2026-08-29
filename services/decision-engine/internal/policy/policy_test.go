package policy

import (
	"encoding/json"
	"testing"
	"time"
)

func baseCtx() DecisionContext {
	now := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	notice := now.Add(-25 * time.Hour) // notified >24h ago → compliant
	return DecisionContext{
		EventID:          "evt-1",
		OrderID:          "order-1",
		CustomerID:       "cust-1",
		RiskCategory:     RiskCategoryInsufficientFunds,
		AmountPaise:      500000, // ₹5,000
		AttemptNumber:    1,
		MandateStatus:    "active",
		Recurring:        true,
		PreDebitNoticeAt: &notice,
		Timezone:         "Asia/Kolkata",
		OptedOutChannels: []Channel{},
		Now:              now,
	}
}

// ---- pure function unit tests ------------------------------------------------

func TestIsBelowAFAThreshold(t *testing.T) {
	cases := []struct {
		amt   int64
		below bool
	}{
		{1499999, true},  // just under ₹15,000
		{1500000, false}, // at the threshold → NOT below → transform
		{1500001, false}, // just over
		{0, true},
	}
	for _, c := range cases {
		passed, _ := IsBelowAFAThreshold(c.amt)
		if passed != c.below {
			t.Errorf("IsBelowAFAThreshold(%d) = %v, want %v", c.amt, passed, c.below)
		}
	}
}

func TestIsWithinPreDebitWindow(t *testing.T) {
	now := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	notice24hAgo := now.Add(-25 * time.Hour) // notified ≥24h ago → allowed
	notice1hAgo := now.Add(-1 * time.Hour)   // notified only 1h before → blocked

	if p, r := IsWithinPreDebitWindow(&notice24hAgo, now); !p {
		t.Errorf("24h-old notice should pass, got %v %v", p, r)
	}
	if p, _ := IsWithinPreDebitWindow(&notice1hAgo, now); p {
		t.Error("1h-old notice should fail (inside window)")
	}
	if p, _ := IsWithinPreDebitWindow(nil, now); p {
		t.Error("missing notice should fail")
	}
}

func TestIsWithinCooldown(t *testing.T) {
	now := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)

	if p, _ := IsWithinCooldown(nil, now); !p {
		t.Error("no cooldown recorded should pass")
	}
	future := now.Add(time.Hour)
	if p, _ := IsWithinCooldown(&future, now); p {
		t.Error("cooldown in the future should block")
	}
	past := now.Add(-time.Hour)
	if p, _ := IsWithinCooldown(&past, now); !p {
		t.Error("expired cooldown should pass")
	}
}

func TestIsOutsideQuietHours(t *testing.T) {
	zoned := func(hour int) time.Time {
		loc, _ := time.LoadLocation("Asia/Kolkata")
		return time.Date(2026, 8, 29, hour, 0, 0, 0, loc)
	}
	for _, h := range []int{9, 12, 18} {
		if p, _ := IsOutsideQuietHours(zoned(h), "Asia/Kolkata"); !p {
			t.Errorf("hour %d should be within quiet hours", h)
		}
	}
	for _, h := range []int{8, 19, 22} {
		if p, _ := IsOutsideQuietHours(zoned(h), "Asia/Kolkata"); p {
			t.Errorf("hour %d should be outside quiet hours (block)", h)
		}
	}
}

func TestHasExceededMaxAttempts(t *testing.T) {
	if p, _ := HasExceededMaxAttempts(3, 3); !p {
		t.Error("attempt == cap should pass")
	}
	if p, _ := HasExceededMaxAttempts(4, 3); p {
		t.Error("attempt > cap should fail")
	}
}

func TestHasExceededEscalationCeiling(t *testing.T) {
	if p, _ := HasExceededEscalationCeiling(4, 5); !p {
		t.Error("4/5 should pass")
	}
	if p, _ := HasExceededEscalationCeiling(5, 5); p {
		t.Error("5/5 should fail (at ceiling)")
	}
}

func TestIsMandateRevoked(t *testing.T) {
	if p, _ := IsMandateRevoked("active"); !p {
		t.Error("active mandate should pass")
	}
	if p, _ := IsMandateRevoked("revoked"); p {
		t.Error("revoked mandate should fail")
	}
}

func TestIsOptedOut(t *testing.T) {
	if p, _ := IsOptedOut(ChannelEmail, []Channel{ChannelSMS}); !p {
		t.Error("email should be allowed when only SMS is opted out")
	}
	if p, _ := IsOptedOut(ChannelEmail, []Channel{ChannelEmail}); p {
		t.Error("opted-out email should block")
	}
	if p, _ := IsOptedOut(ChannelNone, nil); p {
		t.Error("no channel should block")
	}
}

func TestBackoffCooldown(t *testing.T) {
	// attempt 1 → 6h, attempt 3 → 24h (covers salary-credit windows).
	now := time.Now()
	if got := BackoffCooldown(1, now).Sub(now); got != 6*time.Hour {
		t.Errorf("attempt 1 backoff should be 6h, got %v", got)
	}
	if got := BackoffCooldown(3, now).Sub(now); got != 24*time.Hour {
		t.Errorf("attempt 3 backoff should be 24h, got %v", got)
	}
}

// ---- end-to-end decide() scenarios --------------------------------------------

func TestDecideAuthorizesBelowThresholdRetry(t *testing.T) {
	ctx := baseCtx() // ₹5k, active mandate, recurring, attempt 1, midday
	trace := Decide(ctx)

	if trace.Blocked {
		t.Fatalf("unexpected block: %s (%s)", trace.FailedCheck, trace.BlockReason)
	}
	if trace.FinalAction != ActionRetryPayment {
		t.Errorf("expected RETRY_PAYMENT, got %s", trace.FinalAction)
	}
	if trace.AuthorizedByRule == "" {
		t.Error("authorized retry must set an authorized_by_rule")
	}
}

func TestDecideTransformsHighValueRecurringToPaymentLink(t *testing.T) {
	ctx := baseCtx()
	ctx.AmountPaise = 2000000 // ₹20,000 above ₹15k AFA ceiling
	notice := ctx.Now.Add(-25 * time.Hour)
	ctx.PreDebitNoticeAt = &notice
	trace := Decide(ctx)

	if trace.Blocked {
		t.Fatalf("unexpected block: %s", trace.FailedCheck)
	}
	if trace.FinalAction != ActionSendPaymentLink {
		t.Errorf("AFA threshold should route to SEND_PAYMENT_LINK, got %s", trace.FinalAction)
	}
	if trace.AuthorizedByRule != "AFA_THRESHOLD_EXCEEDED_ROUTES_TO_PAYMENT_LINK" {
		t.Errorf("unexpected authorization rule: %s", trace.AuthorizedByRule)
	}
}

func TestDecideStopsOnRevokedMandate(t *testing.T) {
	ctx := baseCtx()
	ctx.MandateStatus = "revoked"
	ctx.Recurring = false
	trace := Decide(ctx)

	if trace.Blocked {
		t.Error("mandate-revoked stop-sequence is an authorized stop, not a block")
	}
	if trace.FinalAction != ActionStopSequence {
		t.Errorf("expected STOP_SEQUENCE, got %s", trace.FinalAction)
	}
	if trace.AuthorizedByRule != "MANDATE_REVOKED_STOP_SEQUENCE" {
		t.Errorf("unexpected rule: %s", trace.AuthorizedByRule)
	}
}

func TestDecideRoutesToEscalationAfterMaxAttempts(t *testing.T) {
	ctx := baseCtx()
	ctx.AttemptNumber = 4 // > DefaultMaxAttempts(3)
	ctx.Recurring = false
	trace := Decide(ctx)

	if trace.Blocked {
		t.Fatal("max-attempts escalation is a route, not a block")
	}
	if trace.FinalAction != ActionEscalateToHuman {
		t.Errorf("expected ESCALATE_TO_HUMAN, got %s", trace.FinalAction)
	}
	if trace.AuthorizedByRule != "MAX_ATTEMPTS_EXCEEDED_ROUTES_TO_ESCALATION" {
		t.Errorf("unexpected rule: %s", trace.AuthorizedByRule)
	}
}

func TestDecideBlocksWithinCooldown(t *testing.T) {
	ctx := baseCtx()
	ctx.AttemptNumber = 2
	future := ctx.Now.Add(time.Hour)
	ctx.CooldownUntil = &future
	ctx.Recurring = false
	trace := Decide(ctx)

	if !trace.Blocked {
		t.Fatal("expected a block during cooldown")
	}
	if trace.FinalAction != ActionRetryPayment {
		t.Errorf("blocked retry should still record RETRY_PAYMENT candidate, got %s", trace.FinalAction)
	}
	if trace.FailedCheck != "IsWithinCooldown" {
		t.Errorf("expected failed check IsWithinCooldown, got %s", trace.FailedCheck)
	}
}

func TestDecideStopsAtEscalationCeiling(t *testing.T) {
	ctx := baseCtx()
	ctx.EscalationCount = 5
	ctx.Recurring = false
	trace := Decide(ctx)

	if trace.Blocked {
		t.Error("ceiling stop is an authorized stop, not a block")
	}
	if trace.FinalAction != ActionStopSequence {
		t.Errorf("expected STOP_SEQUENCE, got %s", trace.FinalAction)
	}
	if trace.AuthorizedByRule != "ESCALATION_CEILING_REACHED_STOP" {
		t.Errorf("unexpected rule: %s", trace.AuthorizedByRule)
	}
}

func TestDecideBlocksReminderDuringQuietHours(t *testing.T) {
	ctx := baseCtx()
	ctx.RiskCategory = RiskCategoryInvoiceOverdue // candidate = SEND_REMINDER
	ctx.Now = time.Date(2026, 8, 29, 22, 0, 0, 0, time.UTC)
	ctx.Recurring = false

	trace := Decide(ctx)
	if !trace.Blocked {
		t.Fatal("expected a block when outside quiet hours")
	}
	if trace.FailedCheck != "IsOutsideQuietHours" {
		t.Errorf("expected failed check IsOutsideQuietHours, got %s", trace.FailedCheck)
	}
}

func TestDecidePaymentLinkNotQuietHourBlocked(t *testing.T) {
	// AFA-routed payment link is an action-focused, expected recovery: it is
	// authorized even outside quiet hours (ok to send a payment link at night,
	// where an unsolicited reminder would be a compliance nap violation).
	ctx := baseCtx()
	ctx.AmountPaise = 2000000 // ₹20,000 above AFA threshold → SEND_PAYMENT_LINK
	ctx.Now = time.Date(2026, 8, 29, 22, 0, 0, 0, time.UTC)
	notice := ctx.Now.Add(-25 * time.Hour)
	ctx.PreDebitNoticeAt = &notice

	trace := Decide(ctx)
	if trace.Blocked {
		t.Fatalf("payment link should not be quiet-hour blocked, got: %s", trace.BlockReason)
	}
	if trace.FinalAction != ActionSendPaymentLink {
		t.Errorf("expected SEND_PAYMENT_LINK, got %s", trace.FinalAction)
	}
}

func TestDecideBlocksReminderWhenFullyOptedOut(t *testing.T) {
	ctx := baseCtx()
	ctx.RiskCategory = RiskCategoryInvoiceOverdue // SEND_REMINDER candidate
	ctx.Recurring = false
	ctx.OptedOutChannels = []Channel{ChannelEmail, ChannelSMS, ChannelWhatsApp, ChannelInApp}
	ctx.Now = time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)

	trace := Decide(ctx)
	if !trace.Blocked {
		t.Fatal("expected a block when every channel is opted out")
	}
	if trace.BlockReason != "CUSTOMER_OPTED_OUT_OF_CHANNEL" {
		t.Errorf("expected CUSTOMER_OPTED_OUT_OF_CHANNEL, got %s", trace.BlockReason)
	}
}

func TestDecideFallsBackToNextChannelWhenPrimaryOptedOut(t *testing.T) {
	ctx := baseCtx()
	ctx.RiskCategory = RiskCategoryInvoiceOverdue
	ctx.Recurring = false
	ctx.OptedOutChannels = []Channel{ChannelEmail} // email is primary; sms should win
	ctx.Now = time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)

	trace := Decide(ctx)
	if trace.Blocked {
		t.Fatalf("expected fallback channel, got block: %s", trace.BlockReason)
	}
	if trace.FinalChannel != ChannelSMS {
		t.Errorf("expected fallback to SMS, got %s", trace.FinalChannel)
	}
}

func TestExplainRendersDecisionChain(t *testing.T) {
	trace := Decide(baseCtx())
	out := trace.Explain()
	if out == "" {
		t.Fatal("expected non-empty explanation")
	}
	if len(trace.Checks) == 0 {
		t.Fatal("expected accumulated checks in trace")
	}
}

func TestTraceIncludesTarget(t *testing.T) {
	// Phase 4's zod schema requires `target: { order_id }`. Without it every
	// authorized action would be rejected at execution time.
	trace := Decide(baseCtx())
	if trace.Target.OrderID != "order-1" || trace.Target.CustomerID != "cust-1" {
		t.Errorf("expected target order-1/cust-1, got %s/%s",
			trace.Target.OrderID, trace.Target.CustomerID)
	}
}

func TestSerializedTraceSatisfiesActionSchema(t *testing.T) {
	// Assert the fields Phase 4 zod-validates (RecoveryActionSchema) are all
	// present in the serialized trace, mirroring docs/action.schema.json's
	// required set: action, target.order_id, reasoning, attempt_number, plus
	// channel, authorized_by_rule, cooldown_until.
	trace := Decide(baseCtx())
	raw, _ := json.Marshal(trace)

	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("trace did not marshal as JSON object: %v", err)
	}

	required := []string{"final_action", "target", "reasoning", "attempt_number",
		"final_channel", "authorized_by_rule", "cooldown_until"}
	for _, f := range required {
		if _, ok := obj[f]; !ok {
			t.Errorf("serialized decision missing field required by action schema: %s", f)
		}
	}

	var target map[string]json.RawMessage
	if err := json.Unmarshal(obj["target"], &target); err != nil {
		t.Fatalf("target not an object: %v", err)
	}
	if _, ok := target["order_id"]; !ok {
		t.Error("target missing required order_id")
	}
}

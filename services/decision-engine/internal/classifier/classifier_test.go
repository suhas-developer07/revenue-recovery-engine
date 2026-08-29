package classifier

import (
	"context"
	"strings"
	"testing"
)

func TestValidCategory(t *testing.T) {
	for _, c := range ValidCategories {
		if !ValidCategory(c) {
			t.Errorf("expected %q to be valid", c)
		}
	}
	if ValidCategory("not_a_category") {
		t.Error("expected 'not_a_category' to be invalid")
	}
	if ValidCategory("") {
		t.Error("expected empty string to be invalid")
	}
}

func TestRecoverabilityWeight(t *testing.T) {
	cases := []struct {
		category string
		min, max float64
	}{
		{CategoryInsufficientFunds, 0.7, 0.7},
		{CategoryRiskBlock, 0.1, 0.1},
		{CategoryMandateRevoked, 0.05, 0.05},
	}
	for _, c := range cases {
		if got := RecoverabilityWeight(c.category); got < c.min || got > c.max {
			t.Errorf("category %s weight = %v, want in [%v, %v]", c.category, got, c.min, c.max)
		}
	}
}

func TestPriorityScoreOrdering(t *testing.T) {
	// A large insufficient-funds failure should outrank a small risk-blocked one.
	high := PriorityScore(200000, CategoryInsufficientFunds) // ₹2000 * 0.7
	low := PriorityScore(2000, CategoryRiskBlock)            // ₹20 * 0.1
	if high <= low {
		t.Errorf("expected high priority to exceed low, high=%v low=%v", high, low)
	}
}

// applyRules-based table test: the rules table must map each representative
// trigger to its intended category.
func TestRulesTableMappings(t *testing.T) {
	cases := []struct {
		signal   string
		category string
	}{
		{"payment.failed insufficient_funds bank declined your transaction", CategoryInsufficientFunds},
		{"payment.failed card_declined", CategoryInsufficientFunds},
		{"payment.failed gateway_timeout", CategoryBankTimeout},
		{"payment.failed bank_unreachable", CategoryBankTimeout},
		{"payment.failed card_expired", CategoryExpiredCard},
		{"payment.failed expired_card", CategoryExpiredCard},
		{"payment.failed otp_authentication_failed", CategoryOtpFailure},
		{"payment.failed incorrect otp", CategoryOtpFailure},
		{"payment.failed fraud detected", CategoryRiskBlock},
		{"payment.failed risk_blocked", CategoryRiskBlock},
		{"subscription.cancelled mandate revoked by customer", CategoryMandateRevoked},
		{"invoice.expired unpaid invoice past due", CategoryInvoiceOverdue},
		{"checkout.abandoned", CategoryCheckoutAbandoned},
	}
	for _, c := range cases {
		got, _, _ := applyRules(c.signal)
		if got != c.category {
			t.Errorf("signal %q -> %q, want %q", c.signal, got, c.category)
		}
	}
}

func TestApplyRulesNoMatch(t *testing.T) {
	cat, _, _ := applyRules("some totally unknown and unusual failure reason")
	if cat != "" {
		t.Errorf("expected no match (empty category), got %q", cat)
	}
}

// fakeLLM implements LLMClassifier for testing the fallback path.
type fakeLLM struct {
	category  string
	narrative string
	err       error
}

func (f *fakeLLM) Classify(_ context.Context, _, _ string) (string, string, error) {
	return f.category, f.narrative, f.err
}

func TestClassifyEvent_LLMFallbackForAmbiguous(t *testing.T) {
	llm := &fakeLLM{category: CategoryInvoiceOverdue, narrative: "invoice note says payment after goods delivered"}
	res, err := ClassifyEvent(context.Background(), llm, "payment.failed", 50000,
		[]byte(`{"payload":{"payment":{"entity":{"error_description":"unusual bank response code XYZ123"}}}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Category != CategoryInvoiceOverdue {
		t.Errorf("expected LLM category %s, got %s", CategoryInvoiceOverdue, res.Category)
	}
	if res.ClassifiedBy != "llm" {
		t.Errorf("expected classified_by=llm, got %s", res.ClassifiedBy)
	}
	if res.PriorityScore <= 0 {
		t.Errorf("expected positive priority score, got %v", res.PriorityScore)
	}
}

func TestClassifyEvent_RulesEngineDominates(t *testing.T) {
	// Even with an LLM present, a clear rules match must not invoke the LLM.
	invoked := false
	fake := &countingLLM{onClassify: func() { invoked = true }}
	res, err := ClassifyEvent(context.Background(), fake, "payment.failed", 10000,
		[]byte(`{"payload":{"payment":{"entity":{"error_code":"insufficient_funds"}}}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if invoked {
		t.Error("LLM should not be invoked when a rules match exists")
	}
	if res.Category != CategoryInsufficientFunds {
		t.Errorf("expected %s, got %s", CategoryInsufficientFunds, res.Category)
	}
	if res.ClassifiedBy != "rules_engine" {
		t.Errorf("expected classified_by=rules_engine, got %s", res.ClassifiedBy)
	}
}

func TestClassifyEvent_EnumValidationCoercesUnknown(t *testing.T) {
	llm := &fakeLLM{category: "totally_made_up_category", narrative: "drifted"}
	res, err := ClassifyEvent(context.Background(), llm, "payment.failed", 100,
		[]byte(`{"payload":{"payment":{"entity":{"error_description":"obscure non-matching reason"}}}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Category != CategoryUnknown {
		t.Errorf("expected coercion to %s, got %s", CategoryUnknown, res.Category)
	}
}

func TestClassifyEvent_LLMUnavailable(t *testing.T) {
	// nil LLM on an ambiguous event must still produce a valid (unknown) category.
	res, err := ClassifyEvent(context.Background(), nil, "payment.failed", 500,
		[]byte(`{"payload":{"payment":{"entity":{"error_description":"wibbly ambiguous reason"}}}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ValidCategory(res.Category) {
		t.Errorf("expected valid category, got %q", res.Category)
	}
}

type countingLLM struct {
	onClassify func()
}

func (f *countingLLM) Classify(_ context.Context, _, _ string) (string, string, error) {
	if f.onClassify != nil {
		f.onClassify()
	}
	return CategoryUnknown, "should not be reached", nil
}

func TestExtractSignalFields(t *testing.T) {
	raw := []byte(`{"event":"payment.failed","payload":{"payment":{"entity":{"error_code":"BAD_REQUEST_ERROR","error_description":"card_declined: insufficient funds"}}}}`)
	sig := extractSignal("payment.failed", raw)
	text := sig.SignalText()
	if !strings.Contains(text, "insufficient") {
		t.Errorf("expected signal text to carry error details, got %q", text)
	}
	if !strings.Contains(text, "payment.failed") {
		t.Errorf("expected event type in signal, got %q", text)
	}
}

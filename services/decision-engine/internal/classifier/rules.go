package classifier

// Closed set of risk categories. The LLM fallback must produce one of these and
// nothing else — validated in code before anything is written to the DB.
const (
	CategoryInsufficientFunds = "insufficient_funds"
	CategoryBankTimeout       = "bank_timeout"
	CategoryExpiredCard       = "expired_card"
	CategoryOtpFailure        = "otp_failure"
	CategoryRiskBlock         = "risk_block"
	CategoryMandateRevoked    = "mandate_revoked"
	CategoryCheckoutAbandoned = "checkout_abandoned"
	CategoryInvoiceOverdue    = "invoice_overdue"
	CategoryUnknown           = "unknown"
)

// ValidCategories is the closed enum used to validate both rules and LLM output.
var ValidCategories = []string{
	CategoryInsufficientFunds,
	CategoryBankTimeout,
	CategoryExpiredCard,
	CategoryOtpFailure,
	CategoryRiskBlock,
	CategoryMandateRevoked,
	CategoryCheckoutAbandoned,
	CategoryInvoiceOverdue,
	CategoryUnknown,
}

// ValidCategory returns true if c is one of the closed categories.
func ValidCategory(c string) bool {
	for _, v := range ValidCategories {
		if v == c {
			return true
		}
	}
	return false
}

// recoverabilityWeight estimates how likely a given risk category is to be
// recoverable with a compliant action. Tuned to feel plausible for a hackathon —
// not empirically derived. Used for priority_score, which drives batch prioritization.
var recoverabilityWeight = map[string]float64{
	CategoryInsufficientFunds: 0.7,
	CategoryBankTimeout:       0.6,
	CategoryExpiredCard:       0.4,
	CategoryOtpFailure:        0.55,
	CategoryRiskBlock:         0.1,
	CategoryMandateRevoked:    0.05,
	CategoryCheckoutAbandoned: 0.6,
	CategoryInvoiceOverdue:    0.75,
	CategoryUnknown:           0.3,
}

// RecoverabilityWeight returns the weight for a category, defaulting to 0.3 for unknown.
func RecoverabilityWeight(category string) float64 {
	if w, ok := recoverabilityWeight[category]; ok {
		return w
	}
	return 0.3
}

// PriorityScore = amount_in_rupees (paise/100) * recoverability_weight.
// Using rupees keeps the number human-sized in the dashboard.
func PriorityScore(amountPaise int64, category string) float64 {
	r := float64(amountPaise) / 100.0
	return r * RecoverabilityWeight(category)
}

// ---------------------------------------------------------------------------
// Rules table — data, not scattered conditionals.
// ---------------------------------------------------------------------------

// rule maps a matching trigger to a risk category. `match` is applied as a
// case-insensitive substring test against the concatenated signal text.
type rule struct {
	category string
	match    []string // any of these substrings triggers the rule (first match wins by table order)
}

// rules is an ordered list: earlier rules take precedence. Substring matching on
// the event's raw signal text lets us ground on realistic Razorpay error reasons.
var rules = []rule{
	// Event-type level rules first (they're cheap and unambiguous).
	{category: CategoryInvoiceOverdue, match: []string{"invoice.expired", "invoice.overdue"}},
	{category: CategoryInvoiceOverdue, match: []string{"invoice.partially_paid", "invoice.due"}},

	// Subscription/mandate signals.
	{category: CategoryMandateRevoked, match: []string{"subscription.cancelled", "subscription.halted", "mandate.revoked", "mandate revoked", "authorization.revoked"}},

	// Checkout abandonment has no webhook — it's a sweep, but we still map the
	// synthetic marker event used by the server-side sweep if one is created.
	{category: CategoryCheckoutAbandoned, match: []string{"checkout.abandoned"}},

	// Error-code / error-reason grounded strings from payment failures.
	{category: CategoryInsufficientFunds, match: []string{"insufficient_funds", "insufficient balance", "insufficient funds", "not enough balance"}},
	{category: CategoryOtpFailure, match: []string{"otp", "3ds", "authentication_failed", "verification_failed", "3d_secure", "authorization_failed", "incorrect otp", "expired otp"}},
	{category: CategoryExpiredCard, match: []string{"expired_card", "card expired", "card_expired", "expired card", "cvv/expiry"}},
	{category: CategoryBankTimeout, match: []string{"bank_timeout", "gateway_timeout", "timed out", "timeout", "server_error", "a timeout", "temporarily unavailable", "bank_unreachable"}},
	{category: CategoryRiskBlock, match: []string{"risk_block", "risk_blocked", "suspected fraud", "fraud", "blocked", "risk", "suspicious", "declined by risk", "payment blocked"}},
	{category: CategoryInsufficientFunds, match: []string{"card_declined", "bank_declined", "declined"}},
}

// ClassifyEnum validates that a category is in the closed set. Convenience re-export.
func ClassifyEnum(c string) bool {
	return ValidCategory(c)
}

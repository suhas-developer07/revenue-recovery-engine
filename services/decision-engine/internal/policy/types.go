package policy

import "time"

// Risk categories as emitted by the classifier (Phase 2). The policy layer keys
// its candidate-action mapping off these.
const (
	RiskCategoryInsufficientFunds = "insufficient_funds"
	RiskCategoryBankTimeout       = "bank_timeout"
	RiskCategoryExpiredCard       = "expired_card"
	RiskCategoryOtpFailure        = "otp_failure"
	RiskCategoryRiskBlock         = "risk_block"
	RiskCategoryMandateRevoked    = "mandate_revoked"
	RiskCategoryCheckoutAbandoned = "checkout_abandoned"
	RiskCategoryInvoiceOverdue    = "invoice_overdue"
	RiskCategoryUnknown           = "unknown"
)

// Action mirrors the action enum in docs/action.schema.json. The policy layer
// only ever authorizes one of these — never a free-form string.
type Action string

const (
	ActionRetryPayment    Action = "RETRY_PAYMENT"
	ActionSendPaymentLink Action = "SEND_PAYMENT_LINK"
	ActionSendReminder    Action = "SEND_REMINDER"
	ActionEscalateToHuman Action = "ESCALATE_TO_HUMAN"
	ActionLogPromiseToPay Action = "LOG_PROMISE_TO_PAY"
	ActionStopSequence    Action = "STOP_SEQUENCE"
)

// Channel mirrors the channel enum in action.schema.json.
type Channel string

const (
	ChannelInApp    Channel = "in_app"
	ChannelSMS      Channel = "sms"
	ChannelEmail    Channel = "email"
	ChannelWhatsApp Channel = "whatsapp"
	ChannelVoice    Channel = "voice"
	ChannelNone     Channel = "none"
)

// DecisionContext bundles everything the policy functions need, fetched ONCE per
// event by the caller (db layer) and passed in. Functions are pure — no DB access.
type DecisionContext struct {
	EventID      string
	OrderID      string
	CustomerID   string
	RiskCategory string
	AmountPaise  int64

	// Attempt history / audit-trail-derived state.
	AttemptNumber   int
	EscalationCount int

	// Timing state.
	CooldownUntil    *time.Time
	LastNotifiedAt   *time.Time
	PreDebitNoticeAt *time.Time

	// Customer / mandate context.
	Recurring        bool   // recurring/auto-debit context (mandate present) — gates AFA + pre-debit rules
	MandateStatus    string // "active" | "revoked" | ""
	OptedOutChannels []Channel
	Timezone         string

	Now time.Time
}

// CheckResult is one step in the reasoning trace. decide.go accumulates these
// regardless of whether --explain was requested, so the trace always reflects
// exactly what ran.
type CheckResult struct {
	RuleName string `json:"rule_name"`
	Inputs   string `json:"inputs"`
	Passed   bool   `json:"passed"`
	Reason   string `json:"reason,omitempty"`
}

// DecisionTrace is the full ordered reasoning chain for one event, plus the final
// outcome. It is what --explain and GET /decisions/:event_id/explain render.
type DecisionTrace struct {
	EventID          string        `json:"event_id"`
	CandidateAction  Action        `json:"candidate_action"`
	Checks           []CheckResult `json:"checks"`
	FailedCheck      string        `json:"failed_check,omitempty"`
	FinalAction      Action        `json:"final_action"`
	FinalChannel     Channel       `json:"final_channel,omitempty"`
	AuthorizedByRule string        `json:"authorized_by_rule,omitempty"`
	Blocked          bool          `json:"blocked"`
	BlockReason      string        `json:"block_reason,omitempty"`
	Reasoning        string        `json:"reasoning,omitempty"`
	AttemptNumber    int           `json:"attempt_number"`
	CooldownUntil    *time.Time    `json:"cooldown_until,omitempty"`
}

// CandidateFromRiskCategory maps a classification to a recommended intervention.
// This is the "diagnosis -> recommendation" logic, kept as an explicit, inspectable
// map (NOT inside the LLM, which already did its classification job in Phase 2).
func CandidateFromRiskCategory(category string) Action {
	switch category {
	case RiskCategoryInsufficientFunds, RiskCategoryBankTimeout:
		return ActionRetryPayment
	case RiskCategoryExpiredCard:
		return ActionSendPaymentLink // card is dead — a blind retry is pointless
	case RiskCategoryOtpFailure:
		return ActionSendReminder // user must re-initiate with a fresh OTP
	case RiskCategoryRiskBlock:
		return ActionSendPaymentLink
	case RiskCategoryMandateRevoked:
		return ActionStopSequence
	case RiskCategoryCheckoutAbandoned:
		return ActionSendPaymentLink
	case RiskCategoryInvoiceOverdue:
		return ActionSendReminder
	default: // unknown — can't confidently act automatically
		return ActionStopSequence
	}
}

package statemachine

import (
	"errors"
	"time"

	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/policy"
)

// PromiseState is one node in the promise-to-pay lifecycle.
type PromiseState string

const (
	StateNotified         PromiseState = "notified"          // invoice overdue, first contact made
	StateAwaitingResponse PromiseState = "awaiting_response" // contact sent, waiting on the debtor
	StatePromised         PromiseState = "promised"          // debtor committed to a date
	StateDue              PromiseState = "due"               // promised_date arrived, not yet paid
	StateKept             PromiseState = "kept"              // paid (on or before due)
	StateBroken           PromiseState = "broken"            // not paid by the promised date
	StateReEscalated      PromiseState = "re_escalated"      // broken + re-escalated (loop back to awaiting)
	StateWrittenOff       PromiseState = "written_off"       // escalation ceiling reached -> STOP
)

// Trigger is the external event that drives a transition.
type Trigger string

const (
	TriggerRequestResponse Trigger = "request_response" // a reminder/chaser was sent
	TriggerDebtorResponds  Trigger = "debtor_responds"  // debtor commits to a promised_date (simulated)
	TriggerDateArrives     Trigger = "date_arrives"     // the promised date has passed
	TriggerPaid            Trigger = "paid"             // the invoice was settled
	TriggerNotPaid         Trigger = "not_paid"         // the invoice wasn't settled by the due date
	TriggerTimeout         Trigger = "timeout"          // no response within the response window
)

// Result of a transition: the new state plus the fields the caller must persist.
type Result struct {
	State         PromiseState
	EscalationInc bool       // escalation_count should be incremented (re_escalated)
	RespondedAt   *time.Time // set when a debtor commits to a date
	ResolvedAt    *time.Time // set on kept / written_off (terminal states)
	PromisedDate  *time.Time // set when a debtor responds
}

var ErrInvalidTransition = errors.New("invalid promise state transition")

// allowed is the transition table: current state -> trigger -> resulting state.
// Pure, inspectable, no DB — the same discipline as the Phase 3 policy functions.
var allowed = map[PromiseState]map[Trigger]PromiseState{
	StateNotified: {
		TriggerRequestResponse: StateAwaitingResponse,
		TriggerDebtorResponds:  StatePromised,
	},
	StateAwaitingResponse: {
		TriggerDebtorResponds: StatePromised,
		TriggerTimeout:        StateReEscalated,
	},
	StateReEscalated: {
		TriggerRequestResponse: StateAwaitingResponse,
		TriggerDebtorResponds:  StatePromised,
	},
	StatePromised: {
		TriggerDateArrives: StateDue,
	},
	StateDue: {
		TriggerPaid:    StateKept,
		TriggerNotPaid: StateBroken,
	},
	StateBroken: {
		TriggerPaid: StateKept, // paid late after all — still kept
		// not_paid on a broken promise is resolved by the escalation decision in
		// Transition (re_escalated if under the ceiling, written_off otherwise).
		TriggerNotPaid: StateReEscalated, // default; ceiling check may override -> written_off
	},
}

// Transition resolves (state, trigger) to a new state. For the broken -> (re_escalated |
// written_off) fork it consults the same escalation ceiling the Phase 3 policy layer
// uses — the receivables-chasing sequence is stopped by exactly the same guardrail
// that stops payment retries. Returns ErrInvalidTransition when the pair is not in
// the table.
func Transition(state PromiseState, trigger Trigger, escalationCount, ceiling int, now time.Time) (Result, error) {
	targets, ok := allowed[state]
	if !ok {
		return Result{}, ErrInvalidTransition
	}
	to, ok := targets[trigger]
	if !ok {
		return Result{}, ErrInvalidTransition
	}

	res := Result{State: to}
	switch to {
	case StatePromised:
		res.PromisedDate = &now
		res.RespondedAt = &now
	case StateKept, StateWrittenOff:
		res.ResolvedAt = &now
	}

	if state == StateBroken && trigger == TriggerNotPaid {
		// The escalation-ceiling fork. Same function as Phase 3's decide.go.
		if passed, _ := policy.HasExceededEscalationCeiling(escalationCount, ceiling); !passed {
			res.State = StateWrittenOff
			res.ResolvedAt = &now
			return res, nil
		}
		res.State = StateReEscalated
		res.EscalationInc = true
		return res, nil
	}

	return res, nil
}

// initial returns the state a freshly created promise starts in (we have notified
// the debtor and are waiting).
func initial() PromiseState { return StateNotified }

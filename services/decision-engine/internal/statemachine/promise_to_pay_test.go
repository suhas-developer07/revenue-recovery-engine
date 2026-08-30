package statemachine

import (
	"testing"
	"time"

	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/policy"
)

func fixedNow() time.Time { return time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC) }

func step(t *testing.T, from PromiseState, tr Trigger, esc, ceiling int, now time.Time) PromiseState {
	t.Helper()
	res, err := Transition(from, tr, esc, ceiling, now)
	if err != nil {
		t.Fatalf("transition %s->%s failed: %v", from, tr, err)
	}
	return res.State
}

func TestHappyPathKept(t *testing.T) {
	now := fixedNow()
	ceiling := policy.DefaultEscalationCeiling
	state := step(t, StateNotified, TriggerRequestResponse, 0, ceiling, now)
	if state != StateAwaitingResponse {
		t.Fatalf("notified->awaiting_response: got %s", state)
	}
	state = step(t, StateAwaitingResponse, TriggerDebtorResponds, 0, ceiling, now)
	if state != StatePromised {
		t.Fatalf("awaiting_response->promised: got %s", state)
	}
	state = step(t, StatePromised, TriggerDateArrives, 0, ceiling, now)
	if state != StateDue {
		t.Fatalf("promised->due: got %s", state)
	}
	res, err := Transition(state, TriggerPaid, 0, ceiling, now)
	if err != nil || res.State != StateKept {
		t.Fatalf("due->kept: got %s err %v", res.State, err)
	}
}

func TestReEscalationUntilKeep(t *testing.T) {
	now := fixedNow()
	ceiling := policy.DefaultEscalationCeiling

	state := StatePromised
	state = step(t, state, TriggerDateArrives, 0, ceiling, now) // due
	res, _ := Transition(state, TriggerNotPaid, 0, ceiling, now)
	if res.State != StateBroken {
		t.Fatalf("due->broken expected broken, got %s", res.State)
	}
	// broken + not_paid: under ceiling -> re_escalated with increment
	res, _ = Transition(res.State, TriggerNotPaid, 0, ceiling, now)
	if res.State != StateReEscalated || !res.EscalationInc {
		t.Fatalf("expected re_escalated with increment, got %s inc=%v", res.State, res.EscalationInc)
	}

	state = step(t, res.State, TriggerRequestResponse, 1, ceiling, now) // awaiting_response
	state = step(t, state, TriggerDebtorResponds, 1, ceiling, now)      // promised
	state = step(t, state, TriggerDateArrives, 1, ceiling, now)         // due

	// this time the debtor pays -> kept (even though it was broken once)
	res, _ = Transition(state, TriggerPaid, 1, ceiling, now)
	if res.State != StateKept || res.ResolvedAt == nil {
		t.Fatalf("expected kept with resolved_at, got %s", res.State)
	}
}

// TestEscalationCeilingStopsSequence is the DoD scenario: enough broken promises to
// exhaust the ceiling lands on written_off — a terminal STOP, never an infinite loop.
func TestEscalationCeilingStopsSequence(t *testing.T) {
	now := fixedNow()
	ceiling := policy.DefaultEscalationCeiling // 5

	state := StateNotified
	state = step(t, state, TriggerRequestResponse, 0, ceiling, now)
	state = step(t, state, TriggerDebtorResponds, 0, ceiling, now)

	escalations := 0
	steps := 0
	for state != StateWrittenOff && state != StateKept && steps < 50 {
		// a full broken-promise cycle: promised date arrives unpaid (due -> broken),
		// then the debt is confirmed unpaid (broken -> re_escalated or written_off).
		state = step(t, state, TriggerDateArrives, escalations, ceiling, now) // due
		res, _ := Transition(state, TriggerNotPaid, escalations, ceiling, now) // broken
		state = res.State
		res, _ = Transition(state, TriggerNotPaid, escalations, ceiling, now) // ceiling fork
		state = res.State
		if res.EscalationInc {
			escalations++
		}
		if state == StateReEscalated {
			state = step(t, state, TriggerRequestResponse, escalations, ceiling, now)
			state = step(t, state, TriggerDebtorResponds, escalations, ceiling, now)
		}
		steps++
	}

	if state != StateWrittenOff {
		t.Fatalf("expected to terminate at written_off, got %s after %d steps", state, steps)
	}
	if steps >= 50 {
		t.Fatalf("sequence did not terminate — possible infinite loop")
	}
}

func TestInvalidTransitionRejected(t *testing.T) {
	now := fixedNow()
	// Cannot be 'paid' before ever being promised/due.
	if _, err := Transition(StateNotified, TriggerPaid, 0, policy.DefaultEscalationCeiling, now); err == nil {
		t.Fatalf("expected error for notified->paid")
	}
}

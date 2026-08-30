package promises

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/db"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/policy"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/statemachine"
)

// Service drives the promise-to-pay state machine on top of the promises table.
// Transition rules live in the pure statemachine package (see promise_to_pay.go);
// this layer persists them and re-runs the Phase 3 policy gate for each escalation.
type Service struct {
	Pool *pgxpool.Pool
}

var ErrNotFound = errors.New("promise not found")

// Create opens a promise in the initial (notified) state for an overdue invoice.
func (s *Service) Create(ctx context.Context, eventID string) (string, error) {
	ev, err := db.GetEvent(ctx, s.Pool, eventID)
	if err != nil {
		return "", err
	}
	return db.CreatePromise(ctx, s.Pool, ev.ID, ev.OrderID, ev.AmountPaise)
}

// Transition applies a machine trigger to a promise, persists the result, and —
// when the machine lands on an escalation or write-off fork — routes the flow
// through the same Phase 3 policy gate before dispatching to Execution.
func (s *Service) Transition(ctx context.Context, id string, trigger statemachine.Trigger) (statemachine.PromiseState, error) {
	p, err := db.GetPromise(ctx, s.Pool, id)
	if err != nil {
		return "", ErrNotFound
	}

	now := time.Now()
	res, err := statemachine.Transition(p.State, trigger, p.EscalationCount, policy.DefaultEscalationCeiling, now)
	if err != nil {
		return "", err
	}
	if err := db.ApplyTransition(ctx, s.Pool, id, res); err != nil {
		return "", err
	}

	// An escalation (broken -> re_escalated) or write-off (broken -> written_off)
	// carries a recovery action. Reuse Phase 3's decide flow for the authorization
	// (the escalation ceiling is what flips it from re_escalated to written_off).
	if res.State == statemachine.StateReEscalated || res.State == statemachine.StateWrittenOff {
		s.escalate(ctx, p.EventID, p.EscalationCount, res.State == statemachine.StateReEscalated)
	}

	return res.State, nil
}

// escalate re-runs the Phase 3 policy gate for a broken promise and logs the
// authorized action: a firming SEND_REMINDER while re-escalating, or a STOP_SEQUENCE
// once the escalation ceiling (policy.DefaultEscalationCeiling) is exhausted — the
// same guardrail that halts payment-retry sequences. The promise's own row (state,
// escalation_count, resolved_at) is the audit trail here: escalation decisions are
// scoped to the promise, not to the event's single actions/decisions row (which are
// 1-per-event by design), so we re-authorize through policy.Decide and log rather
// than fabricate a second decision row for the same event.
func (s *Service) escalate(ctx context.Context, eventID string, escalationCount int, reEscalating bool) {
	ev, err := db.GetEvent(ctx, s.Pool, eventID)
	if err != nil {
		slog.Warn("promise escalation: event lookup failed", "error", err, "event_id", eventID)
		return
	}

	dc := policy.DecisionContext{
		EventID:         ev.ID,
		OrderID:         ev.OrderID,
		CustomerID:      ev.CustomerID,
		AmountPaise:     ev.AmountPaise,
		RiskCategory:    policy.RiskCategoryInvoiceOverdue,
		MandateStatus:   "active",
		EscalationCount: escalationCount,
		Now:             time.Now(),
	}
	trace := policy.Decide(dc)

	slog.Info("promise escalation decided",
		"event_id", ev.ID,
		"escalation_count", escalationCount,
		"action", trace.FinalAction,
		"channel", trace.FinalChannel,
		"blocked", trace.Blocked,
		"authorized_by_rule", trace.AuthorizedByRule)
}
func (s *Service) List(ctx context.Context) ([]db.Promise, error) {
	return db.ListPromises(ctx, s.Pool)
}

package decider

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/db"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/policy"
)

// serializeTrace encodes a decision trace as JSON so it can be stored verbatim in
// the decisions.reasoning column — the accumulated (not reconstructed) evidence
// that --explain and the explain endpoint read back.
func serializeTrace(t policy.DecisionTrace) (string, error) {
	b, err := json.Marshal(t)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// DeserializeTrace decodes a trace previously persisted by serializeTrace.
func DeserializeTrace(raw string) (policy.DecisionTrace, error) {
	var t policy.DecisionTrace
	err := json.Unmarshal([]byte(raw), &t)
	return t, err
}

// Service mediates between the DB and the pure policy layer: it fetches the
// customer/mandate context and attempt history ONCE, builds a DecisionContext,
// runs policy.Decide, computes the next retry cooldown, and persists the decision.
type Service struct {
	Pool *pgxpool.Pool
}

// DecideAndPersist runs the policy layer for one classification and writes exactly
// one decisions row (authorized or blocked). It is idempotent per classification:
// an at-least-once redelivery of the same classification_id returns the existing
// decision instead of re-running the policy (which would re-count attempts and
// could flip an already-authorized retry into an escalation). Returns the decision
// ID and trace.
func (s *Service) DecideAndPersist(ctx context.Context, classificationID string) (string, policy.DecisionTrace, error) {
	// Idempotency: if this classification was already decided, replay that decision
	// rather than decide it a second time under at-least-once delivery.
	if existing, err := db.GetDecisionTraceByClassification(ctx, s.Pool, classificationID); err != nil {
		return "", policy.DecisionTrace{}, err
	} else if existing != "" {
		trace, derr := DeserializeTrace(existing)
		if derr == nil {
			slog.Debug("classification already decided, replaying existing decision",
				"classification_id", classificationID)
			return "", trace, nil
		}
	}

	classRow, err := db.GetClassification(ctx, s.Pool, classificationID)
	if err != nil {
		return "", policy.DecisionTrace{}, err
	}

	ev, err := db.GetEvent(ctx, s.Pool, classRow.EventID)
	if err != nil {
		return "", policy.DecisionTrace{}, err
	}

	prefs, err := db.GetCustomerPreferences(ctx, s.Pool, ev.CustomerID)
	if err != nil {
		return "", policy.DecisionTrace{}, err
	}

	state, err := db.GetAttemptState(ctx, s.Pool, classRow.EventID, ev.OrderID)
	if err != nil {
		return "", policy.DecisionTrace{}, err
	}

	dc := policy.DecisionContext{
		EventID:          ev.ID,
		OrderID:          ev.OrderID,
		CustomerID:       ev.CustomerID,
		RiskCategory:     classRow.RiskCategory,
		AmountPaise:      ev.AmountPaise,
		AttemptNumber:    state.Count + 1,
		EscalationCount:  state.EscalationCount,
		CooldownUntil:    state.LastCooldown,
		PreDebitNoticeAt: state.LastNotifiedAt,
		Recurring:        prefs.MandateStatus == "active",
		MandateStatus:    prefs.MandateStatus,
		OptedOutChannels: toChannels(prefs.OptedOutChannels),
		Timezone:         prefs.Timezone,
		Now:              time.Now(),
	}

	trace := policy.Decide(dc)

	traceJSON, err := serializeTrace(trace)
	if err != nil {
		return "", policy.DecisionTrace{}, err
	}

	decision := db.Decision{
		EventID:          ev.ID,
		ClassificationID: classificationID,
		Action:           string(trace.FinalAction),
		Channel:          string(trace.FinalChannel),
		AuthorizedByRule: trace.AuthorizedByRule,
		Blocked:          trace.Blocked,
		BlockReason:      trace.BlockReason,
		AttemptNumber:    dc.AttemptNumber,
		CooldownUntil:    trace.CooldownUntil,
		Reasoning:        traceJSON,
	}

	decisionID, err := db.InsertDecision(ctx, s.Pool, decision)
	if err == db.ErrAlreadyDecided {
		// A concurrent consumer won the race and already decided this
		// classification — replay its verdict rather than double-counting.
		if existing, derr := db.GetDecisionTraceByClassification(ctx, s.Pool, classificationID); derr == nil && existing != "" {
			trace, _ = DeserializeTrace(existing)
		}
		slog.Debug("classification decided concurrently, replaying existing decision",
			"classification_id", classificationID)
		return "", trace, nil
	}
	if err != nil {
		return "", policy.DecisionTrace{}, err
	}

	slog.Info("decision recorded",
		"decision_id", decisionID,
		"event_id", ev.ID,
		"action", trace.FinalAction,
		"blocked", trace.Blocked,
		"authorized_by_rule", trace.AuthorizedByRule,
		"block_reason", trace.BlockReason,
	)
	return decisionID, trace, nil
}

// ExplainEvent fetches the stored decision trace for an event. It returns
// (trace, found=false) when no decision exists yet. The trace was persisted
// verbatim at decision time — it is NOT reconstructed here.
func (s *Service) ExplainEvent(ctx context.Context, eventID string) (policy.DecisionTrace, bool, error) {
	raw, err := db.GetLatestDecisionTrace(ctx, s.Pool, eventID)
	if err != nil {
		return policy.DecisionTrace{}, false, err
	}
	if raw == "" {
		return policy.DecisionTrace{}, false, nil
	}
	trace, err := DeserializeTrace(raw)
	if err != nil {
		return policy.DecisionTrace{}, false, err
	}
	return trace, true, nil
}

// toChannels converts raw preference strings into policy channels.
func toChannels(chs []string) []policy.Channel {
	out := make([]policy.Channel, 0, len(chs))
	for _, c := range chs {
		out = append(out, policy.Channel(c))
	}
	return out
}

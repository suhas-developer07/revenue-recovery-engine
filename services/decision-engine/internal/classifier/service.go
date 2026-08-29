package classifier

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/db"
)

// Service orchestrates classification for a single event: it fetches the event,
// runs the rules engine (LLM fallback for ambiguous cases), persists the
// classification row, and returns its UUID.
type Service struct {
	Pool *pgxpool.Pool
	LLM  LLMClassifier
}

// ClassifyEventByID classifies the event identified by eventID and persists the
// result. It is safe to call more than once for the same event — classification
// inserts are idempotent (a duplicate simply does nothing and returns the existing id).
func (s *Service) ClassifyEventByID(ctx context.Context, eventID string) (string, error) {
	ev, err := db.GetEvent(ctx, s.Pool, eventID)
	if err != nil {
		return "", err
	}

	result, err := ClassifyEvent(ctx, s.LLM, ev.EventType, ev.AmountPaise, ev.RawPayload)
	if err != nil {
		return "", err
	}

	classID, err := db.InsertClassificationIfAbsent(ctx, s.Pool, db.Classification{
		EventID:            ev.ID,
		RiskCategory:       result.Category,
		RootCauseNarrative: result.RootCauseNarrative,
		ClassifiedBy:       result.ClassifiedBy,
		PriorityScore:      result.PriorityScore,
	})
	if err != nil {
		return "", err
	}

	slog.Info("event classified",
		"event_id", eventID,
		"classification_id", classID,
		"category", result.Category,
		"classified_by", result.ClassifiedBy,
		"priority_score", result.PriorityScore,
	)
	return classID, nil
}

// Backfill classifies any events that do not yet have a classification row. This
// guarantees "every event => exactly one classification" even if the Redis stream
// was flushed or the service restarted between publish and consume.
func (s *Service) Backfill(ctx context.Context, limit int) error {
	events, err := db.GetUnclassifiedEvents(ctx, s.Pool, limit)
	if err != nil {
		return err
	}
	for _, e := range events {
		if _, err := s.ClassifyEventByID(ctx, e.ID); err != nil {
			slog.Error("backfill classify failed", "error", err, "event_id", e.ID)
			continue
		}
	}
	return nil
}

// SweepCheckoutAbandoned detects orders that were created but never paid and are
// past the abandonment window, then classifies them as checkout_abandoned. It has
// no webhook — it is an absence-based, time-windowed polling sweep.
func (s *Service) SweepCheckoutAbandoned(ctx context.Context, abandonedAfter time.Duration) error {
	orders, err := db.OrdersAbandonedAfter(ctx, s.Pool, abandonedAfter)
	if err != nil {
		return err
	}
	for _, o := range orders {
		classID, err := s.classifyAbandonedOrder(ctx, o)
		if err != nil {
			slog.Error("checkout sweep failed", "error", err, "order_id", o.OrderID)
			continue
		}
		slog.Info("checkout abandonment classified",
			"order_id", o.OrderID, "classification_id", classID)
	}
	return nil
}

// classifyAbandonedOrder attaches a checkout_abandoned classification to the
// order's first event, marked as classified_by 'sweep'.
func (s *Service) classifyAbandonedOrder(ctx context.Context, o db.AbandonedOrder) (string, error) {
	eventID, err := db.RepresentativeEventForOrder(ctx, s.Pool, o.OrderID)
	if err != nil {
		return "", err
	}

	return db.InsertClassificationIfAbsent(ctx, s.Pool, db.Classification{
		EventID:            eventID,
		RiskCategory:       CategoryCheckoutAbandoned,
		RootCauseNarrative: "order created but never reached paid state within the abandonment window",
		ClassifiedBy:       "sweep",
		PriorityScore:      PriorityScore(o.AmountPaise, CategoryCheckoutAbandoned),
	})
}

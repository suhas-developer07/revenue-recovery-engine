package db

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Classification is the DB-facing representation of a classifications row.
type Classification struct {
	EventID            string
	RiskCategory       string
	RootCauseNarrative string
	ClassifiedBy       string // 'rules_engine' | 'llm'
	PriorityScore      float64
}

// InsertClassification writes a classification row associated with an event.
func InsertClassification(ctx context.Context, pool *pgxpool.Pool, c Classification) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO classifications (event_id, risk_category, root_cause_narrative, classified_by, priority_score)
		 VALUES ($1, $2, $3, $4, $5)`,
		c.EventID, c.RiskCategory, c.RootCauseNarrative, c.ClassifiedBy, c.PriorityScore,
	)
	return err
}

// InsertClassificationIfAbsent inserts a classification only if no row already
// exists for the event, returning the classification's UUID either way. This makes
// classification idempotent under at-least-once delivery and backfill retries.
func InsertClassificationIfAbsent(ctx context.Context, pool *pgxpool.Pool, c Classification) (string, error) {
	var id string
	err := pool.QueryRow(ctx,
		`INSERT INTO classifications (event_id, risk_category, root_cause_narrative, classified_by, priority_score)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
		 RETURNING id`,
		c.EventID, c.RiskCategory, c.RootCauseNarrative, c.ClassifiedBy, c.PriorityScore,
	).Scan(&id)
	return id, err
}

// CountUnclassified returns the number of events without a classification row.
func CountUnclassified(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	var n int
	err := pool.QueryRow(ctx,
		`SELECT count(*) FROM events e LEFT JOIN classifications c ON c.event_id = e.id WHERE c.id IS NULL`,
	).Scan(&n)
	return n, err
}

// CountUnresolvedCheckoutOrders returns distinct orders that have at least one event
// but never an order.paid/payment.captured event. Typically the ones the sweep should classify.
func CountUnresolvedCheckoutOrders(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	var n int
	err := pool.QueryRow(ctx,
		`SELECT count(DISTINCT order_id) FROM events
		 WHERE order_id IS NOT NULL AND order_id <> ''
		   AND NOT EXISTS (
		     SELECT 1 FROM events e2
		     WHERE e2.order_id = events.order_id
		       AND e2.event_type IN ('order.paid', 'payment.captured', 'payment.authorized')
		   )`,
	).Scan(&n)
	return n, err
}

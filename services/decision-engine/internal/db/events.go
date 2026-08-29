package db

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Event mirrors a row from the events table, with the raw payload materialized
// so the classifier can inspect error codes/reasons that live deep in it.
type Event struct {
	ID          string
	Source      string
	EventType   string
	OrderID     string
	CustomerID  string
	AmountPaise int64
	RawPayload  json.RawMessage
}

// GetEvent fetches a single event by its UUID.
func GetEvent(ctx context.Context, pool *pgxpool.Pool, id string) (Event, error) {
	var e Event
	err := pool.QueryRow(ctx,
		`SELECT id, source, event_type, order_id, customer_id, amount_paise, raw_payload
		 FROM events WHERE id = $1`,
		id,
	).Scan(&e.ID, &e.Source, &e.EventType, &e.OrderID, &e.CustomerID, &e.AmountPaise, &e.RawPayload)
	return e, err
}

// GetUnclassifiedEvents returns all events (within a limit, oldest first) that do
// not yet have a classification row. Used to backfill after a restart or stream flush.
func GetUnclassifiedEvents(ctx context.Context, pool *pgxpool.Pool, limit int) ([]Event, error) {
	rows, err := pool.Query(ctx,
		`SELECT e.id, e.source, e.event_type, e.order_id, e.customer_id, e.amount_paise, e.raw_payload
		 FROM events e
		 LEFT JOIN classifications c ON c.event_id = e.id
		 WHERE c.id IS NULL
		 ORDER BY e.received_at ASC
		 LIMIT $1`,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.Source, &e.EventType, &e.OrderID, &e.CustomerID, &e.AmountPaise, &e.RawPayload); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// RepresentativeEventForOrder returns the UUID of the oldest event for an order —
// the "creation-time" event the checkout_abandoned classification is attached to.
func RepresentativeEventForOrder(ctx context.Context, pool *pgxpool.Pool, orderID string) (string, error) {
	var id string
	err := pool.QueryRow(ctx,
		`SELECT id FROM events WHERE order_id = $1 ORDER BY received_at ASC LIMIT 1`,
		orderID,
	).Scan(&id)
	return id, err
}

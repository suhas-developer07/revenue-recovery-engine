package db

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Event struct {
	Source      string
	EventType   string
	OrderID     string
	CustomerID  string
	AmountPaise int64
	RawPayload  json.RawMessage
}

func AlreadyProcessed(ctx context.Context, pool *pgxpool.Pool, razorpayEventID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM processed_webhook_ids WHERE razorpay_event_id = $1)`,
		razorpayEventID,
	).Scan(&exists)
	return exists, err
}

func MarkProcessed(ctx context.Context, pool *pgxpool.Pool, razorpayEventID string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO processed_webhook_ids (razorpay_event_id) VALUES ($1)
		 ON CONFLICT (razorpay_event_id) DO NOTHING`,
		razorpayEventID,
	)
	return err
}

func InsertEvent(ctx context.Context, pool *pgxpool.Pool, e Event) (string, error) {
	var id string
	err := pool.QueryRow(ctx,
		`INSERT INTO events (source, event_type, order_id, customer_id, amount_paise, raw_payload)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id`,
		e.Source, e.EventType, e.OrderID, e.CustomerID, e.AmountPaise, e.RawPayload,
	).Scan(&id)
	return id, err
}

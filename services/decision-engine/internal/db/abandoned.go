package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// AbandonedOrder represents an order that was created but never reached a paid
// state within the abandonment window.
type AbandonedOrder struct {
	OrderID     string
	CustomerID  string
	AmountPaise int64
}

// OrdersAbandonedAfter returns distinct orders that have at least one event, never
// reached a paid/captured state, and whose first event is older than abandonedAfter.
// This is the data source for the checkout_abandoned sweep — an absence-based check,
// not a webhook.
func OrdersAbandonedAfter(ctx context.Context, pool *pgxpool.Pool, abandonedAfter time.Duration) ([]AbandonedOrder, error) {
	cutoff := time.Now().Add(-abandonedAfter)

	rows, err := pool.Query(ctx,
		`SELECT e.order_id,
		        COALESCE(MAX(e.customer_id), ''),
		        COALESCE(MAX(e.amount_paise), 0)
		 FROM events e
		 WHERE e.order_id IS NOT NULL AND e.order_id <> ''
		   AND e.received_at <= $1
		   AND NOT EXISTS (
		     SELECT 1 FROM events e2
		     WHERE e2.order_id = e.order_id
		       AND e2.event_type IN ('order.paid', 'payment.captured', 'payment.authorized')
		   )
		   AND NOT EXISTS (
		     SELECT 1 FROM classifications c
		     JOIN events ce ON ce.id = c.event_id
		     WHERE ce.order_id = e.order_id
		       AND c.risk_category = 'checkout_abandoned'
		       AND c.classified_by = 'sweep'
		   )
		 GROUP BY e.order_id`,
		cutoff,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	orders := []AbandonedOrder{}
	for rows.Next() {
		var o AbandonedOrder
		if err := rows.Scan(&o.OrderID, &o.CustomerID, &o.AmountPaise); err != nil {
			return nil, err
		}
		orders = append(orders, o)
	}
	return orders, rows.Err()
}

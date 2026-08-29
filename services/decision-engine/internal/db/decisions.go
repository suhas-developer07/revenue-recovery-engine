package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ClassificationRow is the identity + category of a classifications row.
type ClassificationRow struct {
	ID           string
	EventID      string
	RiskCategory string
}

// CustomerPrefs mirrors a row (or defaults for a missing row) from customer_preferences.
type CustomerPrefs struct {
	MandateStatus    string
	OptedOutChannels []string
	Timezone         string
}

// AttemptState summarizes prior decisions for an event, used to build the next
// DecisionContext (attempt number, cooldown, pre-debit notice, escalation count).
type AttemptState struct {
	Count           int
	LastCooldown    *time.Time
	LastNotifiedAt  *time.Time
	EscalationCount int
}

// GetClassification returns the risk category for a classification by its UUID.
func GetClassification(ctx context.Context, pool *pgxpool.Pool, id string) (ClassificationRow, error) {
	var c ClassificationRow
	err := pool.QueryRow(ctx,
		`SELECT id, event_id, risk_category FROM classifications WHERE id = $1`, id,
	).Scan(&c.ID, &c.EventID, &c.RiskCategory)
	return c, err
}

// GetCustomerPreferences returns the customer's preference row, or sane defaults
// if none has been recorded yet.
func GetCustomerPreferences(ctx context.Context, pool *pgxpool.Pool, customerID string) (CustomerPrefs, error) {
	defaults := CustomerPrefs{MandateStatus: "active", OptedOutChannels: []string{}, Timezone: "Asia/Kolkata"}
	if customerID == "" {
		return defaults, nil
	}

	var ms, tz string
	var opts []string
	err := pool.QueryRow(ctx,
		`SELECT COALESCE(mandate_status, 'active'),
		        COALESCE(timezone, 'Asia/Kolkata'),
		        COALESCE(opted_out_channels, '{}')
		 FROM customer_preferences WHERE customer_id = $1`, customerID,
	).Scan(&ms, &tz, &opts)
	if err == pgx.ErrNoRows {
		return defaults, nil
	}
	if err != nil {
		return CustomerPrefs{}, err
	}
	return CustomerPrefs{MandateStatus: ms, OptedOutChannels: opts, Timezone: tz}, nil
}

// GetAttemptState summarizes prior decisions for an event to inform the next
// decision: retry count, last cooldown, last notification time, and how many
// escalation actions have already been taken for this order.
func GetAttemptState(ctx context.Context, pool *pgxpool.Pool, eventID, orderID string) (AttemptState, error) {
	var s AttemptState

	if orderID != "" {
		// Escalation count is tracked across the whole order, not a single event.
		err := pool.QueryRow(ctx,
			`SELECT count(*) FROM decisions d
			 JOIN events e ON e.id = d.event_id
			 WHERE e.order_id = $1 AND d.action = 'ESCALATE_TO_HUMAN'`, orderID,
		).Scan(&s.EscalationCount)
		if err != nil {
			return s, err
		}
	}

	err := pool.QueryRow(ctx,
		`SELECT count(*),
		        max(cooldown_until),
		        max(CASE WHEN action IN ('SEND_REMINDER','SEND_PAYMENT_LINK') THEN d.created_at END)
		 FROM decisions d WHERE d.event_id = $1`, eventID,
	).Scan(&s.Count, &s.LastCooldown, &s.LastNotifiedAt)
	return s, err
}

// InsertDecision persists a decisions row and returns its UUID.
func InsertDecision(ctx context.Context, pool *pgxpool.Pool, d Decision) (string, error) {
	var id string
	err := pool.QueryRow(ctx,
		`INSERT INTO decisions (event_id, action, channel, authorized_by_rule, blocked, block_reason, attempt_number, cooldown_until, reasoning)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id`,
		d.EventID, d.Action, d.Channel, d.AuthorizedByRule, d.Blocked, d.BlockReason,
		d.AttemptNumber, d.CooldownUntil, d.Reasoning,
	).Scan(&id)
	return id, err
}

// GetLatestDecisionTrace returns the stored JSON trace of the most recent decision
// for an event. The trace was serialized to the reasoning column at insert time
// (index 0 holds the JSON). Returns "", nil if no decision exists yet.
func GetLatestDecisionTrace(ctx context.Context, pool *pgxpool.Pool, eventID string) (string, error) {
	var raw string
	err := pool.QueryRow(ctx,
		`SELECT COALESCE(reasoning, '') FROM decisions WHERE event_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`, eventID,
	).Scan(&raw)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return raw, nil
}

// GetDecisionCount returns how many decisions have been recorded for an event.
func GetDecisionCount(ctx context.Context, pool *pgxpool.Pool, eventID string) (int, error) {
	var n int
	err := pool.QueryRow(ctx,
		`SELECT count(*) FROM decisions WHERE event_id = $1`, eventID).Scan(&n)
	return n, err
}

// Decision is the DB-facing row for a single policy decision.
type Decision struct {
	EventID          string
	Action           string
	Channel          string
	AuthorizedByRule string
	Blocked          bool
	BlockReason      string
	AttemptNumber    int
	CooldownUntil    *time.Time
	Reasoning        string
}

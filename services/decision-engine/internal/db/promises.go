package db

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/statemachine"
)

// ErrPromiseNotFound is returned when no promise row exists for an event.
var ErrPromiseNotFound = errors.New("no promise found for event")

// Promise mirrors a row from the promises table. State is the single source of
// truth for the machine; the other timestamps feed the Phase 6 metrics.
type Promise struct {
	ID                string
	EventID           string
	PromisedDate      *time.Time
	State             statemachine.PromiseState
	EscalationCount   int
	EscalationHistory []EscalationEntry
	RespondedAt       *time.Time
	ResolvedAt        *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// CreatePromise inserts a row in the initial (notified) state for an overdue
// invoice event. Returns the new UUID.
func CreatePromise(ctx context.Context, pool *pgxpool.Pool, eventID, orderID string, amountPaise int64) (string, error) {
	var id string
	err := pool.QueryRow(ctx,
		`INSERT INTO promises (event_id, state)
		 VALUES ($1, $2)
		 RETURNING id`,
		eventID, statemachine.StateNotified,
	).Scan(&id)
	return id, err
}

// GetPromise fetches a single promise by UUID.
func GetPromise(ctx context.Context, pool *pgxpool.Pool, id string) (Promise, error) {
	var p Promise
	var hist []byte
	err := pool.QueryRow(ctx,
		`SELECT id, event_id, promised_date, state, escalation_count, escalation_history, responded_at, resolved_at, created_at, updated_at
		 FROM promises WHERE id = $1`,
		id,
	).Scan(&p.ID, &p.EventID, &p.PromisedDate, &p.State, &p.EscalationCount, &hist, &p.RespondedAt, &p.ResolvedAt, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return p, err
	}
	if len(hist) > 0 {
		_ = json.Unmarshal(hist, &p.EscalationHistory)
	}
	return p, err
}

// Metrics are the aggregate numbers the Phase 6 batch report renders. They are
// cheap now because the state machine logs each transition as a timestamped update.
type Metrics struct {
	Total               int     `json:"total"`
	Kept                int     `json:"kept"`
	Broken              int     `json:"broken"`
	WrittenOff          int     `json:"written_off"`
	Active              int     `json:"active"` // any non-terminal state
	PromiseKeepingRate  float64 `json:"promise_keeping_rate"`
	WriteOffRate        float64 `json:"write_off_rate"`
	AvgTimeToPromiseSec float64 `json:"avg_time_to_promise_sec"` // notified -> responded
	EscalationDepth     []int   `json:"escalation_depth"`        // index = depth, value = count
}

// PromiseMetrics computes Section 6 aggregates against the promises table.
func PromiseMetrics(ctx context.Context, pool *pgxpool.Pool) (Metrics, error) {
	var m Metrics

	if err := pool.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE state='kept'),
		        count(*) FILTER (WHERE state='broken'),
		        count(*) FILTER (WHERE state='written_off'),
		        count(*) FILTER (WHERE state NOT IN ('kept','broken','written_off')),
		        count(*)
		 FROM promises`).Scan(&m.Kept, &m.Broken, &m.WrittenOff, &m.Active, &m.Total); err != nil {
		return m, err
	}

	resolved := m.Kept + m.Broken
	if resolved > 0 {
		m.PromiseKeepingRate = float64(m.Kept) / float64(resolved)
	}
	if m.Total > 0 {
		m.WriteOffRate = float64(m.WrittenOff) / float64(m.Total)
	}

	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(avg(EXTRACT(EPOCH FROM (responded_at - created_at))), 0)
		 FROM promises WHERE responded_at IS NOT NULL`).Scan(&m.AvgTimeToPromiseSec); err != nil {
		return m, err
	}

	rows, err := pool.Query(ctx,
		`SELECT escalation_count, count(*)
		 FROM promises GROUP BY escalation_count ORDER BY escalation_count`)
	if err != nil {
		return m, err
	}
	defer rows.Close()
	for rows.Next() {
		var depth, count int
		if err := rows.Scan(&depth, &count); err != nil {
			return m, err
		}
		for len(m.EscalationDepth) <= depth {
			m.EscalationDepth = append(m.EscalationDepth, 0)
		}
		m.EscalationDepth[depth] = count
	}
	return m, rows.Err()
}

// ApplyTransition persists the result of a machine transition onto the row.
// It is a single UPDATE so state (the source of truth) and its derived fields
// can never drift apart.
func ApplyTransition(ctx context.Context, pool *pgxpool.Pool, id string, res statemachine.Result) error {
	_, err := pool.Exec(ctx,
		`UPDATE promises
		 SET state = $2,
		     promised_date = $3,
		     escalation_count = escalation_count + CASE WHEN $4 THEN 1 ELSE 0 END,
		     responded_at = COALESCE($5, responded_at),
		     resolved_at = COALESCE($6, resolved_at),
		     updated_at = now()
		 WHERE id = $1`,
		id, res.State, res.PromisedDate, res.EscalationInc, res.RespondedAt, res.ResolvedAt,
	)
	return err
}

// EscalationEntry is one granular escalation record appended to a promise's
// escalation_history — the same trace-capture discipline as decisions.reasoning.
type EscalationEntry struct {
	EscalationNumber int    `json:"escalation_number"`
	TriggeredAt      string `json:"triggered_at"` // RFC3339
	AuthorizedByRule string `json:"authorized_by_rule"`
	Action           string `json:"action"`
	Channel          string `json:"channel,omitempty"`
	Reasoning        string `json:"reasoning,omitempty"`
}

// AppendEscalation appends one entry to a promise's escalation_history (JSONB).
func AppendEscalation(ctx context.Context, pool *pgxpool.Pool, id string, e EscalationEntry) error {
	_, err := pool.Exec(ctx,
		`UPDATE promises
		 SET escalation_history = escalation_history || $2::jsonb,
		     updated_at = now()
		 WHERE id = $1`,
		id, mustJSON(e))
	return err
}

// mustJSON marshals a value to its JSON string representation. Marshal errors are
// effectively impossible for the plain structs used here, so a panic on failure is
// acceptable (mirrors how the codebase treats serialize errors elsewhere).
func mustJSON(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// SetPromisedDate overwrites the promised date on a promise that has already
// responded. Used by the live "simulate debtor response" path so a demo can type
// a real future date rather than defaulting to the response instant.
func SetPromisedDate(ctx context.Context, pool *pgxpool.Pool, id string, date time.Time) error {
	_, err := pool.Exec(ctx,
		`UPDATE promises SET promised_date = $2, updated_at = now() WHERE id = $1`,
		id, date)
	return err
}

// ListPromises returns all promise rows, newest first.
func ListPromises(ctx context.Context, pool *pgxpool.Pool) ([]Promise, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, event_id, promised_date, state, escalation_count, escalation_history, responded_at, resolved_at, created_at, updated_at
		 FROM promises ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Promise{}
	for rows.Next() {
		var p Promise
		var hist []byte
		if err := rows.Scan(&p.ID, &p.EventID, &p.PromisedDate, &p.State, &p.EscalationCount, &hist, &p.RespondedAt, &p.ResolvedAt, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		if len(hist) > 0 {
			_ = json.Unmarshal(hist, &p.EscalationHistory)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

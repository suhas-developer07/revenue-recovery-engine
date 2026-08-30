-- +goose Up
-- +goose StatementBegin

-- Phase 5 follow-up: give the promise's own row genuinely granular audit detail,
-- not just an aggregate escalation_count. Each escalation appends one entry, the
-- same trace-capture discipline as decisions.reasoning in Phase 3 — but scoped to
-- the promise, so it never touches the 1-per-event decisions/actions tables.
ALTER TABLE promises
  ADD COLUMN escalation_history JSONB NOT NULL DEFAULT '[]';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE promises DROP COLUMN escalation_history;

-- +goose StatementEnd
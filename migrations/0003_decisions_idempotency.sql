-- +goose Up
-- +goose StatementBegin

-- Guarantee "every classification produces exactly one decision". The decider
-- consumes new_classifications via a Redis Streams consumer group (at-least-once
-- delivery). Without this guard, a redelivered classification_id would insert a
-- duplicate decisions row AND re-count attempts (GetAttemptState counts prior
-- decisions), which could flip an already-authorized retry into an escalation or
-- prematurely drain the retry budget. This UNIQUE constraint is the Phase 3
-- equivalent of Phase 1's processed_webhook_ids dedupe table.

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS classification_id UUID REFERENCES classifications(id),
  ADD CONSTRAINT decisions_classification_id_key UNIQUE (classification_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE decisions
  DROP CONSTRAINT IF EXISTS decisions_classification_id_key,
  DROP COLUMN IF EXISTS classification_id;

-- +goose StatementEnd

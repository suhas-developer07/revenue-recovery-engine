-- +goose Up
-- +goose StatementBegin

-- Guarantee "every event has exactly one classification". The classifier's
-- idempotent insert (INSERT ... ON CONFLICT (event_id)) depends on this unique
-- constraint to dedupe under at-least-once delivery and the backfill sweep.
ALTER TABLE classifications
  ADD CONSTRAINT classifications_event_id_key UNIQUE (event_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE classifications
  DROP CONSTRAINT IF EXISTS classifications_event_id_key;

-- +goose StatementEnd

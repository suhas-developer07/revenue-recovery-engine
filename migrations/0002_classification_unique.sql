-- +goose Up
-- +goose StatementBegin

ALTER TABLE classifications
  ADD CONSTRAINT classifications_event_id_key UNIQUE (event_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE classifications
  DROP CONSTRAINT IF EXISTS classifications_event_id_key;

-- +goose StatementEnd

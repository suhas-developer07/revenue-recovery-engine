-- +goose Up
-- +goose StatementBegin


ALTER TABLE promises
  ADD COLUMN escalation_history JSONB NOT NULL DEFAULT '[]';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE promises DROP COLUMN escalation_history;

-- +goose StatementEnd
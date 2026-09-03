-- +goose Up
-- +goose StatementBegin


ALTER TABLE actions
  ADD CONSTRAINT actions_decision_id_key UNIQUE (decision_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE actions
  DROP CONSTRAINT IF EXISTS actions_decision_id_key;

-- +goose StatementEnd
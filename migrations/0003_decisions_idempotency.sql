-- +goose Up
-- +goose StatementBegin


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

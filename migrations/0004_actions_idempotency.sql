-- +goose Up
-- +goose StatementBegin

-- Phase 4 executive idempotency: every decision executes exactly once.
-- The Execution service consumes decisions via an at-least-once mechanism (HTTP
-- retry from the decision-engine / stream redelivery). Without a UNIQUE key on
-- decision_id, a redelivered decision would double-send a payment link or
-- double-attempt a retry. This mirrors the Phase 1 (processed_webhook_ids) and
-- Phase 3 (decisions.classification_id UNIQUE) guards — the same bug class, the
-- same cure.

ALTER TABLE actions
  ADD CONSTRAINT actions_decision_id_key UNIQUE (decision_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE actions
  DROP CONSTRAINT IF EXISTS actions_decision_id_key;

-- +goose StatementEnd
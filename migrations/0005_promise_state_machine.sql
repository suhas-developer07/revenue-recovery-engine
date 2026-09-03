-- +goose Up
-- +goose StatementBegin


ALTER TABLE promises
  ADD COLUMN state TEXT NOT NULL DEFAULT 'notified'
    CHECK (state IN ('notified', 'awaiting_response', 'promised', 'due', 'kept', 'broken', 're_escalated', 'written_off'));

-- Move any pre-existing rows onto the new state (legacy statuses map to a state).
UPDATE promises SET state = 'kept'    WHERE status = 'kept';
UPDATE promises SET state = 'broken'  WHERE status = 'broken';
UPDATE promises SET state = 'written_off' WHERE status = 'written_off';
-- legacy 'pending' and anything else -> notified (not yet responded to)

-- A promise in notified/awaiting_response has no promised date yet; it is only
-- set when the debtor actually responds with a date.
ALTER TABLE promises ALTER COLUMN promised_date DROP NOT NULL;

ALTER TABLE promises
  ADD COLUMN responded_at TIMESTAMPTZ,
  ADD COLUMN resolved_at TIMESTAMPTZ;

-- Drop the legacy summary column now that state is authoritative.
ALTER TABLE promises DROP COLUMN status;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE promises
  ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'kept', 'broken', 'written_off'));

UPDATE promises SET status = CASE state
  WHEN 'kept' THEN 'kept'
  WHEN 'broken' THEN 'broken'
  WHEN 'written_off' THEN 'written_off'
  ELSE 'pending'
END;

ALTER TABLE promises
  DROP COLUMN state,
  DROP COLUMN responded_at,
  DROP COLUMN resolved_at,
  ALTER COLUMN promised_date SET NOT NULL;

-- +goose StatementEnd
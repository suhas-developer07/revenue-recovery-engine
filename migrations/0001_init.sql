-- +goose Up
-- +goose StatementBegin

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,             
  event_type TEXT NOT NULL,          -- 'payment.failed', 'subscription.pending', 'invoice.expired', 'checkout.abandoned'
  order_id TEXT,
  customer_id TEXT,
  amount_paise BIGINT,               -- always store money as integer paise, never float rupees
  raw_payload JSONB NOT NULL,        -- the full original webhook body, for debugging/audit
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_order_id ON events(order_id);
CREATE INDEX idx_events_customer_id ON events(customer_id);
CREATE INDEX idx_events_received_at ON events(received_at);

-- Idempotency: prevents double-processing if Razorpay resends a webhook
CREATE TABLE processed_webhook_ids (
  razorpay_event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  risk_category TEXT NOT NULL,       -- 'insufficient_funds' | 'bank_timeout' | 'expired_card' | 'otp_failure'
                                      -- | 'risk_block' | 'mandate_revoked' | 'checkout_abandoned' | 'invoice_overdue'
  root_cause_narrative TEXT,         -- human-readable explanation, often LLM-generated
  classified_by TEXT NOT NULL CHECK (classified_by IN ('rules_engine', 'llm', 'sweep')),
  priority_score NUMERIC,            -- amount_at_risk x recoverability_weight — used for batch prioritization
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_classifications_event_id ON classifications(event_id);
CREATE INDEX idx_classifications_risk_category ON classifications(risk_category);


CREATE TABLE decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  action TEXT NOT NULL,              -- matches action.schema.json's enum
  channel TEXT,                      -- 'in_app' | 'sms' | 'email' | 'whatsapp' | 'voice' | 'none'
  authorized_by_rule TEXT,           -- e.g. 'RETRY_ALLOWED_BELOW_15K_AFA_THRESHOLD' — NULL if blocked
  blocked BOOLEAN NOT NULL DEFAULT false,
  block_reason TEXT,                 -- e.g. 'BLOCKED_MANDATE_REVOKED' — NULL if not blocked
  attempt_number INT NOT NULL DEFAULT 1,
  cooldown_until TIMESTAMPTZ,        -- next earliest retry time, enforced by policy layer
  reasoning TEXT,                    -- short natural-language justification, useful for --explain mode and audit UI
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_decisions_event_id ON decisions(event_id);
CREATE INDEX idx_decisions_blocked ON decisions(blocked);


CREATE TABLE actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'pending')),
  amount_recovered_paise BIGINT NOT NULL DEFAULT 0,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome_payload JSONB              -- raw response from Razorpay API or channel adapter, for debugging
);

CREATE INDEX idx_actions_decision_id ON actions(decision_id);
CREATE INDEX idx_actions_status ON actions(status);


CREATE TABLE promises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  promised_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'kept', 'broken', 'written_off')),
  escalation_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_promises_event_id ON promises(event_id);
CREATE INDEX idx_promises_status ON promises(status);


CREATE TABLE customer_preferences (
  customer_id TEXT PRIMARY KEY,
  opted_out_channels TEXT[] NOT NULL DEFAULT '{}',   -- e.g. {'sms', 'voice'}
  mandate_status TEXT NOT NULL DEFAULT 'active' CHECK (mandate_status IN ('active', 'revoked')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE IF EXISTS customer_preferences;
DROP TABLE IF EXISTS promises;
DROP TABLE IF EXISTS actions;
DROP TABLE IF EXISTS decisions;
DROP TABLE IF EXISTS classifications;
DROP TABLE IF EXISTS processed_webhook_ids;
DROP TABLE IF EXISTS events;

-- +goose StatementEnd

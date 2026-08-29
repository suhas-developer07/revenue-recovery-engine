-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- EVENTS: raw signals coming in — the "what happened" layer
-- ============================================================
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  order_id TEXT,
  customer_id TEXT,
  amount_paise BIGINT,
  raw_payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_order_id ON events(order_id);
CREATE INDEX idx_events_customer_id ON events(customer_id);
CREATE INDEX idx_events_received_at ON events(received_at);

CREATE TABLE processed_webhook_ids (
  razorpay_event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CLASSIFICATIONS: the "why did this happen" layer
-- ============================================================
CREATE TABLE classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) UNIQUE,
  risk_category TEXT NOT NULL,
  root_cause_narrative TEXT,
  classified_by TEXT NOT NULL CHECK (classified_by IN ('rules_engine', 'llm', 'sweep')),
  priority_score NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_classifications_event_id ON classifications(event_id);
CREATE INDEX idx_classifications_risk_category ON classifications(risk_category);

-- ============================================================
-- DECISIONS: the "what should we do about it, and are we allowed" layer
-- ============================================================
CREATE TABLE decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  classification_id UUID UNIQUE REFERENCES classifications(id),
  action TEXT NOT NULL,
  channel TEXT,
  authorized_by_rule TEXT,
  blocked BOOLEAN NOT NULL DEFAULT false,
  block_reason TEXT,
  attempt_number INT NOT NULL DEFAULT 1,
  cooldown_until TIMESTAMPTZ,
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_decisions_event_id ON decisions(event_id);
CREATE INDEX idx_decisions_blocked ON decisions(blocked);

-- ============================================================
-- ACTIONS: the "what actually happened when we tried" layer
-- ============================================================
CREATE TABLE actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'pending')),
  amount_recovered_paise BIGINT NOT NULL DEFAULT 0,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome_payload JSONB
);

CREATE INDEX idx_actions_decision_id ON actions(decision_id);
CREATE INDEX idx_actions_status ON actions(status);

-- ============================================================
-- PROMISES: promise-to-pay state machine
-- ============================================================
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

-- ============================================================
-- CUSTOMER PREFERENCES: opt-outs, mandate status
-- ============================================================
CREATE TABLE customer_preferences (
  customer_id TEXT PRIMARY KEY,
  opted_out_channels TEXT[] NOT NULL DEFAULT '{}',
  mandate_status TEXT NOT NULL DEFAULT 'active' CHECK (mandate_status IN ('active', 'revoked')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

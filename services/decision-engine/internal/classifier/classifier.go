package classifier

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
)

// Result is the outcome of classifying a single event.
type Result struct {
	Category           string
	ClassifiedBy       string // 'rules_engine' | 'llm'
	RootCauseNarrative string
	PriorityScore      float64
}

// LLMClassifier is the interface the rules engine falls back to. Implemented by
// the HTTP client that calls llm-orchestrator's /classify endpoint.
type LLMClassifier interface {
	Classify(ctx context.Context, eventType, signal string) (Category string, narrative string, err error)
}

// eventSignal materializes the text we classify against from the raw payload.
// Razorpay nest the relevant fields differently per event type; we extract a
// broad set of candidate fields and concatenate the non-empty ones.
type eventSignal struct {
	eventType        string
	errorCode        string
	errorDescription string
	description      string
}

func extractSignal(eventType string, raw []byte) eventSignal {
	s := eventSignal{eventType: eventType}

	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return s
	}

	// Dig into payload.<kind>.entity — the envelope shape from Phase 1.
	var entity map[string]interface{}
	if payload, ok := m["payload"].(map[string]interface{}); ok {
		for _, key := range []string{"payment", "subscription", "invoice", "order", "coupon"} {
			if block, ok := payload[key].(map[string]interface{}); ok {
				if e, ok := block["entity"].(map[string]interface{}); ok {
					entity = e
					break
				}
			}
		}
	}

	str := func(k string) string {
		if v, ok := entity[k].(string); ok {
			return v
		}
		return ""
	}

	s.errorCode = str("error_code")
	s.errorDescription = str("error_description")
	s.description = firstNonEmpty(str("description"), str("failure_reason"), str("reason"), str("notes"))
	return s
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// SignalText returns the compact classification signal used both by the rules
// engine and the LLM prompt. Kept small and cheap.
func (s eventSignal) SignalText() string {
	parts := []string{s.eventType}
	if s.errorCode != "" {
		parts = append(parts, s.errorCode)
	}
	if s.errorDescription != "" {
		parts = append(parts, s.errorDescription)
	}
	if s.description != "" {
		parts = append(parts, s.description)
	}
	return strings.ToLower(strings.Join(parts, " "))
}

// ClassifyEvent runs the full classification pipeline for one event: rules first,
// LLM fallback for the ambiguous remainder, then priority score.
func ClassifyEvent(ctx context.Context, llm LLMClassifier, eventType string, amountPaise int64, raw []byte) (Result, error) {
	sig := extractSignal(eventType, raw)
	text := sig.SignalText()

	category, by, narrative := applyRules(text)

	// Ambiguous (no rule hit) → route to LLM.
	if category == "" {
		if llm == nil {
			category, by, narrative = CategoryUnknown, "llm", "no rule matched and no LLM configured; classified unknown"
		} else {
			cat, narr, err := llm.Classify(ctx, eventType, text)
			if err != nil {
				return Result{}, fmt.Errorf("llm classify failed: %w", err)
			}
			category = cat
			by = "llm"
			narrative = narr
		}
	}

	// Enforce the closed enum at the boundary. Never let an unvalidated string
	// (from the LLM or otherwise) land in the DB.
	if !ValidCategory(category) {
		slog.Warn("invalid category from classifier, coercing to unknown",
			"category", category, "event_type", eventType)
		category = CategoryUnknown
	}

	return Result{
		Category:           category,
		ClassifiedBy:       by,
		RootCauseNarrative: narrative,
		PriorityScore:      PriorityScore(amountPaise, category),
	}, nil
}

// applyRules returns (category, classifier, narrative). Empty category means no
// confident rule match and the caller should fall back to the LLM.
func applyRules(text string) (string, string, string) {
	for _, r := range rules {
		for _, m := range r.match {
			if strings.Contains(text, m) {
				return r.category, "rules_engine", fmt.Sprintf("matched rule keyword %q", m)
			}
		}
	}
	return "", "", ""
}

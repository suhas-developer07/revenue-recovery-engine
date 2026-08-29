package dispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/policy"
)

// Dispatch sends an authorized RecoveryAction to the Execution service over HTTP.
// It is fire-and-forget with a bounded timeout: a dispatch failure must never fail
// the surrounding decide (the decisions row is already persisted as the source of
// truth). The Execution service independently re-validates the payload against its
// zod schema and is idempotent on decision_id, so a retry here cannot double-execute.
func Dispatch(ctx context.Context, executionURL string, decisionID string, trace policy.DecisionTrace) {
	if executionURL == "" || decisionID == "" || trace.Blocked {
		return
	}

	payload := map[string]interface{}{
		"decision_id":  decisionID,
		"event_id":     trace.EventID,
		"amount_paise": trace.AmountPaise,
		"action":       trace.FinalAction,
		"target": map[string]string{
			"order_id":    trace.Target.OrderID,
			"customer_id": trace.Target.CustomerID,
		},
		"channel":            trace.FinalChannel,
		"reasoning":          trace.Reasoning,
		"authorized_by_rule": trace.AuthorizedByRule,
		"attempt_number":     trace.AttemptNumber,
		"cooldown_until":     ptrTimeRFC3339(trace.CooldownUntil),
	}

	body, err := json.Marshal(payload)
	if err != nil {
		slog.Error("dispatch: failed to marshal action", "error", err, "decision_id", decisionID)
		return
	}

	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, executionURL+"/execute", bytes.NewReader(body))
	if err != nil {
		slog.Error("dispatch: failed to build request", "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Non-fatal: the decision is still in the DB; a future sweep/retry can pick it up.
		slog.Warn("dispatch: execution call failed (non-fatal)", "error", err,
			"decision_id", decisionID, "action", trace.FinalAction)
		return
	}
	defer resp.Body.Close()
	slog.Info("dispatch: execution acknowledged",
		"decision_id", decisionID,
		"action", trace.FinalAction,
		"http_status", resp.StatusCode,
	)
}

func ptrTimeRFC3339(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return t.Format(time.RFC3339)
}

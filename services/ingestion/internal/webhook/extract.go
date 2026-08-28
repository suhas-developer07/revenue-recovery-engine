package webhook

import (
	"encoding/json"
	"fmt"

	"github.com/suhas-developer07/revenue-recovery-engine/services/ingestion/internal/db"
)

type razorpayPayload struct {
	Event   string                 `json:"event"`
	Payload map[string]interface{} `json:"payload"`
}

func extractEvent(parsed razorpayPayload, rawBody []byte) (db.Event, error) {
	var entity map[string]interface{}

	switch {
	case parsed.Payload["payment"] != nil:
		p, _ := parsed.Payload["payment"].(map[string]interface{})
		entity, _ = p["entity"].(map[string]interface{})
	case parsed.Payload["subscription"] != nil:
		s, _ := parsed.Payload["subscription"].(map[string]interface{})
		entity, _ = s["entity"].(map[string]interface{})
	case parsed.Payload["invoice"] != nil:
		i, _ := parsed.Payload["invoice"].(map[string]interface{})
		entity, _ = i["entity"].(map[string]interface{})
	case parsed.Payload["coupon"] != nil:
		c, _ := parsed.Payload["coupon"].(map[string]interface{})
		entity, _ = c["entity"].(map[string]interface{})
	case parsed.Payload["order"] != nil:
		o, _ := parsed.Payload["order"].(map[string]interface{})
		entity, _ = o["entity"].(map[string]interface{})
	default:
		return db.Event{}, fmt.Errorf("unrecognized payload shape for event %s", parsed.Event)
	}

	if entity == nil {
		return db.Event{}, fmt.Errorf("no entity found in payload for event %s", parsed.Event)
	}

	orderID := firstString(entity, "order_id", "id")
	customerID := firstString(entity, "customer_id", "customer", "notes")
	amountPaise := int64FromAny(entity["amount"])

	return db.Event{
		Source:      "razorpay_webhook",
		EventType:   parsed.Event,
		OrderID:     orderID,
		CustomerID:  customerID,
		AmountPaise: amountPaise,
		RawPayload:  json.RawMessage(rawBody),
	}, nil
}

func firstString(entity map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := entity[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// int64FromAny converts a JSON number to int64 paise. Razorpay already sends
// amounts in paise, so no unit conversion is applied here.
func int64FromAny(v interface{}) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return i
		}
		if f, err := n.Float64(); err == nil {
			return int64(f)
		}
	}
	return 0
}

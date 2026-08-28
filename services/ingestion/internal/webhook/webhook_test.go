package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

const testSecret = "test-webhook-secret"

func sign(payload []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestVerifySignature_Valid(t *testing.T) {
	body := []byte(`{"event":"payment.failed","payload":{}}`)
	sig := sign(body, testSecret)

	ok, err := VerifySignature(body, sig, testSecret)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected signature to verify")
	}
}

func TestVerifySignature_Invalid(t *testing.T) {
	body := []byte(`{"event":"payment.failed","payload":{}}`)

	ok, err := VerifySignature(body, "deadbeef", testSecret)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("expected invalid signature to fail verification")
	}
}

func TestVerifySignature_MissingSignature(t *testing.T) {
	body := []byte(`{"event":"payment.failed"}`)
	_, err := VerifySignature(body, "", testSecret)
	if err == nil {
		t.Fatal("expected error for missing signature")
	}
}

func TestVerifySignature_EmptySecret(t *testing.T) {
	body := []byte(`{"event":"payment.failed"}`)
	_, err := VerifySignature(body, "abc", "")
	if err == nil {
		t.Fatal("expected error for empty secret")
	}
}

func TestVerifySignature_BodySensitive(t *testing.T) {
	// HMAC is byte-sensitive: changing one byte must invalidate the signature.
	body := []byte(`{"event":"payment.failed","payload":{"a":1}}`)
	body2 := []byte(`{"event":"payment.failed","payload":{"a":2}}`)
	sig := sign(body, testSecret)

	ok, _ := VerifySignature(body2, sig, testSecret)
	if ok {
		t.Fatal("signature tied to different bytes must not verify")
	}
}

func TestExtractEvent_PaymentFailure(t *testing.T) {
	raw := []byte(`{
		"event": "payment.failed",
		"payload": {
			"payment": {
				"entity": {
					"order_id": "order_E123",
					"customer_id": "cust_ABC",
					"amount": 25000
				}
			}
		}
	}`)
	var parsed razorpayPayload
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	ev, err := extractEvent(parsed, raw)
	if err != nil {
		t.Fatalf("extract failed: %v", err)
	}
	if ev.EventType != "payment.failed" {
		t.Errorf("wrong event type: %s", ev.EventType)
	}
	if ev.OrderID != "order_E123" {
		t.Errorf("wrong order id: %s", ev.OrderID)
	}
	if ev.CustomerID != "cust_ABC" {
		t.Errorf("wrong customer id: %s", ev.CustomerID)
	}
	if ev.AmountPaise != 25000 {
		t.Errorf("wrong amount paise: %d", ev.AmountPaise)
	}
	if ev.Source != "razorpay_webhook" {
		t.Errorf("wrong source: %s", ev.Source)
	}
}

func TestExtractEvent_SubscriptionNoAmount(t *testing.T) {
	raw := []byte(`{
		"event": "subscription.pending",
		"payload": {
			"subscription": {
				"entity": {
					"id": "sub_XYZ"
				}
			}
		}
	}`)
	var parsed razorpayPayload
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	ev, err := extractEvent(parsed, raw)
	if err != nil {
		t.Fatalf("extract failed: %v", err)
	}
	if ev.OrderID != "sub_XYZ" {
		t.Errorf("expected id fallback for order_id, got: %s", ev.OrderID)
	}
	if ev.AmountPaise != 0 {
		t.Errorf("expected 0 amount for missing field, got: %d", ev.AmountPaise)
	}
}

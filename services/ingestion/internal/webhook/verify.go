package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// VerifySignature checks that `signature` (from the X-Razorpay-Signature header)
// matches the HMAC-SHA256 of `payload` (the RAW request body bytes, captured before
// any json.Unmarshal), using the configured webhook secret.
func VerifySignature(payload []byte, signature, secret string) (bool, error) {
	if secret == "" {
		return false, fmt.Errorf("RAZORPAY_WEBHOOK_SECRET not set")
	}
	if signature == "" {
		return false, fmt.Errorf("missing X-Razorpay-Signature header")
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expectedMAC := hex.EncodeToString(mac.Sum(nil))

	// hmac.Equal performs a constant-time comparison, avoiding a timing side-channel.
	return hmac.Equal([]byte(signature), []byte(expectedMAC)), nil
}

package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
)

// VerifySignature checks the Razorpay webhook HMAC-SHA256 signature.
func VerifySignature(r *http.Request) (bool, error) {
	secret := os.Getenv("RAZORPAY_WEBHOOK_SECRET")
	if secret == "" {
		return false, fmt.Errorf("RAZORPAY_WEBHOOK_SECRET not set")
	}

	signature := r.Header.Get("X-Razorpay-Signature")
	if signature == "" {
		return false, fmt.Errorf("missing X-Razorpay-Signature header")
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		return false, fmt.Errorf("failed to read request body: %w", err)
	}
	defer r.Body.Close()

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expectedMAC := hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(signature), []byte(expectedMAC)), nil
}

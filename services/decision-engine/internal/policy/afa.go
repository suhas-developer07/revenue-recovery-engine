package policy

import "time"

// AFAThresholdPaise is RBI's Additional Factor Authentication threshold for
// recurring debits: above ₹15,000, every transaction needs OTP/AFA and cannot be
// silently auto-retried.
const AFAThresholdPaise int64 = 15_000_00 // ₹15,000 in paise

// PreDebitNotice is the minimum notice window RBI requires before an auto-debit.
const PreDebitNotice = 24 * time.Hour

// IsBelowAFAThreshold reports whether a recurring charge is under the ₹15,000
// AFA threshold and may therefore be silently retried. Above it, a blind retry
// is non-compliant — the decision layer must route to an authenticated payment
// link instead.
func IsBelowAFAThreshold(amountPaise int64) (bool, string) {
	// Equality (exactly ₹15,000) trips the threshold: AFA applies at / above it.
	if amountPaise >= AFAThresholdPaise {
		return false, "AFA_THRESHOLD_EXCEEDED"
	}
	return true, ""
}

// IsWithinPreDebitWindow reports whether the customer has been notified at least
// PreDebitNotice (24h) before this auto-debit attempt. Multiplied here: returns
// false (blocked) if the notice is missing or newer than the required window.
func IsWithinPreDebitWindow(lastNotifiedAt *time.Time, now time.Time) (bool, string) {
	if lastNotifiedAt == nil {
		return false, "PRE_DEBIT_NOTICE_WINDOW_NOT_MET"
	}
	if now.Sub(*lastNotifiedAt) < PreDebitNotice {
		return false, "PRE_DEBIT_NOTICE_WINDOW_NOT_MET"
	}
	return true, ""
}

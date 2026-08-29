package policy

// IsMandateRevoked is a hard kill-switch. If the mandate is revoked, no retry or
// recovery action is ever tolerated for the subscription — this short-circuits
// every other check.
func IsMandateRevoked(mandateStatus string) (bool, string) {
	if mandateStatus == "revoked" {
		return false, "MANDATE_REVOKED"
	}
	return true, ""
}

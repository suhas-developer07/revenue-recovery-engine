package policy

import "time"

// IsWithinCooldown reports whether a retry would be inside the scheduled backoff
// window and therefore must not run yet. A nil cooldown means no active backoff.
func IsWithinCooldown(cooldownUntil *time.Time, now time.Time) (bool, string) {
	if cooldownUntil != nil && now.Before(*cooldownUntil) {
		return false, "WITHIN_COOLDOWN_WINDOW"
	}
	return true, ""
}

package policy

import "time"

// DefaultMaxAttempts is the retry ceiling for a single recovery action.
const DefaultMaxAttempts = 3

// DefaultEscalationCeiling is the total number of cross-channel escalation
// attempts before we stop automated contact and hand off (or write off).
const DefaultEscalationCeiling = 5

// BackoffBase is the duration of the first retry cooldown; each subsequent
// attempt doubles it, bounding automated retries over plausible bank-side windows.
const BackoffBase = 6 * time.Hour

// BackoffCooldown returns the earliest time the next attempt may run, using an
// exponential backoff (base * 2^(attempt-1)) that also spans salary-credit
// windows for "insufficient funds" style failures.
func BackoffCooldown(attemptNumber int, now time.Time) *time.Time {
	if attemptNumber < 1 {
		attemptNumber = 1
	}
	wait := BackoffBase << (attemptNumber - 1)
	t := now.Add(wait)
	return &t
}

// HasExceededMaxAttempts reports whether the attempt number has surpassed the
// retry ceiling for this action. Returns false (blocked) once exceeded.
func HasExceededMaxAttempts(attemptNumber, cap int) (bool, string) {
	if attemptNumber > cap {
		return false, "MAX_ATTEMPTS_EXCEEDED"
	}
	return true, ""
}

// HasExceededEscalationCeiling reports whether total cross-channel escalation
// attempts have hit the ceiling — the point where the agent must stop and
// downgrade to human review / write-off.
func HasExceededEscalationCeiling(escalationCount, ceiling int) (bool, string) {
	if escalationCount >= ceiling {
		return false, "ESCALATION_CEILING_REACHED"
	}
	return true, ""
}

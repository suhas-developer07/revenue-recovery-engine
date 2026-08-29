package policy

import (
	"time"
)

// QuietHourStart and QuietHourEnd bound the hours during which outbound customer
// contact is permitted. Defaults mirror a reasonable 9am–7pm local window.
const (
	QuietHourStart = 9
	QuietHourEnd   = 19
)

// IsOutsideQuietHours reports whether `now` (in the customer's own timezone) falls
// inside the permitted contact window. Returns false (blocked) when we'd be
// contacting them outside 9am–7pm local time. Checks the pure hour:minute of the
// wall-clock time in the given tz, so DST and offsets are handled by time.LoadLocation.
func IsOutsideQuietHours(now time.Time, tz string) (bool, string) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		// Unrecognized timezone — treat as a blocker rather than risk an out-of-hours call.
		return false, "OUTSIDE_QUIET_HOURS"
	}
	local := now.In(loc)
	h := local.Hour()
	if h < QuietHourStart || h >= QuietHourEnd {
		return false, "OUTSIDE_QUIET_HOURS"
	}
	return true, ""
}

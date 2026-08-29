package policy

// IsOptedOut reports whether the customer has opted out of the proposed channel
// (DND/opt-out respect). Returns false (blocked) if they have; the decision layer
// should then fall back to a lower-friction channel or an in-app notification.
func IsOptedOut(channel Channel, optedOut []Channel) (bool, string) {
	for _, c := range optedOut {
		if c == channel {
			return false, "CUSTOMER_OPTED_OUT_OF_CHANNEL"
		}
	}
	if channel == ChannelNone {
		return false, "NO_CHANNEL_SELECTED"
	}
	return true, ""
}

package policy

import (
	"fmt"
	"strings"
)

// Explain renders a DecisionTrace as a readable ordered reasoning chain for the
// --explain CLI mode and the dashboard's explain view.
func (t DecisionTrace) Explain() string {
	var b strings.Builder

	b.WriteString("Decision explanation for event ")
	b.WriteString(t.EventID)
	b.WriteString("\n")
	b.WriteString("Candidate action: ")
	b.WriteString(string(t.CandidateAction))
	b.WriteString("\n\n")

	b.WriteString(strings.Repeat("-", 60))
	b.WriteString("\nPolicy checks (in order):\n")
	for i, c := range t.Checks {
		status := "PASS"
		if !c.Passed {
			status = "BLOCK"
		}
		fmt.Fprintf(&b, "  %d. %-28s %-5s %s\n", i+1, c.RuleName, status, c.Reason)
	}

	b.WriteString(strings.Repeat("-", 60))
	b.WriteString("\nResult: ")
	if t.Blocked {
		fmt.Fprintf(&b, "BLOCKED (%s) — %s\n", t.FailedCheck, t.BlockReason)
	} else {
		fmt.Fprintf(&b, "AUTHORIZED %s via %s\n", t.FinalAction, t.AuthorizedByRule)
	}
	fmt.Fprintf(&b, "  channel: %s\n", t.FinalChannel)
	fmt.Fprintf(&b, "  attempt: %d\n", t.AttemptNumber)
	if t.CooldownUntil != nil {
		fmt.Fprintf(&b, "  cooldown_until: %s\n", t.CooldownUntil.Format("2006-01-02T15:04:05Z07:00"))
	}
	fmt.Fprintf(&b, "  reasoning: %s\n", t.Reasoning)

	return b.String()
}

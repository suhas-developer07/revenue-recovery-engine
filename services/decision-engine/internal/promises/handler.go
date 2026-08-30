package promises

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/db"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/statemachine"
)

// Handler mounts the promise-to-pay tracker HTTP surface: create, list, the live
// "simulate debtor response" path, generic transition triggers, and metrics.
type Handler struct {
	Svc *Service
}

func (h *Handler) Routes() http.Handler {
	r := chi.NewRouter()
	r.Post("/", h.create)
	r.Get("/", h.list)
	r.Get("/metrics", h.metrics)
	r.Post("/{id}/respond", h.respond)
	r.Post("/{id}/advance", h.advance)
	return r
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		EventID string `json:"event_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.EventID == "" {
		httpError(w, http.StatusBadRequest, "event_id required")
		return
	}
	id, err := h.Svc.Create(r.Context(), body.EventID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to create promise")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id, "state": string(statemachine.StateNotified)})
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	ps, err := h.Svc.List(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to list promises")
		return
	}
	// Materialize the nullable fields to JSON.
	out := make([]map[string]interface{}, 0, len(ps))
	for _, p := range ps {
		out = append(out, map[string]interface{}{
			"id":                 p.ID,
			"event_id":           p.EventID,
			"state":              p.State,
			"promised_date":      p.PromisedDate,
			"escalation_count":   p.EscalationCount,
			"escalation_history": p.EscalationHistory,
			"responded_at":       p.RespondedAt,
			"resolved_at":        p.ResolvedAt,
			"created_at":         p.CreatedAt,
			"updated_at":         p.UpdatedAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// respond is the live "simulate debtor response" path: it moves a promise into the
// promised state and (optionally) stamps a typed promised_date for the demo.
func (h *Handler) respond(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		PromisedDate *string `json:"promised_date"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	state, err := h.Svc.Transition(r.Context(), id, statemachine.TriggerDebtorResponds)
	if err != nil {
		httpError(w, http.StatusBadRequest, "invalid transition: "+err.Error())
		return
	}
	if body.PromisedDate != nil && *body.PromisedDate != "" {
		if d, perr := time.Parse("2006-01-02", *body.PromisedDate); perr != nil {
			httpError(w, http.StatusBadRequest, "promised_date must be YYYY-MM-DD")
			return
		} else {
			_ = db.SetPromisedDate(r.Context(), h.Svc.Pool, id, d)
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "state": string(state)})
}

// advance drives any other machine trigger (date_arrives, paid, not_paid, timeout,
// request_response) — used to walk the demo through the full lifecycle, and by the
// escalation ceiling test.
func (h *Handler) advance(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Trigger string `json:"trigger"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid body")
		return
	}
	t, ok := parseTrigger(body.Trigger)
	if !ok {
		httpError(w, http.StatusBadRequest, "unknown trigger: "+body.Trigger)
		return
	}
	state, err := h.Svc.Transition(r.Context(), id, t)
	if err != nil {
		httpError(w, http.StatusBadRequest, "invalid transition: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "state": string(state)})
}

func (h *Handler) metrics(w http.ResponseWriter, r *http.Request) {
	m, err := db.PromiseMetrics(r.Context(), h.Svc.Pool)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to compute metrics")
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func parseTrigger(s string) (statemachine.Trigger, bool) {
	switch s {
	case string(statemachine.TriggerRequestResponse):
		return statemachine.TriggerRequestResponse, true
	case string(statemachine.TriggerDebtorResponds):
		return statemachine.TriggerDebtorResponds, true
	case string(statemachine.TriggerDateArrives):
		return statemachine.TriggerDateArrives, true
	case string(statemachine.TriggerPaid):
		return statemachine.TriggerPaid, true
	case string(statemachine.TriggerNotPaid):
		return statemachine.TriggerNotPaid, true
	case string(statemachine.TriggerTimeout):
		return statemachine.TriggerTimeout, true
	default:
		return "", false
	}
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

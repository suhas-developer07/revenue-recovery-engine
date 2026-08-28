package webhook

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/suhas-developer07/revenue-recovery-engine/services/ingestion/internal/db"
	"github.com/suhas-developer07/revenue-recovery-engine/services/ingestion/internal/queue"
)

type Handler struct {
	Pool                  *pgxpool.Pool
	Publisher             *queue.Publisher
	RazorpayWebhookSecret string
}

func (h *Handler) HandleRazorpayWebhook(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Read the raw body ONCE. HMAC is byte-sensitive: re-marshaling the JSON
	// before verifying would fail even on genuine Razorpay payloads, so verify
	// against these exact bytes captured before any Unmarshal.
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "cannot read body", http.StatusBadRequest)
		return
	}

	signature := r.Header.Get("X-Razorpay-Signature")
	ok, verr := VerifySignature(body, signature, h.RazorpayWebhookSecret)
	if verr != nil || !ok {
		slog.Warn("rejected webhook: invalid or missing signature",
			"remote_addr", r.RemoteAddr,
			"has_signature_header", signature != "",
			"verify_error", verr,
		)
		// Deliberately vague to the caller — don't leak WHY verification failed.
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var parsed razorpayPayload
	if err := json.Unmarshal(body, &parsed); err != nil {
		slog.Error("failed to parse webhook payload", "error", err)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	razorpayEventID := r.Header.Get("X-Razorpay-Event-Id")
	if razorpayEventID == "" {
		// Fall back to a payload-derived ID if the header isn't present (test mode).
		razorpayEventID = parsed.Event + "_" + hashBody(body)
	}

	alreadyProcessed, err := db.AlreadyProcessed(ctx, h.Pool, razorpayEventID)
	if err != nil {
		slog.Error("idempotency check failed", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if alreadyProcessed {
		slog.Info("duplicate webhook ignored", "razorpay_event_id", razorpayEventID)
		// Still 200 so Razorpay doesn't retry a duplicate we've already accepted.
		w.WriteHeader(http.StatusOK)
		return
	}

	event, extractErr := extractEvent(parsed, body)
	if extractErr != nil {
		slog.Error("failed to extract event fields", "error", extractErr, "razorpay_event", parsed.Event)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	eventID, err := db.InsertEvent(ctx, h.Pool, event)
	if err != nil {
		slog.Error("failed to insert event", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if err := db.MarkProcessed(ctx, h.Pool, razorpayEventID); err != nil {
		// Non-fatal: event is already inserted; worst case we reprocess once.
		slog.Error("failed to mark webhook as processed", "error", err)
	}

	if h.Publisher != nil {
		if err := h.Publisher.PublishNewEvent(ctx, eventID); err != nil {
			// Non-fatal: the Decision Engine can poll the events table as a fallback.
			slog.Error("failed to publish to queue", "error", err, "event_id", eventID)
		}
	}

	slog.Info("event ingested",
		"event_id", eventID,
		"event_type", event.EventType,
		"order_id", event.OrderID,
		"customer_id", event.CustomerID,
		"amount_paise", event.AmountPaise,
	)
	w.WriteHeader(http.StatusOK)
}

func hashBody(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

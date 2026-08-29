package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/classifier"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/config"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/db"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/decider"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/llm"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/queue"
)

const (
	abandonedWindow = 30 * time.Minute
	sweepInterval   = 2 * time.Minute
	backfillLimit   = 200
)

func main() {
	// --explain <eventID>: print the stored reasoning trace for a past decision.
	for i, a := range os.Args[1:] {
		if a == "--explain" {
			eventID := ""
			if i+2 < len(os.Args) {
				eventID = os.Args[i+2]
			}
			if eventID == "" {
				slog.Error("usage: --explain <event_id>")
				os.Exit(2)
			}
			runExplain(eventID)
			return
		}
	}

	cfg := config.Load()
	ctx := context.Background()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	rdb, err := queue.NewClient(cfg.RedisURL)
	if err != nil {
		slog.Warn("failed to connect to redis, continuing without queue", "error", err)
		rdb = nil
	}

	llmClient := llm.NewClient(cfg.LLMOrchestratorURL)
	svc := &classifier.Service{Pool: pool, LLM: llmClient}
	decSvc := &decider.Service{Pool: pool}

	var publisher *queue.Publisher
	if rdb != nil {
		publisher = queue.NewPublisher(rdb)
	}

	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// 1. Backfill: classify any events that never got classified (covers a
	//    Redis stream flush or a restart between publish and consume).
	go func() {
		slog.Info("starting classification backfill")
		if err := svc.Backfill(workerCtx, backfillLimit); err != nil {
			slog.Error("backfill failed", "error", err)
		}
	}()

	// 2. Consume new_events stream and classify each event.
	if rdb != nil {
		consumer := queue.NewConsumer(rdb, queue.StreamNewEvents, "classifier-worker")
		go func() {
			err := consumer.Run(workerCtx, func(ctx context.Context, eventID string) error {
				classID, err := svc.ClassifyEventByID(ctx, eventID)
				if err == nil && publisher != nil {
					_ = publisher.PublishClassification(ctx, classID)
				}
				return err
			})
			if err != nil && err != context.Canceled {
				slog.Error("stream consumer exited", "error", err)
			}
		}()
	}

	// 3. Polling sweep for checkout_abandoned (absence-based, no webhook).
	go func() {
		ticker := time.NewTicker(sweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-workerCtx.Done():
				return
			case <-ticker.C:
				if err := svc.SweepCheckoutAbandoned(workerCtx, abandonedWindow); err != nil {
					slog.Error("checkout sweep failed", "error", err)
				}
			}
		}
	}()

	// 4. Consume new_classifications stream and run each through the decision
	//    engine, writing exactly one decisions row (authorized or blocked).
	if rdb != nil {
		decisionConsumer := queue.NewConsumer(rdb, queue.StreamClassifications, "decider-worker")
		go func() {
			err := decisionConsumer.Run(workerCtx, func(ctx context.Context, classificationID string) error {
				_, _, err := decSvc.DecideAndPersist(ctx, classificationID)
				return err
			})
			if err != nil && err != context.Canceled {
				slog.Error("decision consumer exited", "error", err)
			}
		}()
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok","service":"decision-engine"}`))
	})

	r.Get("/classify/{eventID}", func(w http.ResponseWriter, r *http.Request) {
		eventID := chi.URLParam(r, "eventID")
		id, err := svc.ClassifyEventByID(r.Context(), eventID)
		if err != nil {
			slog.Error("manual classify failed", "error", err, "event_id", eventID)
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":"classification failed"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"classification_id":"` + id + `"}`))
	})

	// Manually run the decision layer for an event (classify -> decide -> persist).
	r.Post("/decide/{eventID}", func(w http.ResponseWriter, r *http.Request) {
		eventID := chi.URLParam(r, "eventID")
		classID, err := svc.ClassifyEventByID(r.Context(), eventID)
		if err != nil {
			slog.Error("decide: classification failed", "error", err, "event_id", eventID)
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":"classification failed"}`))
			return
		}
		_, trace, err := decSvc.DecideAndPersist(r.Context(), classID)
		if err != nil {
			slog.Error("decide: decision failed", "error", err, "event_id", eventID)
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":"decision failed"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"event_id":           eventID,
			"action":             trace.FinalAction,
			"channel":            trace.FinalChannel,
			"blocked":            trace.Blocked,
			"block_reason":       trace.BlockReason,
			"authorized_by_rule": trace.AuthorizedByRule,
		})
	})

	// Explain endpoint: returns the stored (accumulated) decision trace as JSON.
	r.Get("/decisions/{eventID}/explain", func(w http.ResponseWriter, r *http.Request) {
		eventID := chi.URLParam(r, "eventID")
		trace, found, err := decSvc.ExplainEvent(r.Context(), eventID)
		if err != nil {
			slog.Error("explain failed", "error", err, "event_id", eventID)
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":"failed to load decision trace"}`))
			return
		}
		if !found {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":"no decision recorded for event"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(trace)
	})

	slog.Info("decision-engine service starting", "port", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, r); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}

// runExplain loads the stored decision trace for an event and prints the ordered
// reasoning chain. It reads the trace persisted at decision time — it does not
// re-run the policy (the trace is evidence, not a reconstruction).
func runExplain(eventID string) {
	cfg := config.Load()
	ctx := context.Background()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	svc := &decider.Service{Pool: pool}
	trace, found, err := svc.ExplainEvent(ctx, eventID)
	if err != nil {
		slog.Error("explain failed", "error", err)
		os.Exit(1)
	}
	if !found {
		slog.Error("no decision recorded for event", "event_id", eventID)
		os.Exit(1)
	}
	println(trace.Explain())
}

package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/classifier"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/config"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/db"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/llm"
	"github.com/suhas-developer07/revenue-recovery-engine/services/decision-engine/internal/queue"
)

const (
	abandonedWindow = 30 * time.Minute
	sweepInterval   = 2 * time.Minute
	backfillLimit   = 200
)

func main() {
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

	slog.Info("decision-engine service starting", "port", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, r); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}

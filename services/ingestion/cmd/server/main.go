package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/suhas-developer07/revenue-recovery-engine/services/ingestion/internal/config"
	"github.com/suhas-developer07/revenue-recovery-engine/services/ingestion/internal/db"
	"github.com/suhas-developer07/revenue-recovery-engine/services/ingestion/internal/queue"
	"github.com/suhas-developer07/revenue-recovery-engine/services/ingestion/internal/webhook"
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

	publisher, err := queue.NewPublisher(cfg.RedisURL)
	if err != nil {
		slog.Warn("failed to connect to redis, continuing without queue publish", "error", err)
		publisher = nil
	} else if err := publisher.Ping(ctx); err != nil {
		slog.Warn("redis ping failed, continuing without queue publish", "error", err)
		publisher = nil
	} else {
		defer publisher.Close()
	}

	h := &webhook.Handler{
		Pool:                  pool,
		Publisher:             publisher,
		RazorpayWebhookSecret: cfg.RazorpayWebhookSecret,
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok","service":"ingestion"}`))
	})

	r.Post("/webhook/razorpay", h.HandleRazorpayWebhook)

	slog.Info("ingestion service starting", "port", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, r); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}

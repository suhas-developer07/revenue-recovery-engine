package config

import (
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	Port               string
	DatabaseURL        string
	RedisURL           string
	LLMOrchestratorURL string
}

func Load() Config {
	// best-effort load from repo-root .env when running standalone; Docker Compose
	// injects real env vars via env_file and takes precedence.
	_ = godotenv.Load("../../.env")

	return Config{
		Port:               getEnv("PORT", "8080"),
		DatabaseURL:        getEnv("DATABASE_URL", ""),
		RedisURL:           getEnv("REDIS_URL", ""),
		LLMOrchestratorURL: getEnv("LLM_ORCHESTRATOR_URL", "http://localhost:8084"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

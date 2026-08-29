package queue

import (
	"github.com/redis/go-redis/v9"
)

// Stream names shared across services. Ingestion publishes to StreamNewEvents;
// this service consumes it, classifies, and publishes to StreamClassifications.
const (
	StreamNewEvents       = "new_events"
	StreamClassifications = "new_classifications"
)

// group identifies this consumer group on each stream.
const group = "decision-engine"

// NewClient returns a connected *redis.Client from a redis:// URL.
func NewClient(redisURL string) (*redis.Client, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	return redis.NewClient(opt), nil
}

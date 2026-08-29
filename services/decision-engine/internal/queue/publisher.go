package queue

import (
	"context"

	"github.com/redis/go-redis/v9"
)

// Publisher sends classification-complete signals onto a stream for downstream
// consumers (the Decision Engine's policy layer in Phase 3).
type Publisher struct {
	client *redis.Client
}

func NewPublisher(client *redis.Client) *Publisher {
	return &Publisher{client: client}
}

// PublishClassification writes a new_classifications stream entry carrying the
// classification UUID that was just created.
func (p *Publisher) PublishClassification(ctx context.Context, classificationID string) error {
	return p.client.XAdd(ctx, &redis.XAddArgs{
		Stream: StreamClassifications,
		Values: map[string]interface{}{"classification_id": classificationID},
	}).Err()
}

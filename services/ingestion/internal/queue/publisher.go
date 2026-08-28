package queue

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const StreamName = "new_events"

type Publisher struct {
	client *redis.Client
}

func NewPublisher(redisURL string) (*Publisher, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	return &Publisher{client: redis.NewClient(opt)}, nil
}

func (p *Publisher) Close() error {
	return p.client.Close()
}

func (p *Publisher) Ping(ctx context.Context) error {
	return p.client.Ping(ctx).Err()
}

func (p *Publisher) PublishNewEvent(ctx context.Context, eventID string) error {
	return p.client.XAdd(ctx, &redis.XAddArgs{
		Stream: StreamName,
		Values: map[string]interface{}{"event_id": eventID},
	}).Err()
}

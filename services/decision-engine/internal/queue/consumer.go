package queue

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Consumer reads new event IDs off the new_events stream using a consumer group,
// which gives at-least-once delivery with explicit acknowledgement. The caller
// MUST Ack a message once its side effects (DB write) are durable; on restart,
// un-acked messages are re-delivered, which combined with the idempotent
// classification insert keeps "exactly one" invariant under retries.
type Consumer struct {
	client *redis.Client
	stream string
	group  string
	name   string
}

func NewConsumer(client *redis.Client, stream string, name string) *Consumer {
	return &Consumer{client: client, stream: stream, group: group, name: name}
}

// EnsureGroup creates the consumer group if it doesn't already exist.
func (c *Consumer) EnsureGroup(ctx context.Context) error {
	err := c.client.XGroupCreateMkStream(ctx, c.stream, c.group, "$").Err()
	if err == nil {
		return nil // group created (or stream was empty) — fine
	}
	// BUSYGROUP means the group already exists from a previous run — that's fine too.
	var rerr redis.Error
	if errors.As(err, &rerr) && strings.Contains(rerr.Error(), "BUSYGROUP") {
		return nil
	}
	return err
}

// HandleFunc processes a single event ID. It returns an error if the event could
// not be processed; in that case the message is left un-acked for later retry.
type HandleFunc func(ctx context.Context, eventID string) error

// Run blocks, reading new events in a loop and routing each to handle. It returns
// when ctx is cancelled.
func (c *Consumer) Run(ctx context.Context, handle HandleFunc) error {
	if err := c.EnsureGroup(ctx); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		streams, err := c.client.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    c.group,
			Consumer: c.name,
			Streams:  []string{c.stream, ">"},
			Count:    10,
			Block:    2 * time.Second,
		}).Result()
		if err == redis.Nil {
			continue // block window expired with no messages
		}
		if err != nil {
			slog.Error("failed to read stream", "error", err, "stream", c.stream)
			time.Sleep(500 * time.Millisecond)
			continue
		}

		for _, stream := range streams {
			for _, msg := range stream.Messages {
				eventID, _ := msg.Values["event_id"].(string)
				if eventID == "" {
					// Nothing useful to reprocess; ack to avoid a stuck message.
					_ = c.Ack(ctx, msg.ID)
					continue
				}

				if err := handle(ctx, eventID); err != nil {
					slog.Error("failed to handle event", "error", err, "event_id", eventID)
					// Leave un-acked so a later run retries it.
					continue
				}
				_ = c.Ack(ctx, msg.ID)
			}
		}
	}
}

// Ack acknowledges a processed message ID on the stream.
func (c *Consumer) Ack(ctx context.Context, messageID string) error {
	return c.client.XAck(ctx, c.stream, c.group, messageID).Err()
}

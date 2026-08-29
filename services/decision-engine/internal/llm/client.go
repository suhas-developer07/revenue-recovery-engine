package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client calls the TypeScript llm-orchestrator service's /classify endpoint.
// It is deliberately a thin HTTP client — the LLM app itself lives in TypeScript.
type Client struct {
	baseURL string
	http    *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

type classifyRequest struct {
	EventType string `json:"event_type"`
	Signal    string `json:"signal"`
}

type classifyResponse struct {
	Category  string `json:"category"`
	Narrative string `json:"narrative"`
}

// Classify calls /classify and returns the LLM's category and narrative.
func (c *Client) Classify(ctx context.Context, eventType, signal string) (string, string, error) {
	body, err := json.Marshal(classifyRequest{EventType: eventType, Signal: signal})
	if err != nil {
		return "", "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/classify", bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("llm-orchestrator /classify returned %d: %s", resp.StatusCode, string(data))
	}

	var out classifyResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", "", err
	}
	return out.Category, out.Narrative, nil
}

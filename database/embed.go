package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Embedder computes embeddings with the preset's endpoint, an
// OpenAI-compatible POST /embeddings. It adds the model's prefixes, which
// no endpoint adds by itself, and cuts the vectors to the model's
// dimensions, normalizing them again.
type Embedder struct {
	ep  Endpoint
	key string
	hc  *http.Client
}

// NewEmbedder is the embedder of an endpoint, with its key.
func NewEmbedder(ep Endpoint, key string) *Embedder {
	return &Embedder{ep: ep, key: key, hc: &http.Client{Timeout: time.Duration(ep.Timeout)}}
}

// Usage is what the embeddings cost: tokens, and dollars (the endpoint's
// figure when it gives one, else the preset's price).
type Usage struct {
	Tokens int     `json:"embedding_tokens"`
	Cost   float64 `json:"cost"`
}

func (u *Usage) add(o Usage) {
	u.Tokens += o.Tokens
	u.Cost += o.Cost
}

// Document is a text to embed as a document, with the title its template
// may use.
type Document struct {
	Text  string
	Title string
}

// Documents embeds documents with the model's template.
func (e *Embedder) Documents(ctx context.Context, m Model, docs []Document) ([][]float32, Usage, error) {
	texts := make([]string, len(docs))
	for i, d := range docs {
		title := d.Title
		if title == "" {
			title = "none"
		}
		texts[i] = strings.NewReplacer("{text}", cut(d.Text, m.MaxChars), "{title}", title).Replace(m.DocumentTemplate)
	}
	return e.embed(ctx, m, texts)
}

// Queries embeds questions with the model's prefix.
func (e *Embedder) Queries(ctx context.Context, m Model, qs []string) ([][]float32, Usage, error) {
	texts := make([]string, len(qs))
	for i, q := range qs {
		texts[i] = m.QueryPrefix + cut(q, m.MaxChars)
	}
	return e.embed(ctx, m, texts)
}

func cut(s string, n int) string {
	if n <= 0 || len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

type embeddingsResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float64 `json:"embedding"`
	} `json:"data"`
	Usage struct {
		PromptTokens int      `json:"prompt_tokens"`
		TotalTokens  int      `json:"total_tokens"`
		Cost         *float64 `json:"cost"`
	} `json:"usage"`
}

func (e *Embedder) embed(ctx context.Context, m Model, texts []string) ([][]float32, Usage, error) {
	out := make([][]float32, 0, len(texts))
	var usage Usage
	for start := 0; start < len(texts); start += m.Batch {
		batch := texts[start:min(start+m.Batch, len(texts))]
		vecs, u, err := e.request(ctx, m, batch)
		if err != nil {
			return nil, usage, err
		}
		out = append(out, vecs...)
		usage.add(u)
	}
	return out, usage, nil
}

func (e *Embedder) request(ctx context.Context, m Model, batch []string) ([][]float32, Usage, error) {
	body := map[string]any{}
	extra := e.ep.Body
	if m.Body != nil {
		extra = m.Body
	}
	for k, v := range extra {
		body[k] = v
	}
	body["model"], body["input"], body["encoding_format"] = m.ID, batch, "float"
	if m.SendDimensions && m.Dimensions > 0 {
		body["dimensions"] = m.Dimensions
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, Usage{}, err
	}
	var resp embeddingsResponse
	if err := e.post(ctx, raw, &resp); err != nil {
		return nil, Usage{}, fmt.Errorf("embeddings with %s: %w", m.Name, err)
	}
	if len(resp.Data) != len(batch) {
		return nil, Usage{}, fmt.Errorf("embeddings with %s: %d vectors for %d texts", m.Name, len(resp.Data), len(batch))
	}
	vecs := make([][]float32, len(batch))
	for _, d := range resp.Data {
		if d.Index < 0 || d.Index >= len(batch) || vecs[d.Index] != nil {
			return nil, Usage{}, fmt.Errorf("embeddings with %s: a vector with index %d", m.Name, d.Index)
		}
		if len(d.Embedding) < m.Size() {
			return nil, Usage{}, fmt.Errorf("embeddings with %s: a vector of %d numbers, the preset says %d", m.Name, len(d.Embedding), m.Size())
		}
		vecs[d.Index] = normalize(d.Embedding[:m.Size()])
	}
	u := Usage{Tokens: resp.Usage.PromptTokens}
	if u.Tokens == 0 {
		u.Tokens = resp.Usage.TotalTokens
	}
	if resp.Usage.Cost != nil {
		u.Cost = *resp.Usage.Cost
	} else {
		u.Cost = float64(u.Tokens) * m.Cost.Input / 1e6
	}
	return vecs, u, nil
}

// post sends a request, trying again a busy or failing endpoint (429,
// 5xx) three times, with its Retry-After when it gives one.
func (e *Embedder) post(ctx context.Context, raw []byte, out any) error {
	url := strings.TrimRight(e.ep.BaseURL, "/") + "/embeddings"
	wait := time.Second
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		if e.key != "" {
			req.Header.Set("Authorization", "Bearer "+e.key)
		}
		resp, err := e.hc.Do(req)
		if err != nil {
			return err
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
		resp.Body.Close()
		if err != nil {
			return err
		}
		if resp.StatusCode/100 == 2 {
			return json.Unmarshal(b, out)
		}
		msg := strings.TrimSpace(string(b))
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
		err = fmt.Errorf("%s: %s", resp.Status, msg)
		if attempt == 3 || (resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < 500) {
			return err
		}
		if s, perr := strconv.Atoi(resp.Header.Get("Retry-After")); perr == nil && s > 0 && s <= 60 {
			wait = time.Duration(s) * time.Second
		}
		select {
		case <-ctx.Done():
			return errors.Join(err, ctx.Err())
		case <-time.After(wait):
		}
		wait *= 2
	}
}

// normalize is v with length 1, as float32.
func normalize(v []float64) []float32 {
	var n float64
	for _, x := range v {
		n += x * x
	}
	n = math.Sqrt(n)
	if n == 0 {
		n = 1
	}
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = float32(x / n)
	}
	return out
}

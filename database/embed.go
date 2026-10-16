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
	Tokens int `json:"embedding_tokens"`
	// RerankTokens are those a reranker read: the question with each text.
	RerankTokens int     `json:"rerank_tokens,omitempty"`
	Cost         float64 `json:"cost"`
}

func (u *Usage) add(o Usage) {
	u.Tokens += o.Tokens
	u.RerankTokens += o.RerankTokens
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
		texts[i] = d.fill(m.DocumentTemplate, m.MaxChars, "none")
	}
	return e.embed(ctx, m, texts)
}

// fill is the document as a template makes it, its text cut to maxChars
// (0: whole), noTitle for a title it has not.
func (d Document) fill(template string, maxChars int, noTitle string) string {
	title := d.Title
	if title == "" {
		title = noTitle
	}
	return strings.NewReplacer("{text}", cut(d.Text, maxChars), "{title}", title).Replace(template)
}

// Queries embeds questions with the model's prefix, asking query_id when
// the preset gives one.
func (e *Embedder) Queries(ctx context.Context, m Model, qs []string) ([][]float32, Usage, error) {
	texts := make([]string, len(qs))
	for i, q := range qs {
		texts[i] = m.QueryPrefix + cut(q, m.MaxChars)
	}
	if m.QueryID != "" {
		m.ID = m.QueryID
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
	if err := postJSON(ctx, e.hc, strings.TrimRight(e.ep.BaseURL, "/")+"/embeddings", e.key, raw, &resp); err != nil {
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
		// A vector of zeros, or one whose squares overflowed, has no
		// direction: stored, its cosine is NaN and spoils the searches.
		if !unitLength(vecs[d.Index]) {
			return nil, Usage{}, fmt.Errorf("embeddings with %s: the vector of text %d of the batch cannot be made length 1 (zeros, or numbers too small or too large)", m.Name, d.Index+1)
		}
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

// postJSON sends a request to an endpoint's url, with its key, trying
// again a busy or failing endpoint (429, 5xx) three times, with its
// Retry-After when it gives one.
func postJSON(ctx context.Context, hc *http.Client, url, key string, raw []byte, out any) error {
	wait := time.Second
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		// Embeddings and scores can be asked again: Go then sends the
		// request again on a new connection when the endpoint closes a
		// kept one as it comes in. Empty, the header is not sent.
		req.Header["X-Idempotency-Key"] = nil
		resp, err := hc.Do(req)
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

// renormalize is v, float32, with length 1 again (halfvec rounds it).
func renormalize(v []float32) []float32 {
	f := make([]float64, len(v))
	for i, x := range v {
		f[i] = float64(x)
	}
	return normalize(f)
}

// unitLength tells whether v, as the stores keep it, has a length about 1
// (0.5 to 1.5): normalize gives zeros for a vector of zeros, and for one
// whose squares overflow or underflow float64.
func unitLength(v []float32) bool {
	var n float64
	for _, x := range v {
		n += float64(x) * float64(x)
	}
	return n >= 0.25 && n <= 2.25
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

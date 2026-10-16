package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
)

// Ranker asks the preset's rerankers to score texts against a question,
// each with its endpoint's key.
type Ranker struct {
	keys map[string]string
	hcs  map[string]*http.Client
}

// NewRanker is the ranker of a preset's rerankers; getenv reads their
// endpoints' keys.
func NewRanker(rs []Reranker, getenv func(string) string) *Ranker {
	r := &Ranker{keys: map[string]string{}, hcs: map[string]*http.Client{}}
	for _, m := range rs {
		if m.Endpoint.APIKeyEnv != "" {
			r.keys[m.Name] = getenv(m.Endpoint.APIKeyEnv)
		}
		r.hcs[m.Name] = &http.Client{Timeout: time.Duration(m.Endpoint.Timeout)}
	}
	return r
}

type rerankResponse struct {
	Results []struct {
		Index          int     `json:"index"`
		RelevanceScore float64 `json:"relevance_score"`
	} `json:"results"`
	Usage struct {
		PromptTokens int      `json:"prompt_tokens"`
		TotalTokens  int      `json:"total_tokens"`
		Cost         *float64 `json:"cost"`
	} `json:"usage"`
}

// Scores are the reranker's scores of the documents for the question, in
// the documents' order: mapped to 0..1 when the preset says sigmoid.
func (r *Ranker) Scores(ctx context.Context, m Reranker, query string, docs []Document) ([]float64, Usage, error) {
	out := make([]float64, 0, len(docs))
	var usage Usage
	for start := 0; start < len(docs); start += m.Batch {
		batch := docs[start:min(start+m.Batch, len(docs))]
		scores, u, err := r.request(ctx, m, query, batch)
		if err != nil {
			return nil, usage, err
		}
		out = append(out, scores...)
		usage.add(u)
	}
	return out, usage, nil
}

func (r *Ranker) request(ctx context.Context, m Reranker, query string, batch []Document) ([]float64, Usage, error) {
	texts := make([]string, len(batch))
	for i, d := range batch {
		// A title it has not stays empty: "none" is a convention of some
		// embedding models, not a reranker's.
		texts[i] = d.fill(m.DocumentTemplate, m.MaxChars, "")
	}
	body := map[string]any{}
	extra := m.Endpoint.Body
	if m.Body != nil {
		extra = m.Body
	}
	for k, v := range extra {
		body[k] = v
	}
	body["model"], body["query"], body["documents"] = m.ID, query, texts
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, Usage{}, err
	}
	hc := r.hcs[m.Name]
	if hc == nil {
		hc = &http.Client{Timeout: time.Duration(m.Endpoint.Timeout)}
	}
	var resp rerankResponse
	if err := postJSON(ctx, hc, strings.TrimRight(m.Endpoint.BaseURL, "/")+"/rerank", r.keys[m.Name], raw, &resp); err != nil {
		return nil, Usage{}, fmt.Errorf("rerank with %s: %w", m.Name, err)
	}
	if len(resp.Results) != len(batch) {
		return nil, Usage{}, fmt.Errorf("rerank with %s: %d scores for %d texts", m.Name, len(resp.Results), len(batch))
	}
	scores := make([]float64, len(batch))
	seen := make([]bool, len(batch))
	for _, res := range resp.Results {
		s := res.RelevanceScore
		switch {
		case res.Index < 0 || res.Index >= len(batch) || seen[res.Index]:
			return nil, Usage{}, fmt.Errorf("rerank with %s: a score with index %d", m.Name, res.Index)
		case math.IsNaN(s) || math.IsInf(s, 0):
			return nil, Usage{}, fmt.Errorf("rerank with %s: the score of text %d is no number", m.Name, res.Index+1)
		}
		if m.Sigmoid {
			s = 1 / (1 + math.Exp(-s))
		}
		scores[res.Index], seen[res.Index] = s, true
	}
	u := Usage{RerankTokens: resp.Usage.PromptTokens}
	if u.RerankTokens == 0 {
		u.RerankTokens = resp.Usage.TotalTokens
	}
	if resp.Usage.Cost != nil {
		u.Cost = *resp.Usage.Cost
	} else {
		u.Cost = float64(u.RerankTokens) * m.Cost.Input / 1e6
	}
	return scores, u, nil
}

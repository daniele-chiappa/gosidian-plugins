package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestEmbedder(t *testing.T) {
	fake := newFakeEndpoint(t, 16)
	cfg := testConfig(t, fake.URL, StoreConfig{Kind: "sqlite"})
	cfg.Endpoint.Body = map[string]any{"provider": map[string]any{"data_collection": "deny"}}
	m, _ := cfg.Model("bag")
	m.Cost.Input = 2
	e := NewEmbedder(cfg.Endpoint, "k")
	vecs, u, err := e.Documents(context.Background(), m, []Document{{Text: "uno due", Title: "T"}, {Text: "tre"}, {Text: "quattro"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(vecs) != 3 || len(vecs[0]) != 12 {
		t.Fatalf("vectors: %d of %d", len(vecs), len(vecs[0]))
	}
	var n float64
	for _, x := range vecs[0] {
		n += float64(x) * float64(x)
	}
	if math.Abs(n-1) > 1e-5 {
		t.Errorf("a cut vector has length %g", math.Sqrt(n))
	}
	// Batches of two, the template, the preset's body, and the price.
	fake.mu.Lock()
	reqs := fake.requests
	fake.mu.Unlock()
	if len(reqs) != 2 || reqs[0]["model"] != "bag-16" || reqs[0]["dimensions"] != nil {
		t.Fatalf("requests: %v", reqs)
	}
	if in := reqs[0]["input"].([]any); in[0] != "title: T | text: uno due" || in[1] != "title: none | text: tre" {
		t.Errorf("documents: %v", in)
	}
	if p, _ := reqs[0]["provider"].(map[string]any); p["data_collection"] != "deny" {
		t.Errorf("body: %v", reqs[0])
	}
	if u.Tokens == 0 || math.Abs(u.Cost-float64(u.Tokens)*2/1e6) > 1e-12 {
		t.Errorf("usage: %+v", u)
	}
	m.SendDimensions = true
	if _, _, err := e.Queries(context.Background(), m, []string{"x"}); err != nil {
		t.Fatal(err)
	}
	if fake.last()["dimensions"] != float64(12) || fake.last()["input"].([]any)[0] != "query: x" {
		t.Errorf("query: %v", fake.last())
	}
}

func TestEmbedder_RetriesAndRefusals(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch calls.Add(1) {
		case 1:
			w.Header().Set("Retry-After", "1")
			http.Error(w, "busy", http.StatusTooManyRequests)
		case 2:
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"index": 0, "embedding": []float64{1, 0, 0}}},
				"usage": map[string]any{"prompt_tokens": 3, "cost": 0.5}})
		default:
			http.Error(w, `{"error":"no such model"}`, http.StatusNotFound)
		}
	}))
	defer ts.Close()
	e := NewEmbedder(Endpoint{BaseURL: ts.URL, Timeout: Duration(time.Minute)}, "")
	m := Model{ID: "x", Name: "x", Dims: 3, Batch: 8, DocumentTemplate: "{text}"}
	_, u, err := e.Queries(context.Background(), m, []string{"a"})
	if err != nil || u.Cost != 0.5 || calls.Load() != 2 {
		t.Fatalf("after a 429: %+v %v (%d calls)", u, err, calls.Load())
	}
	if _, _, err := e.Queries(context.Background(), m, []string{"a"}); err == nil || !strings.Contains(err.Error(), "404") || calls.Load() != 3 {
		t.Errorf("a 404 is tried again or passes: %v (%d calls)", err, calls.Load())
	}
	m.Dims = 4
	calls.Store(1)
	if _, _, err := e.Queries(context.Background(), m, []string{"a"}); err == nil || !strings.Contains(err.Error(), "the preset says 4") {
		t.Errorf("a vector shorter than the preset's: %v", err)
	}
}

func TestConfig(t *testing.T) {
	good := func() *Config {
		return &Config{Endpoint: Endpoint{BaseURL: "http://ollama:11434/v1"}, Models: []Model{{ID: "m", Dims: 768, Dimensions: 512}},
			Store: StoreConfig{Kind: "postgres", URL: "postgres://u@db/x"}}
	}
	c := good()
	if err := c.check(); err != nil || c.DefaultModel != "m" || c.Models[0].Size() != 512 || c.Limits.MaxItems != 500 {
		t.Fatalf("%+v %v", c, err)
	}
	for why, change := range map[string]func(*Config){
		"base_url":   func(c *Config) { c.Endpoint.BaseURL = "ollama" },
		"no models":  func(c *Config) { c.Models = nil },
		"dims":       func(c *Config) { c.Models[0].Dims = 0 },
		"dimensions": func(c *Config) { c.Models[0].Dimensions = 1024 },
		"template":   func(c *Config) { c.Models[0].DocumentTemplate = "title: {title}" },
		"default":    func(c *Config) { c.DefaultModel = "other" },
		"kind":       func(c *Config) { c.Store.Kind = "mysql" },
		"pg url":     func(c *Config) { c.Store.URL = "http://db" },
		"twice":      func(c *Config) { c.Models = append(c.Models, c.Models[0]) },
	} {
		c := good()
		change(c)
		if err := c.check(); err == nil {
			t.Errorf("%s: accepted", why)
		}
	}
	env := func(kv ...string) func(string) string {
		m := map[string]string{}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return func(k string) string { return m[k] }
	}
	e, err := LoadEnv(env("DB_NAME", "vec-pg"))
	if err != nil || e.Query != QueryOff || e.QueryTimeout != 10*time.Second || e.QueryRows != 1000 || e.QueryConcurrency != 2 {
		t.Errorf("defaults: %+v %v", e, err)
	}
	for _, bad := range [][]string{{"DB_NAME", "memory"}, {"DB_NAME", "Vec"}, {"DB_NAME", "v", "DB_QUERY", "all"}, {"DB_NAME", "v", "DB_QUERY_ROWS", "0"}, {"DB_NAME", "v", "DB_QUERY_TIMEOUT", "10"}} {
		if _, err := LoadEnv(env(bad...)); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
}

// TestPresets reads the presets of the folder presets.
func TestPresets(t *testing.T) {
	files, _ := filepath.Glob("presets/*.yaml")
	if len(files) != 3 {
		t.Fatalf("presets: %v", files)
	}
	for _, f := range files {
		c, err := LoadConfig(f)
		if err != nil {
			t.Errorf("%s: %v", f, err)
			continue
		}
		for _, m := range c.Models {
			if m.Size() > 2000 && c.Store.Kind == "postgres" {
				t.Logf("%s: %s keeps %d numbers, as halfvec", f, m.Name, m.Size())
			}
		}
	}
}

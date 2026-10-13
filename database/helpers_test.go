package main

import (
	"encoding/json"
	"hash/fnv"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"unicode"
)

// fakeEndpoint is an embeddings API whose vectors are bags of words:
// texts that share words are similar. It keeps the requests it got.
type fakeEndpoint struct {
	*httptest.Server
	dims int

	mu       sync.Mutex
	requests []map[string]any
}

func newFakeEndpoint(t *testing.T, dims int) *fakeEndpoint {
	t.Helper()
	f := &fakeEndpoint{dims: dims}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.requests = append(f.requests, body)
		f.mu.Unlock()
		inputs, _ := body["input"].([]any)
		var data []any
		tokens := 0
		for i, in := range inputs {
			s, _ := in.(string)
			data = append(data, map[string]any{"index": i, "embedding": bagOfWords(s, f.dims)})
			tokens += len(strings.Fields(s))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "usage": map[string]any{"prompt_tokens": tokens}})
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeEndpoint) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		return nil
	}
	return f.requests[len(f.requests)-1]
}

// bagOfWords hashes each word of s, past its prefix (up to a ": "), into
// one of dims buckets.
func bagOfWords(s string, dims int) []float64 {
	if i := strings.LastIndex(s, ": "); i >= 0 {
		s = s[i+2:]
	}
	v := make([]float64, dims)
	v[0] = 0.01
	for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		h := fnv.New32a()
		h.Write([]byte(w))
		v[int(h.Sum32())%dims]++
	}
	return v
}

// testConfig is a preset on a fake endpoint, a model of 16 numbers cut to
// 12, and another of 8.
func testConfig(t *testing.T, base string, store StoreConfig) *Config {
	t.Helper()
	c := &Config{
		Endpoint: Endpoint{BaseURL: base + "/v1"},
		Models: []Model{
			{ID: "bag-16", Name: "bag", Dims: 16, Dimensions: 12, QueryPrefix: "query: ", DocumentTemplate: "title: {title} | text: {text}", Batch: 2},
			{ID: "bag-8", Dims: 8},
		},
		Store: store,
	}
	if err := c.check(); err != nil {
		t.Fatal(err)
	}
	return c
}

func sqliteExtension(t *testing.T) string {
	t.Helper()
	ext := os.Getenv("SQLITE_VEC")
	if ext == "" {
		t.Skip("SQLITE_VEC names sqlite-vec's vec0 (scripts/sqlite-vec.sh)")
	}
	return ext
}

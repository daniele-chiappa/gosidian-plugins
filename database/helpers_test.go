package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
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

// fakeReranker is a /rerank API that scores a document by the weights of
// the words it holds (-10 with none), in reverse order of the documents,
// with as many tokens as words. It keeps the requests it got.
type fakeReranker struct {
	*httptest.Server
	weights map[string]float64
	drop    bool // one score fewer than the documents

	mu       sync.Mutex
	requests []map[string]any
	auth     []string
}

func newFakeReranker(t *testing.T, weights map[string]float64) *fakeReranker {
	t.Helper()
	f := &fakeReranker{weights: weights}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rerank" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.requests = append(f.requests, body)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		drop := f.drop
		f.mu.Unlock()
		docs, _ := body["documents"].([]any)
		var results []any
		tokens := 0
		for i := len(docs) - 1; i >= 0; i-- {
			s, _ := docs[i].(string)
			score, found := 0.0, false
			for _, word := range strings.Fields(strings.ToLower(s)) {
				if wt, ok := f.weights[strings.Trim(word, ".,:")]; ok {
					score, found = score+wt, true
				}
			}
			if !found {
				score = -10
			}
			tokens += len(strings.Fields(s))
			results = append(results, map[string]any{"index": i, "relevance_score": score})
		}
		if drop && len(results) > 0 {
			results = results[1:]
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": body["model"], "results": results, "usage": map[string]any{"prompt_tokens": tokens}})
	}))
	t.Cleanup(f.Close)
	return f
}

// documents are the documents of every request, in order.
func (f *fakeReranker) documents() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.requests {
		for _, d := range r["documents"].([]any) {
			out = append(out, d.(string))
		}
	}
	return out
}

// withReranker gives the plugin a reranker on the fake, rr, with a sigmoid,
// two texts a request, and title and text in its template.
func withReranker(t *testing.T, p *Plugin, f *fakeReranker) {
	t.Helper()
	p.cfg.Rerankers = []Reranker{{ID: "fake-rr", Name: "rr", Endpoint: Endpoint{BaseURL: f.URL + "/v1"}, Sigmoid: true, Batch: 2, DocumentTemplate: "{title}: {text}"}}
	p.cfg.DefaultReranker = ""
	if err := p.cfg.checkRerankers(); err != nil {
		t.Fatal(err)
	}
	p.rank = NewRanker(p.cfg.Rerankers, func(string) string { return "" })
}

// closingServer answers the first request of each connection with body,
// keeping it open, and closes it on the next without an answer: what a
// server does when its keep-alive ends as a request comes in. It counts
// the requests it read.
func closingServer(t *testing.T, body string) (string, *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var n atomic.Int32
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				for i := 0; ; i++ {
					req, err := http.ReadRequest(br)
					if err != nil {
						return
					}
					_, _ = io.Copy(io.Discard, req.Body)
					n.Add(1)
					if i > 0 {
						return
					}
					fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
				}
			}(c)
		}
	}()
	return "http://" + ln.Addr().String(), &n
}

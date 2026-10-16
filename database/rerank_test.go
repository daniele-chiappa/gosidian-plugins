package main

import (
	"context"
	"math"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRanker(t *testing.T) {
	f := newFakeReranker(t, map[string]float64{"vaso": 4, "foglie": 1})
	m := Reranker{ID: "fake-rr", Name: "rr", Endpoint: Endpoint{BaseURL: f.URL + "/v1", APIKeyEnv: "RR_KEY", Body: map[string]any{"truncate": true}},
		Batch: 2, DocumentTemplate: "{title} | {text}", MaxChars: 14}
	m.Cost.Input = 1
	r := NewRanker([]Reranker{m}, func(k string) string { return map[string]string{"RR_KEY": "s3cret"}[k] })
	docs := []Document{{Text: "nessuna parola"}, {Text: "vaso", Title: "A"}, {Text: "foglie e vaso"}, {Text: "foglie"}, {Text: "un testo molto lungo con vaso alla fine"}}
	scores, u, err := r.Scores(context.Background(), m, "domanda", docs)
	if err != nil {
		t.Fatal(err)
	}
	// Raw scores in the documents' order, the last cut before its vaso.
	want := []float64{-10, 4, 5, 1, -10}
	for i := range want {
		if scores[i] != want[i] {
			t.Errorf("scores: %v, want %v", scores, want)
			break
		}
	}
	if len(f.requests) != 3 || f.requests[0]["truncate"] != true || f.requests[0]["query"] != "domanda" || f.requests[0]["model"] != "fake-rr" {
		t.Errorf("requests: %v", f.requests)
	}
	if got := f.documents(); got[1] != "A | vaso" || got[0] != " | nessuna parola" || got[4] != " | un testo molto" {
		t.Errorf("documents: %q", got)
	}
	if f.auth[0] != "Bearer s3cret" {
		t.Errorf("auth: %q", f.auth[0])
	}
	if u.RerankTokens == 0 || u.Tokens != 0 || math.Abs(u.Cost-float64(u.RerankTokens)/1e6) > 1e-15 {
		t.Errorf("usage: %+v", u)
	}
	m.Sigmoid = true
	scores, _, err = r.Scores(context.Background(), m, "domanda", docs[1:2])
	if err != nil || math.Abs(scores[0]-1/(1+math.Exp(-4))) > 1e-12 {
		t.Errorf("sigmoid: %v %v", scores, err)
	}
	f.drop = true
	if _, _, err := r.Scores(context.Background(), m, "domanda", docs[:2]); err == nil || !strings.Contains(err.Error(), "1 scores for 2 texts") {
		t.Errorf("a score fewer: %v", err)
	}
}

// TestRetriesClosedConnection: a request on a kept connection the server
// closes as it comes in goes again on a new one, to Qdrant and to an
// endpoint: every call of the plugin can be repeated.
func TestRetriesClosedConnection(t *testing.T) {
	base, n := closingServer(t, `{"result":{"ok":true},"status":"ok"}`)
	s := &qdrantStore{base: base, hc: &http.Client{Timeout: 5 * time.Second}}
	for i := 0; i < 3; i++ {
		var out map[string]any
		if err := s.do(context.Background(), "", http.MethodPost, "/collections/x/points/query", map[string]any{"limit": 1}, &out); err != nil || out["ok"] != true {
			t.Fatalf("qdrant, call %d: %v %v", i+1, err, out)
		}
	}
	if n.Load() < 4 {
		t.Errorf("the server read %d requests: none was closed", n.Load())
	}
	base, _ = closingServer(t, `{"results":[]}`)
	hc := &http.Client{Timeout: 5 * time.Second}
	for i := 0; i < 3; i++ {
		var out rerankResponse
		if err := postJSON(context.Background(), hc, base+"/v1/rerank", "", []byte(`{}`), &out); err != nil {
			t.Fatalf("endpoint, call %d: %v", i+1, err)
		}
	}
}

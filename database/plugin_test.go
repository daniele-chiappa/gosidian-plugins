package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
)

func callReq(project string, args map[string]any) mcp.CallToolRequest {
	var req mcp.CallToolRequest
	req.Params.Arguments = args
	if project != "" {
		req.Params.Meta = mcp.NewMetaFromMap(map[string]any{metaProject: project, metaCaller: "t1"})
	}
	return req
}

// call calls an operation of the plugin as gosidian would, and reads its
// structured result; an error result fails the test unless wantErr.
func call(t *testing.T, p *Plugin, op, project string, args map[string]any, wantErr string) map[string]any {
	t.Helper()
	for _, o := range p.operations() {
		if o.name != op {
			continue
		}
		res, err := p.handle(o)(context.Background(), callReq(project, args))
		if err != nil {
			t.Fatal(err)
		}
		text := ""
		for _, c := range res.Content {
			if tc, ok := mcp.AsTextContent(c); ok {
				text += tc.Text
			}
		}
		if wantErr != "" {
			if !res.IsError || !strings.Contains(text, wantErr) {
				t.Fatalf("%s: want an error with %q, got %v %s", op, wantErr, res.IsError, text)
			}
			return nil
		}
		if res.IsError {
			t.Fatalf("%s: %s", op, text)
		}
		var out map[string]any
		if err := json.Unmarshal([]byte(text), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	t.Fatalf("no operation %s", op)
	return nil
}

func testPlugin(t *testing.T, b backend, query string) (*Plugin, *fakeEndpoint) {
	t.Helper()
	fake := newFakeEndpoint(t, 16)
	cfg := testConfig(t, fake.URL, b.sc)
	b.env.Query, b.env.QueryRows, b.env.QueryBytes, b.env.QueryConcurrency = query, 1000, 1<<20, 2
	if b.env.QueryTimeout == 0 {
		b.env.QueryTimeout = 5e9
	}
	s, q := openBackend(t, b)
	return NewPlugin(cfg, b.env, s, NewEmbedder(cfg.Endpoint, ""), NewRanker(cfg.Rerankers, func(string) string { return "" }), q, slog.New(slog.NewTextHandler(io.Discard, nil))), fake
}

// TestManifest checks the manifest against gosidian's rules for nodes and
// tools (internal/plugins/manifest.go).
func TestManifest(t *testing.T) {
	p := &Plugin{cfg: &Config{Store: StoreConfig{Kind: "postgres", URL: "postgres://u@db:5432/x"}, Endpoint: Endpoint{BaseURL: "http://ollama:11434/v1"}},
		env: Env{Name: "vec-pg", Query: QueryRead}, query: &pgQuerier{}}
	m := p.Manifest()
	b, _ := json.Marshal(m)
	var man struct {
		Name  string `json:"name"`
		Nodes []struct {
			Name, Tool string
		} `json:"nodes"`
		Tools []struct {
			Name   string          `json:"name"`
			Access string          `json:"access"`
			Input  json.RawMessage `json:"input_schema"`
		} `json:"tools"`
		Permissions struct {
			Files   bool     `json:"files"`
			Network []string `json:"network"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(b, &man); err != nil {
		t.Fatal(err)
	}
	name := regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	access := map[string]string{}
	for _, tl := range man.Tools {
		access[tl.Name] = tl.Access
		var schema struct {
			Type       string                     `json:"type"`
			Properties map[string]json.RawMessage `json:"properties"`
		}
		_ = json.Unmarshal(tl.Input, &schema)
		if !name.MatchString(tl.Name) || len(man.Name)+1+len(tl.Name) > 48 || schema.Type != "object" || schema.Properties["project"] != nil {
			t.Errorf("tool %s breaks gosidian's rules: %s", tl.Name, tl.Input)
		}
	}
	want := map[string]string{"upsert": "write", "search": "read", "get": "read", "list": "read", "update": "write", "delete": "write", "collections": "read", "drop": "write", "copy": "write", "query": "read"}
	for n, a := range want {
		if access[n] != a {
			t.Errorf("tool %s: access %q, want %q", n, access[n], a)
		}
	}
	if len(man.Nodes) != len(want) || man.Permissions.Files || strings.Join(man.Permissions.Network, ",") != "ollama,db" {
		t.Errorf("manifest: %s", b)
	}
	if !strings.Contains(string(b), `"graphs":[{"description":"The chunks of a collection`) {
		t.Errorf("no graphs in the manifest: %s", b)
	}
	p.query = nil
	for _, o := range p.operations() {
		if o.name == "query" || o.name == "rerank" {
			t.Errorf("the %s tool is offered without its setting", o.name)
		}
	}
	// With a reranker, rerank is a tool and search takes rerank; its host
	// is called.
	p.cfg.Rerankers = []Reranker{{ID: "bge", Endpoint: Endpoint{BaseURL: "http://ai:8081/v1"}}}
	if err := p.cfg.checkRerankers(); err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(p.Manifest())
	if !strings.Contains(string(b), `"access":"read","description":"Order texts`) || !strings.Contains(string(b), `"rerank":{"description":"Order the candidates again with a reranker: true for the preset's (bge)`) ||
		!strings.Contains(string(b), `"network":["ollama","db","ai"]`) {
		t.Errorf("manifest with a reranker: %s", b)
	}
}

func TestPlugin(t *testing.T) {
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			p, fake := testPlugin(t, b, QueryOff)
			proj := uniq("rag")
			t.Cleanup(func() {
				for _, c := range []string{"procedure", "piccola"} {
					_ = p.store.Drop(context.Background(), proj, c)
				}
			})
			chunks := []any{}
			for _, ch := range procedures {
				chunks = append(chunks, map[string]any{"id": ch.ID, "text": ch.Text, "title": ch.Title, "doc": ch.Doc, "level": ch.Level, "parent": ch.Parent, "meta": ch.Meta})
			}
			call(t, p, "upsert", "", map[string]any{"collection": "procedure", "chunks": chunks}, "no gosidian/project")
			out := call(t, p, "upsert", proj, map[string]any{"collection": "procedure", "chunks": chunks}, "")
			if out["upserted"] != float64(4) || out["model"] != "bag" || out["dims"] != float64(12) {
				t.Fatalf("upsert: %v", out)
			}
			if u, _ := out["usage"].(map[string]any); u["embedding_tokens"] == nil || u["embedding_tokens"].(float64) <= 0 {
				t.Errorf("usage: %v", out["usage"])
			}
			// The model's template made the documents; its prefix makes the
			// questions.
			out = call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": "foglie ingialliscono annaffiare", "k": 2}, "")
			hits, _ := out["hits"].([]any)
			if len(hits) != 2 || hits[0].(map[string]any)["id"] != "orto-1" {
				t.Fatalf("search: %v", out)
			}
			if in := fake.last()["input"].([]any); in[0] != "query: foglie ingialliscono annaffiare" {
				t.Errorf("the question went as %q", in[0])
			}
			out = call(t, p, "search", proj, map[string]any{"collection": "procedure", "queries": []any{"impastare la farina", "coltivazione in vaso"}, "k": 1, "with_text": false}, "")
			res, _ := out["results"].([]any)
			if len(res) != 2 || res[0].([]any)[0].(map[string]any)["id"] != "pane-1" || res[1].([]any)[0].(map[string]any)["id"] != "orto-0" {
				t.Errorf("queries: %v", out)
			}
			out = call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": "foglie ingialliscono annaffiare", "min_score": 0.99}, "")
			if len(out["hits"].([]any)) != 0 {
				t.Errorf("min_score kept %v", out["hits"])
			}
			call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": "x", "filter": map[string]any{"color": "red"}}, "filter.color")
			call(t, p, "search", proj, map[string]any{"collection": "nessuna", "query": "x"}, "has no collection")
			call(t, p, "search", uniq("altro"), map[string]any{"collection": "procedure", "query": "x"}, "has no collection")
			call(t, p, "upsert", proj, map[string]any{"collection": "procedure", "model": "bag-8", "chunks": chunks}, "one model per collection")
			call(t, p, "upsert", proj, map[string]any{"collection": "Bad", "chunks": chunks}, "lower-case")
			call(t, p, "upsert", proj, map[string]any{"collection": "collections", "chunks": chunks}, "not collections")
			call(t, p, "upsert", proj, map[string]any{"collection": "piccola", "model": "nope", "chunks": chunks}, "no model of the preset")
			call(t, p, "upsert", proj, map[string]any{"collection": "piccola", "chunks": []any{map[string]any{"id": "a", "text": " "}}}, "no text")
			out = call(t, p, "upsert", proj, map[string]any{"collection": "piccola", "model": "bag-8", "chunks": chunks[:1]}, "")
			if out["dims"] != float64(8) {
				t.Errorf("a collection of the other model: %v", out)
			}
			out = call(t, p, "get", proj, map[string]any{"collection": "procedure", "ids": []any{"pane-1"}}, "")
			if got := out["chunks"].([]any); len(got) != 1 || got[0].(map[string]any)["parent"] != "pane-0" {
				t.Errorf("get: %v", out)
			}
			call(t, p, "delete", proj, map[string]any{"collection": "procedure"}, "needs ids or a filter")
			out = call(t, p, "delete", proj, map[string]any{"collection": "procedure", "filter": map[string]any{"doc": "guide/basilico.md"}}, "")
			if out["deleted"] != float64(2) {
				t.Errorf("delete: %v", out)
			}
			out = call(t, p, "collections", proj, map[string]any{}, "")
			if list := out["collections"].([]any); len(list) != 2 {
				t.Errorf("collections: %v", out)
			}
			out = call(t, p, "collections", proj, map[string]any{"name": "procedure"}, "")
			if c := out["collection"].(map[string]any); c["count"] != float64(2) || out["query_prefix"] != "query: " {
				t.Errorf("collection: %v", out)
			}
			out = call(t, p, "drop", proj, map[string]any{"collection": "piccola"}, "")
			if out["dropped"] != "piccola" {
				t.Errorf("drop: %v", out)
			}
		})
	}
}

// TestPlugin_Versions: an upsert keeps the embeddings of the chunks whose
// text and title are stored as they are; list pages a filter; update
// changes the meta in place.
func TestPlugin_Versions(t *testing.T) {
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			p, fake := testPlugin(t, b, QueryOff)
			proj := uniq("rag")
			t.Cleanup(func() { _ = p.store.Drop(context.Background(), proj, "pezzi") })
			chunks := []any{}
			for _, ch := range procedures {
				chunks = append(chunks, map[string]any{"id": ch.ID, "text": ch.Text, "title": ch.Title, "doc": ch.Doc, "level": ch.Level, "parent": ch.Parent, "meta": ch.Meta})
			}
			out := call(t, p, "upsert", proj, map[string]any{"collection": "pezzi", "chunks": chunks}, "")
			if out["embedded"] != float64(4) || out["kept"] != float64(0) {
				t.Fatalf("first upsert: %v", out)
			}
			requests := func() int { fake.mu.Lock(); defer fake.mu.Unlock(); return len(fake.requests) }
			before := requests()
			// The same chunks with other meta: no embedding, the meta written.
			again := []any{}
			for _, ch := range chunks {
				m := map[string]any{}
				for k, v := range ch.(map[string]any) {
					m[k] = v
				}
				m["meta"] = map[string]any{"status": "attivo", "dal": 100}
				again = append(again, m)
			}
			out = call(t, p, "upsert", proj, map[string]any{"collection": "pezzi", "chunks": again}, "")
			if out["embedded"] != float64(0) || out["kept"] != float64(4) || out["upserted"] != float64(4) || requests() != before {
				t.Errorf("the same chunks again: %v, %d requests", out, requests()-before)
			}
			if u := out["usage"].(map[string]any); u["embedding_tokens"] != float64(0) {
				t.Errorf("usage without embeddings: %v", u)
			}
			// One text changed, one title changed: those two are embedded.
			again[0].(map[string]any)["text"] = "Quando le foglie ingialliscono annaffiare meno"
			again[1].(map[string]any)["title"] = "Basilico in vaso"
			out = call(t, p, "upsert", proj, map[string]any{"collection": "pezzi", "chunks": again}, "")
			if out["embedded"] != float64(2) || out["kept"] != float64(2) {
				t.Errorf("two changed: %v", out)
			}
			out = call(t, p, "upsert", proj, map[string]any{"collection": "pezzi", "chunks": again, "reembed": true}, "")
			if out["embedded"] != float64(4) || out["kept"] != float64(0) {
				t.Errorf("reembed: %v", out)
			}
			out = call(t, p, "search", proj, map[string]any{"collection": "pezzi", "query": "foglie ingialliscono annaffiare", "k": 1,
				"filter": map[string]any{"meta": map[string]any{"dal": map[string]any{"lte": 150}, "status": "attivo"}}}, "")
			if hits := out["hits"].([]any); len(hits) != 1 || hits[0].(map[string]any)["id"] != "orto-1" {
				t.Errorf("search with operators: %v", out)
			}
			// list, a page of 3 then the last of 1.
			out = call(t, p, "list", proj, map[string]any{"collection": "pezzi", "limit": 3}, "")
			page, _ := out["chunks"].([]any)
			if len(page) != 3 || out["total"] != float64(4) || out["next"] == "" || page[0].(map[string]any)["text"] != nil {
				t.Fatalf("list: %v", out)
			}
			out = call(t, p, "list", proj, map[string]any{"collection": "pezzi", "limit": 3, "cursor": out["next"], "with_text": true}, "")
			if page, _ := out["chunks"].([]any); len(page) != 1 || out["next"] != "" || page[0].(map[string]any)["text"] == nil {
				t.Errorf("list, the last page: %v", out)
			}
			// The total comes with the first page only.
			if _, ok := out["total"]; ok {
				t.Errorf("list, a total on a page after the first: %v", out)
			}
			out = call(t, p, "list", proj, map[string]any{"collection": "pezzi", "filter": map[string]any{"doc": "guide/pane.md", "meta": map[string]any{"status": map[string]any{"ne": "superato"}}},
				"fields": []any{"id", "meta.dal", "meta.nope"}}, "")
			if out["total"] != float64(2) {
				t.Errorf("list with a filter: %v", out)
			}
			for _, ch := range out["chunks"].([]any) {
				if m := ch.(map[string]any); len(m) != 2 || m["id"] == nil || len(m["meta"].(map[string]any)) != 1 || m["meta"].(map[string]any)["dal"] != float64(100) {
					t.Errorf("list with fields: %v", m)
				}
			}
			call(t, p, "list", proj, map[string]any{"collection": "pezzi", "fields": []any{"vector"}}, "fields:")
			out = call(t, p, "update", proj, map[string]any{"collection": "pezzi", "filter": map[string]any{"doc": "guide/pane.md"}, "meta": map[string]any{"status": "superato", "al": 200, "dal": nil}}, "")
			if out["updated"] != float64(2) {
				t.Errorf("update: %v", out)
			}
			out = call(t, p, "get", proj, map[string]any{"collection": "pezzi", "ids": []any{"pane-1"}}, "")
			if ch := out["chunks"].([]any)[0].(map[string]any); ch["meta"].(map[string]any)["status"] != "superato" || ch["meta"].(map[string]any)["dal"] != nil || ch["text"] == nil {
				t.Errorf("after the update: %v", ch)
			}
			out = call(t, p, "update", proj, map[string]any{"collection": "pezzi", "ids": []any{"orto-0"}, "meta": map[string]any{"status": "superato"}}, "")
			if out["updated"] != float64(1) {
				t.Errorf("update by id: %v", out)
			}
			call(t, p, "update", proj, map[string]any{"collection": "pezzi", "meta": map[string]any{"a": 1}}, "needs ids or a filter")
			call(t, p, "update", proj, map[string]any{"collection": "pezzi", "ids": []any{"orto-0"}}, "meta: an object")
			call(t, p, "update", proj, map[string]any{"collection": "pezzi", "ids": []any{"orto-0"}, "meta": map[string]any{"a.b": 1}}, "the key")
			call(t, p, "list", proj, map[string]any{"collection": "pezzi", "limit": 100000}, "limit: 1 to")
			call(t, p, "list", proj, map[string]any{"collection": "pezzi", "filter": map[string]any{"meta": map[string]any{"dal": map[string]any{"near": 1}}}}, "the operator")
			call(t, p, "delete", proj, map[string]any{"collection": "pezzi", "filter": map[string]any{"meta": map[string]any{"status": map[string]any{"in": []any{"superato"}}}}}, "")
			if out = call(t, p, "list", proj, map[string]any{"collection": "pezzi"}, ""); out["total"] != float64(1) {
				t.Errorf("after deleting the superseded: %v", out)
			}
		})
	}
}

// TestPlugin_CopyVectors copies a collection with its embeddings: list with
// vectors, then upsert with them into another collection, which calls no
// model and searches as the first (the same numbers, one by one).
func TestPlugin_CopyVectors(t *testing.T) {
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			p, fake := testPlugin(t, b, QueryOff)
			proj := uniq("rag")
			t.Cleanup(func() {
				_ = p.store.Drop(context.Background(), proj, "pezzi")
				_ = p.store.Drop(context.Background(), proj, "copia")
			})
			chunks := []any{}
			for _, ch := range procedures {
				chunks = append(chunks, map[string]any{"id": ch.ID, "text": ch.Text, "title": ch.Title, "doc": ch.Doc, "level": ch.Level, "parent": ch.Parent, "meta": ch.Meta})
			}
			call(t, p, "upsert", proj, map[string]any{"collection": "pezzi", "chunks": chunks}, "")
			call(t, p, "list", proj, map[string]any{"collection": "pezzi", "vectors": true, "limit": 501}, "limit: 1 to 500 with vectors")

			src := call(t, p, "list", proj, map[string]any{"collection": "pezzi", "vectors": true, "with_text": true, "limit": 500}, "")
			page, _ := src["chunks"].([]any)
			if len(page) != 4 || src["dims"] != float64(12) || src["model"] != "bag" {
				t.Fatalf("list with vectors: %v", src)
			}
			want := map[string][]any{}
			for _, c := range page {
				ch := c.(map[string]any)
				v, _ := ch["vector"].([]any)
				if len(v) != 12 {
					t.Fatalf("%v: a vector of %d numbers", ch["id"], len(v))
				}
				want[ch["id"].(string)] = v
			}
			requests := func() int { fake.mu.Lock(); defer fake.mu.Unlock(); return len(fake.requests) }
			before := requests()
			out := call(t, p, "upsert", proj, map[string]any{"collection": "copia", "model": "bag", "chunks": page}, "")
			if out["given"] != float64(4) || out["embedded"] != float64(0) || requests() != before {
				t.Fatalf("upsert of the copy: %v, %d requests", out, requests()-before)
			}
			got := call(t, p, "list", proj, map[string]any{"collection": "copia", "vectors": true, "fields": []any{"id"}, "limit": 10}, "")
			for _, c := range got["chunks"].([]any) {
				ch := c.(map[string]any)
				v, w := ch["vector"].([]any), want[ch["id"].(string)]
				for i := range w {
					if v[i] != w[i] {
						t.Fatalf("%v: number %d is %v in the copy, %v in the original", ch["id"], i, v[i], w[i])
					}
				}
			}
			// The copy searches as the original: the same chunks, the same scores.
			found := func(coll string) string {
				out := call(t, p, "search", proj, map[string]any{"collection": coll, "query": "foglie ingialliscono annaffiare", "k": 2}, "")
				var s []string
				for _, h := range out["hits"].([]any) {
					s = append(s, fmt.Sprint(h.(map[string]any)["id"], " ", h.(map[string]any)["score"]))
				}
				return strings.Join(s, ", ")
			}
			if a, c := found("pezzi"), found("copia"); a != c {
				t.Errorf("search: %s in the original, %s in the copy", a, c)
			}

			// A vector of another size, of zeros: refused. One not of length 1
			// is made so.
			one := func(v []any) []any {
				return []any{map[string]any{"id": "x", "text": "una prova", "vector": v}}
			}
			call(t, p, "upsert", proj, map[string]any{"collection": "copia", "chunks": one([]any{1.0, 2.0})}, "a vector of 2 numbers, and the collection keeps 12")
			call(t, p, "upsert", proj, map[string]any{"collection": "copia", "chunks": one(make([]any, 12))}, "a vector of zeros")
			// Numbers whose squares underflow or overflow float64 would make a
			// vector of zeros: refused, as is a fingerprint list never gives.
			for _, x := range []float64{1e-200, 1e200} {
				v := make([]any, 12)
				for i := range v {
					v[i] = x
				}
				call(t, p, "upsert", proj, map[string]any{"collection": "copia", "chunks": one(v)}, "cannot be made length 1")
			}
			odd := one(page[0].(map[string]any)["vector"].([]any))
			odd[0].(map[string]any)["fingerprint"] = "not-a-fingerprint"
			call(t, p, "upsert", proj, map[string]any{"collection": "copia", "chunks": odd}, "is none list gives")
			long := make([]any, 12)
			for i := range long {
				long[i] = 3.0
			}
			call(t, p, "upsert", proj, map[string]any{"collection": "copia", "chunks": one(long)}, "")
			got = call(t, p, "list", proj, map[string]any{"collection": "copia", "vectors": true, "limit": 10}, "")
			var norm float64
			for _, c := range got["chunks"].([]any) {
				if c.(map[string]any)["id"] != "x" {
					continue
				}
				for _, x := range c.(map[string]any)["vector"].([]any) {
					norm += x.(float64) * x.(float64)
				}
			}
			if math.Abs(norm-1) > 1e-4 {
				t.Errorf("a given vector of length %v, want 1", math.Sqrt(norm))
			}
		})
	}
}

// TestPlugin_ListFits lists chunks that do not fit in one result: a page
// is cut short, and next goes on from the first chunk left out, so every
// chunk comes once.
func TestPlugin_ListFits(t *testing.T) {
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			p, _ := testPlugin(t, b, QueryOff)
			proj := uniq("rag")
			t.Cleanup(func() { _ = p.store.Drop(context.Background(), proj, "lunghi") })
			long := strings.Repeat("parola ", 4300) // about 30,000 characters
			var chunks []any
			for i := range 40 {
				chunks = append(chunks, map[string]any{"id": fmt.Sprintf("p%02d", i), "text": fmt.Sprintf("pezzo %d %s", i, long)})
			}
			for i := 0; i < len(chunks); i += 10 {
				call(t, p, "upsert", proj, map[string]any{"collection": "lunghi", "chunks": chunks[i : i+10]}, "")
			}
			seen, pages, cursor := map[string]int{}, 0, ""
			for {
				args := map[string]any{"collection": "lunghi", "with_text": true, "limit": 100}
				if cursor != "" {
					args["cursor"] = cursor
				}
				out := call(t, p, "list", proj, args, "")
				pages++
				page := out["chunks"].([]any)
				if out["count"] != float64(len(page)) || len(page) == 0 || len(page) == 40 {
					t.Fatalf("page %d: %d chunks, count %v", pages, len(page), out["count"])
				}
				for _, c := range page {
					seen[c.(map[string]any)["id"].(string)]++
				}
				if cursor, _ = out["next"].(string); cursor == "" {
					break
				}
			}
			if len(seen) != 40 || pages < 2 {
				t.Fatalf("%d chunks in %d pages: %v", len(seen), pages, seen)
			}
			for id, n := range seen {
				if n != 1 {
					t.Errorf("%s came %d times", id, n)
				}
			}
		})
	}
}

// TestPlugin_SearchExact asks for the exact search, which finds the
// chunks a brute force over the stored vectors finds, with their scores.
func TestPlugin_SearchExact(t *testing.T) {
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			p, _ := testPlugin(t, b, QueryOff)
			proj := uniq("rag")
			t.Cleanup(func() { _ = p.store.Drop(context.Background(), proj, "pezzi") })
			chunks := []any{}
			for _, ch := range procedures {
				chunks = append(chunks, map[string]any{"id": ch.ID, "text": ch.Text, "doc": ch.Doc, "meta": ch.Meta})
			}
			call(t, p, "upsert", proj, map[string]any{"collection": "pezzi", "chunks": chunks}, "")
			stored := call(t, p, "list", proj, map[string]any{"collection": "pezzi", "vectors": true, "fields": []any{"id"}}, "")
			const text = "pane farina lievito basilico"
			// The question's vector as the plugin makes it: the bag of 16
			// words cut to 12 and made length 1.
			bag := bagOfWords(text, 16)[:12]
			qv := normalize(bag)
			type scored struct {
				id    string
				score float64
			}
			var want []scored
			for _, c := range stored["chunks"].([]any) {
				ch := c.(map[string]any)
				var dot float64
				for i, x := range ch["vector"].([]any) {
					dot += x.(float64) * float64(qv[i])
				}
				want = append(want, scored{ch["id"].(string), dot})
			}
			sort.Slice(want, func(a, b int) bool { return want[a].score > want[b].score })
			out := call(t, p, "search", proj, map[string]any{"collection": "pezzi", "query": text, "k": 4, "exact": true, "with_text": false}, "")
			if out["exact"] != true {
				t.Errorf("the result does not say exact: %v", out)
			}
			if ms, _ := out["ms"].(map[string]any); ms == nil || ms["embed"] == nil || ms["search"] == nil {
				t.Errorf("no times of the model and the store: %v", out["ms"])
			}
			for r, h := range out["hits"].([]any) {
				hit := h.(map[string]any)
				if hit["id"] != want[r].id || math.Abs(hit["score"].(float64)-want[r].score) > 1e-4 {
					t.Errorf("rank %d: %v %v, the brute force %s %v", r+1, hit["id"], hit["score"], want[r].id, want[r].score)
				}
			}
		})
	}
}

// TestPlugin_Copy copies the chunks of a filter into another collection of
// the same archive, with their vectors, and searches there as in the
// original; ef widens a search.
func TestPlugin_Copy(t *testing.T) {
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			p, fake := testPlugin(t, b, QueryOff)
			proj := uniq("rag")
			t.Cleanup(func() {
				for _, c := range []string{"pezzi", "foglie", "piccola"} {
					_ = p.store.Drop(context.Background(), proj, c)
				}
			})
			chunks := []any{}
			for _, ch := range procedures {
				chunks = append(chunks, map[string]any{"id": ch.ID, "text": ch.Text, "doc": ch.Doc, "level": ch.Level, "parent": ch.Parent, "meta": ch.Meta})
			}
			call(t, p, "upsert", proj, map[string]any{"collection": "pezzi", "chunks": chunks}, "")
			requests := func() int { fake.mu.Lock(); defer fake.mu.Unlock(); return len(fake.requests) }
			before := requests()
			out := call(t, p, "copy", proj, map[string]any{"collection": "pezzi", "to": "foglie", "filter": map[string]any{"level": float64(1)}}, "")
			if out["copied"] != float64(2) || out["dims"] != float64(12) || requests() != before {
				t.Fatalf("copy: %v, %d requests", out, requests()-before)
			}
			vectors := func(coll string) map[string]string {
				got := map[string]string{}
				for _, c := range call(t, p, "list", proj, map[string]any{"collection": coll, "vectors": true, "fields": []any{"id"}}, "")["chunks"].([]any) {
					got[c.(map[string]any)["id"].(string)] = fmt.Sprint(c.(map[string]any)["vector"])
				}
				return got
			}
			orig, copied := vectors("pezzi"), vectors("foglie")
			if len(copied) != 2 {
				t.Fatalf("the copy holds %v", copied)
			}
			for id, v := range copied {
				if orig[id] != v {
					t.Errorf("%s: another vector in the copy", id)
				}
			}
			found := func(coll string, filter map[string]any) string {
				q := map[string]any{"collection": coll, "query": "foglie basilico pane", "k": 2, "ef": 200, "with_text": false}
				if filter != nil {
					q["filter"] = filter
				}
				var s []string
				for _, h := range call(t, p, "search", proj, q, "")["hits"].([]any) {
					s = append(s, fmt.Sprint(h.(map[string]any)["id"], " ", h.(map[string]any)["score"]))
				}
				return strings.Join(s, ", ")
			}
			if a, c := found("pezzi", map[string]any{"level": float64(1)}), found("foglie", nil); a != c {
				t.Errorf("search: %s in the original, %s in the copy", a, c)
			}
			call(t, p, "search", proj, map[string]any{"collection": "pezzi", "query": "pane", "ef": 2000}, "ef: 1 to 1000")
			call(t, p, "copy", proj, map[string]any{"collection": "pezzi", "to": "pezzi"}, "another collection")
			call(t, p, "upsert", proj, map[string]any{"collection": "piccola", "model": "bag-8", "chunks": []any{map[string]any{"id": "x", "text": "pane"}}}, "")
			call(t, p, "copy", proj, map[string]any{"collection": "pezzi", "to": "piccola"}, "a copy keeps the model and the size")
		})
	}
}

// TestPlugin_Fingerprint: an upsert keeps a stored embedding only under
// the preset's definition of the model that made it. The installer gives
// the model another template under the same name: the same chunks are
// embedded again, not left beside vectors of the new one. A copy, in the
// archive or through list and upsert, keeps the fingerprint with the
// vector; a vector given without it is embedded again on its next upsert.
func TestPlugin_Fingerprint(t *testing.T) {
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			p, fake := testPlugin(t, b, QueryOff)
			proj := uniq("rag")
			t.Cleanup(func() {
				for _, c := range []string{"pezzi", "copia", "altra"} {
					_ = p.store.Drop(context.Background(), proj, c)
				}
			})
			chunks := []any{}
			for _, ch := range procedures {
				chunks = append(chunks, map[string]any{"id": ch.ID, "text": ch.Text, "title": ch.Title, "doc": ch.Doc, "meta": ch.Meta})
			}
			upsert := func(coll string, want int) {
				t.Helper()
				out := call(t, p, "upsert", proj, map[string]any{"collection": coll, "chunks": chunks}, "")
				if out["embedded"] != float64(want) || out["kept"] != float64(len(chunks)-want) {
					t.Errorf("upsert into %s: %v, want %d embedded", coll, out, want)
				}
			}
			upsert("pezzi", 4)
			upsert("pezzi", 0)
			// The query prefix makes the questions, not what is stored.
			p.cfg.Models[0].QueryPrefix = "domanda: "
			upsert("pezzi", 0)
			p.cfg.Models[0].DocumentTemplate = "passage: {title}. {text}"
			upsert("pezzi", 4)
			if in := fake.last()["input"].([]any); !strings.HasPrefix(in[0].(string), "passage: ") {
				t.Errorf("the new template made %q", in[0])
			}
			upsert("pezzi", 0)

			call(t, p, "copy", proj, map[string]any{"collection": "pezzi", "to": "copia"}, "")
			upsert("copia", 0)

			page := call(t, p, "list", proj, map[string]any{"collection": "pezzi", "vectors": true, "with_text": true}, "")["chunks"].([]any)
			for _, c := range page {
				if fp, _ := c.(map[string]any)["fingerprint"].(string); !fingerprintFormat.MatchString(fp) {
					t.Fatalf("list with vectors, a fingerprint %q", fp)
				}
			}
			call(t, p, "upsert", proj, map[string]any{"collection": "altra", "model": "bag", "chunks": page}, "")
			upsert("altra", 0)
			delete(page[0].(map[string]any), "fingerprint")
			call(t, p, "upsert", proj, map[string]any{"collection": "altra", "chunks": page[:1]}, "")
			upsert("altra", 1)
		})
	}
}

// TestPlugin_Rerank: a search with rerank reads the cosine's candidates
// again and keeps the reranker's first k; rerank orders texts, objects and
// stored chunks.
func TestPlugin_Rerank(t *testing.T) {
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			p, _ := testPlugin(t, b, QueryOff)
			proj := uniq("rag")
			t.Cleanup(func() { _ = p.store.Drop(context.Background(), proj, "procedure") })
			chunks := []any{}
			for _, ch := range procedures {
				chunks = append(chunks, map[string]any{"id": ch.ID, "text": ch.Text, "title": ch.Title, "doc": ch.Doc, "meta": ch.Meta})
			}
			call(t, p, "upsert", proj, map[string]any{"collection": "procedure", "chunks": chunks}, "")
			call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": "x", "rerank": true}, "no rerankers")
			f := newFakeReranker(t, map[string]float64{"vaso": 4, "foglie": 1})
			withReranker(t, p, f)

			// The cosine puts the leaves first, the reranker the pot.
			const q = "foglie ingialliscono annaffiare"
			out := call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": q, "k": 1}, "")
			if h := out["hits"].([]any); h[0].(map[string]any)["id"] != "orto-1" || h[0].(map[string]any)["rerank_score"] != nil {
				t.Fatalf("without rerank: %v", out)
			}
			out = call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": q, "k": 2, "rerank": true, "candidates": 4}, "")
			hits := out["hits"].([]any)
			first := hits[0].(map[string]any)
			if len(hits) != 2 || first["id"] != "orto-0" || hits[1].(map[string]any)["id"] != "orto-1" || first["text"] == "" {
				t.Fatalf("with rerank: %v", out)
			}
			if s := first["rerank_score"].(float64); math.Abs(s-1/(1+math.Exp(-4))) > 1e-9 || first["score"] == nil {
				t.Errorf("scores: %v", first)
			}
			if out["reranker"] != "rr" || out["candidates"] != float64(4) || out["ms"].(map[string]any)["rerank"] == nil {
				t.Errorf("reranker, candidates, ms: %v", out)
			}
			if u := out["usage"].(map[string]any); u["rerank_tokens"].(float64) <= 0 || u["embedding_tokens"].(float64) <= 0 {
				t.Errorf("usage: %v", u)
			}
			docs := f.documents()
			if len(docs) != 4 || !strings.HasPrefix(docs[0], "Basilico: ") {
				t.Errorf("the reranker read %q", docs)
			}
			// Without text in the result, the reranker reads it all the same.
			out = call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": q, "k": 1, "rerank": "rr", "candidates": 4, "with_text": false}, "")
			if h := out["hits"].([]any)[0].(map[string]any); h["id"] != "orto-0" || h["text"] != nil {
				t.Errorf("without text: %v", h)
			}
			if d := f.documents(); strings.HasSuffix(d[len(d)-1], ": ") {
				t.Errorf("the reranker read no text: %q", d)
			}
			out = call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": q, "k": 2, "rerank": true, "candidates": 4, "min_rerank_score": 0.99}, "")
			if len(out["hits"].([]any)) != 0 {
				t.Errorf("min_rerank_score kept %v", out["hits"])
			}
			out = call(t, p, "search", proj, map[string]any{"collection": "procedure", "queries": []any{q, "pane farina"}, "k": 1, "rerank": true}, "")
			res := out["results"].([]any)
			if res[0].([]any)[0].(map[string]any)["id"] != "orto-0" || len(res[1].([]any)) != 1 || out["candidates"] != float64(50) {
				t.Errorf("queries: %v", out)
			}
			call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": q, "k": 5, "rerank": true, "candidates": 3}, "candidates: k (5) to 200")
			call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": q, "rerank": true, "candidates": 201}, "candidates")
			call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": q, "rerank": "nope"}, "no reranker of the preset")
			call(t, p, "search", proj, map[string]any{"collection": "procedure", "query": q, "rerank": 3}, "rerank: true")

			out = call(t, p, "rerank", proj, map[string]any{"query": q, "texts": []any{"un vaso", "niente", "foglie nel vaso"}, "k": 2}, "")
			hits = out["hits"].([]any)
			if len(hits) != 2 || hits[0].(map[string]any)["index"] != float64(2) || hits[1].(map[string]any)["index"] != float64(0) || out["reranker"] != "rr" {
				t.Errorf("texts: %v", out)
			}
			out = call(t, p, "rerank", proj, map[string]any{"query": q, "items": []any{
				map[string]any{"id": "a", "text": "niente", "source": "bm25"},
				map[string]any{"id": "b", "text": "foglie", "title": "vaso"}}, "min_score": 0.5}, "")
			if hits = out["hits"].([]any); len(hits) != 1 || hits[0].(map[string]any)["id"] != "b" || hits[0].(map[string]any)["rerank_score"] == nil {
				t.Errorf("items: %v", out)
			}
			out = call(t, p, "rerank", proj, map[string]any{"query": q, "items": []any{map[string]any{"id": "a", "text": "niente", "source": "bm25"}}}, "")
			if h := out["hits"].([]any)[0].(map[string]any); h["source"] != "bm25" {
				t.Errorf("an item comes back whole: %v", h)
			}
			out = call(t, p, "rerank", proj, map[string]any{"query": q, "collection": "procedure", "ids": []any{"pane-0", "orto-0", "orto-1"}}, "")
			if hits = out["hits"].([]any); len(hits) != 3 || hits[0].(map[string]any)["id"] != "orto-0" || hits[0].(map[string]any)["doc"] != "guide/basilico.md" {
				t.Errorf("ids: %v", out)
			}
			call(t, p, "rerank", proj, map[string]any{"query": q}, "one of texts")
			call(t, p, "rerank", proj, map[string]any{"query": q, "texts": []any{"a"}, "items": []any{map[string]any{"text": "b"}}}, "one of texts")
			call(t, p, "rerank", proj, map[string]any{"query": q, "items": []any{map[string]any{"id": "a"}}}, "items[0]: no text")
			call(t, p, "rerank", proj, map[string]any{"query": " ", "texts": []any{"a"}}, "query")
			call(t, p, "rerank", proj, map[string]any{"query": q, "texts": []any{"a"}, "model": "nope"}, "no reranker")
			many := make([]any, 201)
			for i := range many {
				many[i] = "x"
			}
			call(t, p, "rerank", proj, map[string]any{"query": q, "texts": many}, "at most 200")
			out = call(t, p, "collections", proj, map[string]any{}, "")
			if out["rerankers"] != "rr" || out["default_reranker"] != "rr" {
				t.Errorf("collections: %v", out)
			}
		})
	}
}

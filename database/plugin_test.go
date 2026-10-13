package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"regexp"
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
	return NewPlugin(cfg, b.env, s, NewEmbedder(cfg.Endpoint, ""), q, slog.New(slog.NewTextHandler(io.Discard, nil))), fake
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
	want := map[string]string{"upsert": "write", "search": "read", "get": "read", "delete": "write", "collections": "read", "drop": "write", "query": "read"}
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
		if o.name == "query" {
			t.Error("the query tool is offered with DB_QUERY off")
		}
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

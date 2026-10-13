package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
)

// backend is a store the tests run on: SQLite when SQLITE_VEC names
// sqlite-vec, PostgreSQL with PG_URL, Qdrant with QDRANT_URL.
type backend struct {
	name string
	sc   StoreConfig
	env  Env
}

func backends(t *testing.T) []backend {
	t.Helper()
	var out []backend
	if ext := os.Getenv("SQLITE_VEC"); ext != "" {
		out = append(out, backend{"sqlite", StoreConfig{Kind: "sqlite", Path: t.TempDir(), Extension: ext}, Env{Name: "vec-sqlite"}})
	}
	if u := os.Getenv("PG_URL"); u != "" {
		out = append(out, backend{"postgres", StoreConfig{Kind: "postgres", URL: u}, Env{Name: "vec-pg"}})
	}
	if u := os.Getenv("QDRANT_URL"); u != "" {
		out = append(out, backend{"qdrant", StoreConfig{Kind: "qdrant", URL: u}, Env{Name: "vec-qdrant"}})
	}
	if len(out) == 0 {
		t.Skip("no store: SQLITE_VEC, PG_URL or QDRANT_URL")
	}
	return out
}

// uniq is a project name of its own for a run, so that runs on the same
// database do not meet.
func uniq(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return prefix + "-" + hex.EncodeToString(b)
}

func openBackend(t *testing.T, b backend) (Store, Querier) {
	t.Helper()
	ctx := context.Background()
	s, q, err := Open(ctx, b.sc, b.env)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if q != nil {
			q.Close()
		}
		s.Close()
	})
	return s, q
}

var procedures = []Chunk{
	{ID: "orto-1", Title: "Basilico", Text: "Quando le foglie ingialliscono annaffiare il basilico la mattina presto", Doc: "guide/basilico.md", Level: 1, Meta: map[string]any{"rev": "02", "plant": "basilico"}},
	{ID: "orto-0", Title: "Basilico", Text: "Guida alla coltivazione del basilico in vaso sul balcone", Doc: "guide/basilico.md", Level: 0, Meta: map[string]any{"rev": "02"}},
	{ID: "pane-1", Title: "Pane", Text: "Impastare la farina con il lievito per dieci minuti a mano", Doc: "guide/pane.md", Level: 1, Parent: "pane-0", Meta: map[string]any{"rev": "03", "oven": false}},
	{ID: "pane-0", Title: "Pane", Text: "Guida alla preparazione del pane in casa", Doc: "guide/pane.md", Level: 0, Meta: map[string]any{"rev": "03", "oven": false}},
}

func embedAll(t *testing.T, e *Embedder, m Model, chunks []Chunk) []Chunk {
	t.Helper()
	docs := make([]Document, len(chunks))
	for i, ch := range chunks {
		docs[i] = Document{Text: ch.Text, Title: ch.Title}
	}
	vecs, _, err := e.Documents(context.Background(), m, docs)
	if err != nil {
		t.Fatal(err)
	}
	out := append([]Chunk(nil), chunks...)
	for i := range out {
		out[i].Vector = vecs[i]
	}
	return out
}

func TestStore(t *testing.T) {
	fake := newFakeEndpoint(t, 16)
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			ctx := context.Background()
			s, _ := openBackend(t, b)
			cfg := testConfig(t, fake.URL, b.sc)
			m, _ := cfg.Model("bag")
			e := NewEmbedder(cfg.Endpoint, "")
			pa, pb := uniq("progetto a"), uniq("progetto b")
			c := Collection{Name: "procedure", Model: m.Name, Dims: m.Size()}
			if err := s.Create(ctx, pa, c); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = s.Drop(context.Background(), pa, c.Name) })
			if err := s.Upsert(ctx, pa, c, embedAll(t, e, m, procedures)); err != nil {
				t.Fatal(err)
			}
			got, ok, err := s.Collection(ctx, pa, "procedure")
			if err != nil || !ok || got.Count != 4 || got.Dims != 12 || got.Model != "bag" {
				t.Fatalf("collection: %+v %v %v", got, ok, err)
			}
			if _, ok, _ := s.Collection(ctx, pb, "procedure"); ok {
				t.Fatal("another project sees the collection")
			}

			search := func(q string, f Filter, k int) []Hit {
				t.Helper()
				vecs, _, err := e.Queries(ctx, m, []string{q})
				if err != nil {
					t.Fatal(err)
				}
				res, err := s.Search(ctx, pa, c, vecs, k, f, true)
				if err != nil {
					t.Fatal(err)
				}
				return res[0]
			}
			hits := search("foglie ingialliscono annaffiare", Filter{}, 2)
			if len(hits) != 2 || hits[0].ID != "orto-1" || hits[0].Score <= hits[1].Score || hits[0].Score > 1.0001 {
				t.Fatalf("search: %+v", hits)
			}
			if h := hits[0]; h.Doc != "guide/basilico.md" || h.Level != 1 || h.Meta["plant"] != "basilico" || !strings.Contains(h.Text, "foglie") || h.Title != "Basilico" {
				t.Errorf("hit: %+v", h)
			}
			for name, f := range map[string]Filter{
				"doc":   {Docs: []string{"guide/pane.md"}},
				"level": {Levels: []int{1}, Meta: map[string]any{"rev": "03"}},
				"meta":  {Meta: map[string]any{"oven": false}},
				"both":  {Docs: []string{"guide/pane.md"}, Parents: []string{"pane-0"}},
			} {
				hits := search("foglie ingialliscono annaffiare", f, 4)
				for _, h := range hits {
					if h.Doc != "guide/pane.md" {
						t.Errorf("filter %s let %s through", name, h.ID)
					}
				}
				if len(hits) == 0 {
					t.Errorf("filter %s found nothing", name)
				}
			}
			// Without text, and the same chunk again replaces it.
			vecs, _, _ := e.Queries(ctx, m, []string{"impastare la farina"})
			res, err := s.Search(ctx, pa, c, vecs, 1, Filter{}, false)
			if err != nil || len(res[0]) != 1 || res[0][0].ID != "pane-1" || res[0][0].Text != "" {
				t.Errorf("search without text: %+v %v", res, err)
			}
			again := procedures[2]
			again.Text = "Impastare la farina con acqua tiepida"
			if err := s.Upsert(ctx, pa, c, embedAll(t, e, m, []Chunk{again})); err != nil {
				t.Fatal(err)
			}
			chunks, err := s.Get(ctx, pa, c, []string{"pane-1", "nope"})
			if err != nil || len(chunks) != 1 || chunks[0].Text != "Impastare la farina con acqua tiepida" || chunks[0].Parent != "pane-0" {
				t.Errorf("get: %+v %v", chunks, err)
			}
			// The same collection in another project is another one.
			if err := s.Create(ctx, pb, c); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = s.Drop(context.Background(), pb, c.Name) })
			if err := s.Upsert(ctx, pb, c, embedAll(t, e, m, procedures[:1])); err != nil {
				t.Fatal(err)
			}
			if got, _, _ := s.Collection(ctx, pa, c.Name); got.Count != 4 {
				t.Errorf("project a has %d chunks after b's upsert", got.Count)
			}
			n, err := s.Delete(ctx, pa, c, nil, Filter{Docs: []string{"guide/pane.md"}, Levels: []int{0}})
			if err != nil || n != 1 {
				t.Errorf("delete by filter: %d %v", n, err)
			}
			n, err = s.Delete(ctx, pa, c, []string{"orto-0", "nope"}, Filter{})
			if err != nil || n != 1 {
				t.Errorf("delete by id: %d %v", n, err)
			}
			list, err := s.Collections(ctx, pa)
			if err != nil || len(list) != 1 || list[0].Count != 2 {
				t.Errorf("collections: %+v %v", list, err)
			}
			if err := s.Drop(ctx, pa, c.Name); err != nil {
				t.Fatal(err)
			}
			if _, ok, _ := s.Collection(ctx, pa, c.Name); ok {
				t.Error("dropped, and still there")
			}
			if got, _, _ := s.Collection(ctx, pb, c.Name); got.Count != 1 {
				t.Errorf("project b lost its chunks: %+v", got)
			}
		})
	}
}

// TestStore_BigVectors: halfvec above 2000 dimensions, and the binary
// index with the reranking above 4000, in PostgreSQL; the others take
// them as they are.
func TestStore_BigVectors(t *testing.T) {
	for _, dims := range []int{2560, 4096} {
		fake := newFakeEndpoint(t, dims)
		for _, b := range backends(t) {
			t.Run(b.name, func(t *testing.T) {
				ctx := context.Background()
				s, _ := openBackend(t, b)
				cfg := testConfig(t, fake.URL, b.sc)
				m := Model{ID: "big", Name: "big", Dims: dims, Batch: 8, DocumentTemplate: "{text}"}
				e := NewEmbedder(cfg.Endpoint, "")
				p := uniq("big")
				c := Collection{Name: "big", Model: "big", Dims: dims}
				if err := s.Create(ctx, p, c); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = s.Drop(context.Background(), p, c.Name) })
				if err := s.Upsert(ctx, p, c, embedAll(t, e, m, procedures)); err != nil {
					t.Fatal(err)
				}
				vecs, _, _ := e.Queries(ctx, m, []string{"foglie ingialliscono annaffiare"})
				res, err := s.Search(ctx, p, c, vecs, 1, Filter{}, false)
				if err != nil || len(res[0]) != 1 || res[0][0].ID != "orto-1" {
					t.Errorf("%d dimensions: %+v %v", dims, res, err)
				}
			})
		}
	}
}

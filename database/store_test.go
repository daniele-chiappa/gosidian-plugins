package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
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
				res, err := s.Search(ctx, pa, c, vecs, k, f, SearchOptions{WithText: true})
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
			res, err := s.Search(ctx, pa, c, vecs, 1, Filter{}, SearchOptions{})
			if err != nil || len(res[0]) != 1 || res[0][0].ID != "pane-1" || res[0][0].Text != "" {
				t.Errorf("search without text: %+v %v", res, err)
			}
			// A k over 500, a max_k an installer may set: Postgres's default
			// breadth 2k stays within the 1000 pgvector takes, as does an
			// explicit one over it.
			for _, ef := range []int{0, 5000} {
				res, err = s.Search(ctx, pa, c, vecs, 600, Filter{}, SearchOptions{EF: ef})
				if err != nil || len(res[0]) != 4 {
					t.Errorf("search with k 600, ef %d: %+v %v", ef, res, err)
				}
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
				res, err := s.Search(ctx, p, c, vecs, 1, Filter{}, SearchOptions{})
				if err != nil || len(res[0]) != 1 || res[0][0].ID != "orto-1" {
					t.Errorf("%d dimensions: %+v %v", dims, res, err)
				}
			})
		}
	}
}

func TestParseFilter(t *testing.T) {
	f, err := parseFilter(map[string]any{"doc": "a.md", "meta": map[string]any{
		"status": "attivo",
		"dal":    map[string]any{"lte": float64(100)},
		"al":     map[string]any{"gt": float64(100)},
		"kind":   map[string]any{"in": []any{"a", "b"}, "ne": "c"},
		"rev":    map[string]any{"eq": "02"},
	}}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if f.Meta["status"] != "attivo" || f.Meta["rev"] != "02" || len(f.Meta) != 2 || f.empty() {
		t.Errorf("meta: %+v", f.Meta)
	}
	want := []MetaCond{{"al", "gt", float64(100)}, {"dal", "lte", float64(100)}, {"kind", "in", []any{"a", "b"}}, {"kind", "ne", "c"}}
	if len(f.Conds) != len(want) {
		t.Fatalf("conds: %+v", f.Conds)
	}
	for i, c := range want {
		if got := f.Conds[i]; got.Key != c.Key || got.Op != c.Op {
			t.Errorf("cond %d: %+v, want %+v", i, got, c)
		}
	}
	if f, _ := parseFilter(map[string]any{"meta": map[string]any{"al": map[string]any{"gt": float64(1)}}}, 1000); f.empty() {
		t.Error("a filter of operators only is empty")
	}
	for name, meta := range map[string]map[string]any{
		"operator":  {"a": map[string]any{"like": "x"}},
		"range":     {"a": map[string]any{"gte": "2026"}},
		"in empty":  {"a": map[string]any{"in": []any{}}},
		"in object": {"a": map[string]any{"in": []any{map[string]any{}}}},
		"key":       {"a.b": map[string]any{"ne": "x"}},
		"list":      {"a": []any{"x"}},
		"no ops":    {"a": map[string]any{}},
	} {
		if _, err := parseFilter(map[string]any{"meta": meta}, 1000); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	if f, err := parseFilter(map[string]any{"meta": map[string]any{"a": map[string]any{"eq": "x", "ne": "y"}}}, 1000); err != nil || f.Meta["a"] != "x" || len(f.Conds) != 1 {
		t.Errorf("eq and ne on a key: %+v %v", f, err)
	}
	// The caps of limits: the values of an in, the keys and bytes of an
	// update.
	if _, err := parseFilter(map[string]any{"meta": map[string]any{"kind": map[string]any{"in": []any{"a", "b", "c"}}}}, 2); err == nil || !strings.Contains(err.Error(), "limits.max_in") {
		t.Errorf("an in over max_in: %v", err)
	}
	lim := Limits{MaxMeta: 32, MaxUpdateKeys: 2}
	if _, err := parseMetaUpdate(map[string]any{"a.b": "x"}, lim); err == nil {
		t.Error("an update of a key with a dot")
	}
	if _, err := parseMetaUpdate(map[string]any{}, lim); err == nil {
		t.Error("an empty update")
	}
	if _, err := parseMetaUpdate(map[string]any{"a": 1, "b": 2, "c": 3}, lim); err == nil || !strings.Contains(err.Error(), "limits.max_update_keys") {
		t.Errorf("an update over max_update_keys: %v", err)
	}
	if _, err := parseMetaUpdate(map[string]any{"a": strings.Repeat("x", 40)}, lim); err == nil || !strings.Contains(err.Error(), "limits.max_meta") {
		t.Errorf("an update over max_meta: %v", err)
	}
	// What an update makes of a meta: over the cap only when larger than it
	// and than before, so a meta over a lowered cap can shrink.
	for name, tc := range map[string]struct {
		old, set map[string]any
		remove   []string
		over     bool
	}{
		"grows over":     {map[string]any{"a": "xxxxxxxxxx"}, map[string]any{"b": "yyyyyyyyyyyyyyyyyyyy"}, nil, true},
		"stays under":    {map[string]any{"a": "x"}, map[string]any{"b": "y"}, nil, false},
		"shrinks, over":  {map[string]any{"a": strings.Repeat("x", 40), "b": "y"}, nil, []string{"b"}, false},
		"none, grows":    {nil, map[string]any{"a": strings.Repeat("x", 40)}, nil, true},
		"same size over": {map[string]any{"a": strings.Repeat("x", 40)}, map[string]any{"a": strings.Repeat("y", 40)}, nil, false},
	} {
		if size, over := mergedMetaSize(tc.old, tc.set, tc.remove, 32); over != tc.over {
			t.Errorf("%s: %d bytes, over %v", name, size, over)
		}
	}
	set, remove := splitUpdate(map[string]any{"b": nil, "a": "x", "c": nil})
	if set["a"] != "x" || len(set) != 1 || strings.Join(remove, ",") != "b,c" {
		t.Errorf("split: %v %v", set, remove)
	}
}

// TestStore_Versions keeps versions of chunks in their meta, as a caller
// that cuts documents again would: a commit, a status, and the dates from
// and until which a chunk holds. The operators of the filters find the
// state at a date; list pages, update changes the meta in place.
func TestStore_Versions(t *testing.T) {
	const forever = 253402300799
	fake := newFakeEndpoint(t, 16)
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			ctx := context.Background()
			s, _ := openBackend(t, b)
			cfg := testConfig(t, fake.URL, b.sc)
			m, _ := cfg.Model("bag")
			e := NewEmbedder(cfg.Endpoint, "")
			p := uniq("versioni")
			c := Collection{Name: "pezzi", Model: m.Name, Dims: m.Size()}
			if err := s.Create(ctx, p, c); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = s.Drop(context.Background(), p, c.Name) })
			v := func(id, text string, from int, kind string) Chunk {
				return Chunk{ID: id, Text: text, Doc: "guide/pane.md", Level: 1,
					Meta: map[string]any{"status": "attivo", "dal": from, "al": forever, "kind": kind}}
			}
			first := []Chunk{
				v("impasto@a", "Impastare la farina con il lievito per dieci minuti", 100, "testo"),
				v("forno@a", "Cuocere il pane in forno caldo per quaranta minuti", 100, "testo"),
				v("foto@a", "Immagine della pagnotta appena sfornata", 100, "immagine"),
			}
			first = append(first, Chunk{ID: "nota@a", Text: "Una nota senza stato sul pane", Doc: "guide/pane.md", Level: 2, Meta: map[string]any{"dal": "ieri"}})
			if err := s.Upsert(ctx, p, c, embedAll(t, e, m, first)); err != nil {
				t.Fatal(err)
			}
			// At date 200 the dough changes: the old chunk is closed, the
			// new one opens.
			n, err := s.Update(ctx, p, c, []string{"impasto@a"}, Filter{}, map[string]any{"status": "superato", "al": 200}, 16<<10)
			if err != nil || n != 1 {
				t.Fatalf("update by id: %d %v", n, err)
			}
			if err := s.Upsert(ctx, p, c, embedAll(t, e, m, []Chunk{v("impasto@b", "Impastare la farina con acqua tiepida e lievito", 200, "testo")})); err != nil {
				t.Fatal(err)
			}
			at := func(date float64) Filter {
				return Filter{Conds: []MetaCond{{"al", "gt", date}, {"dal", "lte", date}}}
			}
			ids := func(f Filter) string {
				t.Helper()
				var out []string
				after := ""
				for {
					page, next, err := s.List(ctx, p, c, f, after, 2, false, false)
					if err != nil {
						t.Fatal(err)
					}
					if len(page) > 2 {
						t.Fatalf("a page of %d, limit 2", len(page))
					}
					for _, ch := range page {
						if ch.Text != "" {
							t.Errorf("list without text gave %q", ch.Text)
						}
						out = append(out, ch.ID)
					}
					if next == "" {
						break
					}
					after = next
				}
				sort.Strings(out)
				n, err := s.Count(ctx, p, c, f)
				if err != nil || int(n) != len(out) {
					t.Errorf("count %d, listed %d: %v", n, len(out), err)
				}
				return strings.Join(out, " ")
			}
			for name, tc := range map[string]struct {
				f    Filter
				want string
			}{
				"at 150":     {at(150), "forno@a foto@a impasto@a"},
				"at 250":     {at(250), "forno@a foto@a impasto@b"},
				"active":     {Filter{Meta: map[string]any{"status": "attivo"}}, "forno@a foto@a impasto@b"},
				"ne":         {Filter{Conds: []MetaCond{{"status", "ne", "superato"}}}, "forno@a foto@a impasto@b nota@a"},
				"in":         {Filter{Conds: []MetaCond{{"kind", "in", []any{"immagine", "tabella"}}}}, "foto@a"},
				"text range": {Filter{Conds: []MetaCond{{"dal", "gte", float64(0)}}, Levels: []int{2}}, ""},
				"all":        {Filter{}, "forno@a foto@a impasto@a impasto@b nota@a"},
			} {
				if got := ids(tc.f); got != tc.want {
					t.Errorf("%s: %q, want %q", name, got, tc.want)
				}
			}
			// The search at a date finds the dough of that date. The fake
			// model's 12 numbers mix words up: each date asks with its own
			// text, which the other date's filter leaves out.
			for date, q := range map[float64][2]string{
				150: {"impasto@a", "Impastare la farina con il lievito per dieci minuti"},
				250: {"impasto@b", "Impastare la farina con acqua tiepida e lievito"},
			} {
				vecs, _, _ := e.Queries(ctx, m, []string{q[1]})
				res, err := s.Search(ctx, p, c, vecs, 1, at(date), SearchOptions{WithText: true})
				if err != nil || len(res[0]) != 1 || res[0][0].ID != q[0] {
					t.Errorf("search at %v: %+v %v", date, res, err)
				}
			}
			// An update by a filter that reads the key it sets, and a key
			// removed; text and vectors stay.
			n, err = s.Update(ctx, p, c, nil, Filter{Docs: []string{"guide/pane.md"}, Meta: map[string]any{"status": "attivo"}},
				map[string]any{"status": "superato", "al": 300, "kind": nil}, 16<<10)
			if err != nil || n != 3 {
				t.Fatalf("update by filter: %d %v", n, err)
			}
			got, err := s.Get(ctx, p, c, []string{"forno@a", "nota@a"})
			if err != nil || len(got) != 2 {
				t.Fatalf("get: %+v %v", got, err)
			}
			for _, ch := range got {
				switch ch.ID {
				case "forno@a":
					if ch.Meta["status"] != "superato" || ch.Meta["al"] != float64(300) || ch.Meta["kind"] != nil || ch.Meta["dal"] != float64(100) || !strings.Contains(ch.Text, "forno") {
						t.Errorf("updated: %+v", ch)
					}
				case "nota@a":
					if ch.Meta["status"] != nil || ch.Meta["dal"] != "ieri" {
						t.Errorf("not in the filter, and changed: %+v", ch)
					}
				}
			}
			if got := ids(at(350)); got != "" {
				t.Errorf("at 350 after closing all: %q", got)
			}
			if got := ids(at(250)); got != "forno@a foto@a impasto@b" {
				t.Errorf("at 250 after closing all: %q", got)
			}
			if got := ids(at(150)); got != "forno@a foto@a impasto@a" {
				t.Errorf("at 150 after closing all: %q", got)
			}
			vecs, _, _ := e.Queries(ctx, m, []string{"Impastare la farina con acqua tiepida e lievito"})
			res, err := s.Search(ctx, p, c, vecs, 1, Filter{Docs: []string{"guide/pane.md"}}, SearchOptions{})
			if err != nil || len(res[0]) != 1 || !strings.HasPrefix(res[0][0].ID, "impasto@") {
				t.Errorf("the vectors after the updates: %+v %v", res, err)
			}
			// Refresh writes the fields but the text and the vector.
			re := Chunk{ID: "foto@a", Text: "ignored", Doc: "guide/pane.md", Level: 3, Title: "Pagnotta", Meta: map[string]any{"status": "attivo"}}
			if err := s.Refresh(ctx, p, c, []Chunk{re}); err != nil {
				t.Fatal(err)
			}
			got, _ = s.Get(ctx, p, c, []string{"foto@a"})
			if len(got) != 1 || got[0].Level != 3 || got[0].Title != "Pagnotta" || got[0].Meta["status"] != "attivo" || got[0].Meta["al"] != nil || !strings.Contains(got[0].Text, "pagnotta") {
				t.Errorf("refresh: %+v", got)
			}
			// A refresh that empties the title and the meta removes them, and
			// keeps the fingerprint of the vector; one of a chunk not stored
			// does nothing.
			fp := m.fingerprint(cfg.Endpoint)
			marked := embedAll(t, e, m, []Chunk{{ID: "segnato@a", Text: "Un pezzo con la sua impronta", Title: "Impronta", Doc: "guide/pane.md", Meta: map[string]any{"status": "attivo"}}})
			marked[0].Fingerprint = fp
			if err := s.Upsert(ctx, p, c, marked); err != nil {
				t.Fatal(err)
			}
			if err := s.Refresh(ctx, p, c, []Chunk{{ID: "segnato@a", Doc: "guide/pane.md", Level: 4}, {ID: "mai@a", Doc: "guide/pane.md"}}); err != nil {
				t.Fatal(err)
			}
			got, _ = s.Get(ctx, p, c, []string{"segnato@a", "mai@a"})
			if len(got) != 1 || got[0].Title != "" || got[0].Meta != nil || got[0].Level != 4 || got[0].Fingerprint != fp || !strings.Contains(got[0].Text, "impronta") {
				t.Errorf("refresh to empty fields: %+v", got)
			}
			// An update that would make a meta larger than the cap changes
			// none; one that makes it smaller passes, over the cap or not.
			before, _ := s.Get(ctx, p, c, []string{"forno@a"})
			if _, err := s.Update(ctx, p, c, nil, Filter{Docs: []string{"guide/pane.md"}}, map[string]any{"nota": strings.Repeat("x", 200)}, 128); err == nil || !strings.Contains(err.Error(), "limits.max_meta") {
				t.Errorf("an update over max_meta: %v", err)
			}
			after, _ := s.Get(ctx, p, c, []string{"forno@a"})
			if len(after) != 1 || after[0].Meta["nota"] != nil || !after[0].Updated.Equal(before[0].Updated) {
				t.Errorf("a refused update changed %+v", after)
			}
			if n, err := s.Update(ctx, p, c, []string{"forno@a"}, Filter{}, map[string]any{"kind": nil, "al": nil}, 16); err != nil || n != 1 {
				t.Errorf("an update that shrinks a meta over the cap: %d %v", n, err)
			}
			n, err = s.Update(ctx, p, c, nil, Filter{Meta: map[string]any{"status": "nessuno"}}, map[string]any{"x": 1}, 16<<10)
			if err != nil || n != 0 {
				t.Errorf("update of nothing: %d %v", n, err)
			}
			// A chunk stored without meta gets one.
			if err := s.Upsert(ctx, p, c, embedAll(t, e, m, []Chunk{{ID: "senza@a", Text: "Un pezzo senza metadati"}})); err != nil {
				t.Fatal(err)
			}
			if n, err := s.Update(ctx, p, c, []string{"senza@a"}, Filter{}, map[string]any{"status": "attivo", "gone": nil}, 16<<10); err != nil || n != 1 {
				t.Errorf("update of a chunk without meta: %d %v", n, err)
			}
			if got, _ := s.Get(ctx, p, c, []string{"senza@a"}); len(got) != 1 || got[0].Meta["status"] != "attivo" {
				t.Errorf("a chunk without meta, updated: %+v", got)
			}
		})
	}
}

// TestSQLite_TempInMemory checks that SQLite keeps its temporary files in
// memory: the image's file system is read-only.
func TestSQLite_TempInMemory(t *testing.T) {
	ext := sqliteExtension(t)
	registerSQLite(ext)
	dir := t.TempDir()
	// The direct queries' drivers run the same hook, and their authorizer
	// refuses a pragma.
	for _, driver := range []string{driverSQLite} {
		db, err := sql.Open(driver, "file:"+filepath.Join(dir, "t.db"))
		if err != nil {
			t.Fatal(err)
		}
		var mode int
		if err := db.QueryRow("PRAGMA temp_store").Scan(&mode); err != nil || mode != 2 {
			t.Errorf("%s: temp_store %d (%v), want 2 (memory)", driver, mode, err)
		}
		db.Close()
	}
}

// TestQdrant_MetaIndex gives the keys of store.meta_index a payload index:
// a new collection when it is made, one made before on its first use.
func TestQdrant_MetaIndex(t *testing.T) {
	u := os.Getenv("QDRANT_URL")
	if u == "" {
		t.Skip("QDRANT_URL names a Qdrant")
	}
	ctx := context.Background()
	p := uniq("rag")
	plain := openStore(t, StoreConfig{Kind: "qdrant", URL: u})
	indexing := openStore(t, StoreConfig{Kind: "qdrant", URL: u, MetaIndex: map[string]string{"status": "keyword", "dal": "integer"}})
	schema := func(name string) map[string]string {
		t.Helper()
		var info struct {
			PayloadSchema map[string]struct {
				DataType string `json:"data_type"`
			} `json:"payload_schema"`
		}
		qs := indexing.(*qdrantStore)
		if err := qs.do(ctx, qs.key, http.MethodGet, "/collections/"+qdrantCollection(p, name), nil, &info); err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for k, v := range info.PayloadSchema {
			out[k] = v.DataType
		}
		return out
	}
	for _, name := range []string{"prima", "dopo"} {
		t.Cleanup(func() { _ = plain.Drop(context.Background(), p, name) })
	}
	// Made before the preset named the keys: no index, until its first use.
	if err := plain.Create(ctx, p, Collection{Name: "prima", Model: "bag", Dims: 4}); err != nil {
		t.Fatal(err)
	}
	if s := schema("prima"); s["meta.status"] != "" {
		t.Fatalf("an index before the preset named it: %v", s)
	}
	if _, ok, err := indexing.Collection(ctx, p, "prima"); err != nil || !ok {
		t.Fatalf("collection: %v %v", ok, err)
	}
	if s := schema("prima"); s["meta.status"] != "keyword" || s["meta.dal"] != "integer" || s["doc"] != "keyword" {
		t.Errorf("after the first use: %v", s)
	}
	// Made with the preset: at once.
	if err := indexing.Create(ctx, p, Collection{Name: "dopo", Model: "bag", Dims: 4}); err != nil {
		t.Fatal(err)
	}
	if s := schema("dopo"); s["meta.status"] != "keyword" || s["meta.dal"] != "integer" {
		t.Errorf("a new collection: %v", s)
	}
}

func openStore(t *testing.T, sc StoreConfig) Store {
	t.Helper()
	s, _, err := Open(context.Background(), sc, Env{Name: "vec-qdrant"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// TestPostgres_SearchUsesIndex searches a collection with a filter on the
// meta under a generic plan, the one Postgres keeps after five runs of a
// statement: each search still goes through the HNSW index. The generic
// plan, not knowing the filter's value, guessed it keeps 1% of the chunks
// and sorted all those it kept: an exact search of the whole collection.
func TestPostgres_SearchUsesIndex(t *testing.T) {
	u := os.Getenv("PG_URL")
	if u == "" {
		t.Skip("PG_URL names a Postgres")
	}
	ctx := context.Background()
	// The plan Postgres keeps after five runs, from the first: generic.
	sep := "?"
	if strings.Contains(u, "?") {
		sep = "&"
	}
	s := openStore(t, StoreConfig{Kind: "postgres", URL: u + sep + "plan_cache_mode=force_generic_plan"})
	pg := s.(*pgStore)
	p := uniq("rag")
	c := Collection{Name: "indice", Model: "bag", Dims: 64}
	if err := s.Create(ctx, p, c); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Drop(context.Background(), p, c.Name) })
	vec := func(i int) []float32 {
		v := make([]float64, c.Dims)
		for j := range v {
			v[j] = math.Sin(float64(i*c.Dims + j))
		}
		return normalize(v)
	}
	for b := 0; b < 6000; b += 500 {
		var chunks []Chunk
		for i := b; i < b+500; i++ {
			chunks = append(chunks, Chunk{ID: fmt.Sprintf("c%05d", i), Text: "t", Doc: "d.md", Meta: map[string]any{"status": "attivo"}, Vector: vec(i)})
		}
		if err := s.Upsert(ctx, p, c, chunks); err != nil {
			t.Fatal(err)
		}
	}
	table := pgTable(p, c.Name)
	if _, err := pg.pool.Exec(ctx, "ANALYZE "+table); err != nil {
		t.Fatal(err)
	}
	scans := func() int64 {
		var n int64
		_, _ = pg.pool.Exec(ctx, "SELECT pg_stat_clear_snapshot()")
		if err := pg.pool.QueryRow(ctx, `SELECT coalesce(sum(idx_scan), 0) FROM pg_stat_user_indexes
			WHERE relid = $1::regclass AND indexrelname LIKE '%embedding%'`, table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := scans()
	const searches = 8
	f := Filter{Meta: map[string]any{"status": "attivo"}}
	for i := range searches {
		if hits, err := s.Search(ctx, p, c, [][]float32{vec(7 * i)}, 5, f, SearchOptions{}); err != nil || len(hits[0]) != 5 {
			t.Fatalf("search %d: %v %v", i, hits, err)
		}
	}
	// The statistics reach the view within some seconds.
	deadline := time.Now().Add(15 * time.Second)
	for scans()-before < searches && time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
	}
	if n := scans() - before; n < searches {
		t.Errorf("%d searches through the index of %d", n, searches)
	}

	// An exact search reads the table, and finds what a brute force finds.
	before = scans()
	for i := range 4 {
		q := vec(11 * i)
		hits, err := s.Search(ctx, p, c, [][]float32{q}, 5, f, SearchOptions{Exact: true})
		if err != nil {
			t.Fatal(err)
		}
		type scored struct {
			id    string
			score float64
		}
		var all []scored
		for j := range 6000 {
			var dot float64
			for d, x := range vec(j) {
				dot += float64(x) * float64(q[d])
			}
			all = append(all, scored{fmt.Sprintf("c%05d", j), dot})
		}
		sort.Slice(all, func(a, b int) bool { return all[a].score > all[b].score })
		for r, h := range hits[0] {
			if h.ID != all[r].id {
				t.Errorf("exact search %d, rank %d: %s, the brute force %s", i, r+1, h.ID, all[r].id)
			}
		}
	}
	// One search through the index after them: the statistics have come
	// when it shows, and the exact ones added nothing.
	if _, err := s.Search(ctx, p, c, [][]float32{vec(3)}, 5, f, SearchOptions{}); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(15 * time.Second)
	for scans()-before < 1 && time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
	}
	if n := scans() - before; n != 1 {
		t.Errorf("4 exact searches and 1 through the index: %d scans of the index, want 1", n)
	}
}

// TestStore_OldTables: a collection made before 0.3.0 has no column for
// the fingerprint of its vectors. A process of this version adds it on
// first use, and the chunks stored before read as having none.
func TestStore_OldTables(t *testing.T) {
	fake := newFakeEndpoint(t, 16)
	for _, b := range backends(t) {
		if b.name == "qdrant" {
			continue // a payload takes a new key as it is
		}
		t.Run(b.name, func(t *testing.T) {
			ctx := context.Background()
			s, _ := openBackend(t, b)
			cfg := testConfig(t, fake.URL, b.sc)
			m, _ := cfg.Model("bag")
			e := NewEmbedder(cfg.Endpoint, "")
			p := uniq("vecchio")
			c := Collection{Name: "vecchia", Model: m.Name, Dims: m.Size()}
			if err := s.Create(ctx, p, c); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = s.Drop(context.Background(), p, c.Name) })
			if err := s.Upsert(ctx, p, c, embedAll(t, e, m, procedures)); err != nil {
				t.Fatal(err)
			}
			var err error
			switch st := s.(type) {
			case *pgStore:
				_, err = st.pool.Exec(ctx, `ALTER TABLE `+pgTable(p, c.Name)+` DROP COLUMN fingerprint`)
			case *sqliteStore:
				var db *sql.DB
				if db, err = st.db(ctx, p); err == nil {
					_, err = db.ExecContext(ctx, `ALTER TABLE `+sqliteIdent(c.Name)+` DROP COLUMN fingerprint`)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			// The plugin of this version starts on the old table.
			s2, _ := openBackend(t, b)
			if got, ok, err := s2.Collection(ctx, p, c.Name); err != nil || !ok || got.Count != 4 {
				t.Fatalf("the old collection: %+v %v %v", got, ok, err)
			}
			got, err := s2.Get(ctx, p, c, []string{"orto-1"})
			if err != nil || len(got) != 1 || got[0].Fingerprint != "" || got[0].Text == "" {
				t.Fatalf("a chunk stored before: %+v %v", got, err)
			}
			marked := embedAll(t, e, m, procedures[:1])
			marked[0].Fingerprint = m.fingerprint(cfg.Endpoint)
			if err := s2.Upsert(ctx, p, c, marked); err != nil {
				t.Fatal(err)
			}
			page, _, err := s2.List(ctx, p, c, Filter{}, "", 10, false, true)
			if err != nil || len(page) != 4 {
				t.Fatalf("list: %+v %v", page, err)
			}
			for _, ch := range page {
				if want := map[bool]string{true: marked[0].Fingerprint}[ch.ID == "orto-1"]; ch.Fingerprint != want {
					t.Errorf("%s: fingerprint %q, want %q", ch.ID, ch.Fingerprint, want)
				}
			}
		})
	}
}

// roundTripFunc is an http.RoundTripper of a function.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// TestQdrant_RefreshRace: an upsert of a new text and vector while a
// refresh of the chunk runs keeps its text beside its vector. The refresh
// read the text and wrote it back with the whole payload: an upsert in
// between left the old text with the new vector.
func TestQdrant_RefreshRace(t *testing.T) {
	u := os.Getenv("QDRANT_URL")
	if u == "" {
		t.Skip("QDRANT_URL names a Qdrant")
	}
	ctx := context.Background()
	s := openStore(t, StoreConfig{Kind: "qdrant", URL: u}).(*qdrantStore)
	other := openStore(t, StoreConfig{Kind: "qdrant", URL: u})
	p := uniq("rag")
	c := Collection{Name: "gara", Model: "bag", Dims: 4}
	if err := s.Create(ctx, p, c); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = other.Drop(context.Background(), p, c.Name) })
	axis := func(i int) []float32 { v := make([]float32, 4); v[i] = 1; return v }
	if err := s.Upsert(ctx, p, c, []Chunk{{ID: "a", Text: "testo vecchio", Vector: axis(0)}}); err != nil {
		t.Fatal(err)
	}
	// The refresh's write comes after another process's upsert.
	var once sync.Once
	s.hc = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/points/batch") {
			once.Do(func() {
				if err := other.Upsert(r.Context(), p, c, []Chunk{{ID: "a", Text: "testo nuovo", Vector: axis(1)}}); err != nil {
					t.Error(err)
				}
			})
		}
		return http.DefaultTransport.RoundTrip(r)
	})}
	if err := s.Refresh(ctx, p, c, []Chunk{{ID: "a", Title: "Titolo", Meta: map[string]any{"status": "attivo"}}}); err != nil {
		t.Fatal(err)
	}
	hits, err := other.Search(ctx, p, c, [][]float32{axis(1)}, 1, Filter{}, SearchOptions{WithText: true})
	if err != nil || len(hits[0]) != 1 {
		t.Fatalf("search: %+v %v", hits, err)
	}
	if h := hits[0][0]; h.Text != "testo nuovo" || h.Title != "Titolo" || h.Meta["status"] != "attivo" || h.Score < 0.999 {
		t.Errorf("after the refresh: %+v", h)
	}
}

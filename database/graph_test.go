package main

import (
	"context"
	"encoding/json"
	"math/rand"
	"sort"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
)

func TestNeighbours(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	var vecs [][]float32
	for i := 0; i < 60; i++ {
		v := make([]float64, 16)
		for j := range v {
			v[j] = r.NormFloat64()
		}
		vecs = append(vecs, normalize(v))
	}
	edges := neighbours(vecs, 3)
	// Every vector's three most similar are among its edges, each pair once.
	has := map[[2]int]bool{}
	for _, e := range edges {
		p := [2]int{min(e.a, e.b), max(e.a, e.b)}
		if has[p] {
			t.Fatalf("pair %v twice", p)
		}
		has[p] = true
	}
	for i := range vecs {
		type sim struct {
			j int
			s float64
		}
		var all []sim
		for j := range vecs {
			if j != i {
				all = append(all, sim{j, dot(vecs[i], vecs[j])})
			}
		}
		sort.Slice(all, func(a, b int) bool { return all[a].s > all[b].s })
		for _, s := range all[:3] {
			if !has[[2]int{min(i, s.j), max(i, s.j)}] {
				t.Fatalf("%d's neighbour %d is no edge", i, s.j)
			}
		}
	}
	if len(neighbours(vecs[:1], 3)) != 0 {
		t.Error("one vector has neighbours")
	}
}

func TestGraph(t *testing.T) {
	for _, b := range backends(t) {
		t.Run(b.name, func(t *testing.T) {
			p, _ := testPlugin(t, b, QueryOff)
			proj := uniq("mappa")
			chunks := []any{}
			for _, ch := range procedures {
				chunks = append(chunks, map[string]any{"id": ch.ID, "text": ch.Text, "title": ch.Title, "doc": ch.Doc, "level": ch.Level, "parent": ch.Parent, "meta": ch.Meta})
			}
			call(t, p, "upsert", proj, map[string]any{"collection": "procedure", "chunks": chunks}, "")
			t.Cleanup(func() { _ = p.store.Drop(context.Background(), proj, "procedure") })
			ctx := context.Background()

			g, err := p.graph(ctx, proj, "chunks", map[string]any{"collection": "procedure", "k": float64(1)})
			if err != nil {
				t.Fatal(err)
			}
			if len(g.Nodes) != 4 || len(g.Edges) < 2 || len(g.Edges) > 4 || g.Stats.Truncated {
				t.Fatalf("chunks: %+v", g)
			}
			ids := map[string]graphNode{}
			for _, n := range g.Nodes {
				ids[n.ID] = n
			}
			for _, e := range g.Edges {
				if _, ok := ids[e.Source]; !ok || e.Weight > 1.0001 {
					t.Errorf("edge %+v", e)
				}
			}
			if n := ids["orto-1"]; n.Group != "guide/basilico.md" || n.Link != "guide/basilico.md" || n.Label != "Basilico" || !strings.Contains(n.Text, "foglie") || n.X != nil {
				t.Errorf("orto-1: %+v", n)
			}
			g, _ = p.graph(ctx, proj, "chunks", map[string]any{"collection": "procedure", "color": "meta.rev", "sample": float64(2), "layout": "pca"})
			if len(g.Nodes) != 2 || !g.Stats.Truncated || !strings.Contains(g.Stats.Filter, "2 chunks of 4") {
				t.Errorf("sample: %+v", g)
			}
			g, _ = p.graph(ctx, proj, "chunks", map[string]any{"collection": "procedure", "color": "meta.rev", "layout": "pca"})
			for _, n := range g.Nodes {
				if n.X == nil || *n.X < -1 || *n.X > 1 || (n.Group != "02" && n.Group != "03") {
					t.Errorf("pca and color: %+v", n)
				}
			}
			g, err = p.graph(ctx, proj, "docs", map[string]any{"collection": "procedure"})
			if err != nil || len(g.Nodes) != 2 || len(g.Edges) != 1 || g.Nodes[0].ID != "doc:guide/basilico.md" || g.Nodes[0].Group != "guide" || !strings.Contains(g.Nodes[0].Text, "2 chunks") {
				t.Errorf("docs: %+v %v", g, err)
			}
			// limits.max_graph caps the sample, asked or not.
			p.cfg.Limits.MaxGraph = 3
			if g, err := p.graph(ctx, proj, "chunks", map[string]any{"collection": "procedure"}); err != nil || len(g.Nodes) != 3 || !g.Stats.Truncated {
				t.Errorf("under max_graph 3: %+v %v", g, err)
			}
			if _, err := p.graph(ctx, proj, "chunks", map[string]any{"collection": "procedure", "sample": float64(4)}); err == nil {
				t.Error("a sample over max_graph accepted")
			}
			p.cfg.Limits.MaxGraph = 5000
			for args, why := range map[string]map[string]any{
				"k":       {"collection": "procedure", "k": float64(50)},
				"layout":  {"collection": "procedure", "layout": "umap"},
				"missing": {"collection": "nessuna"},
			} {
				if _, err := p.graph(ctx, proj, "chunks", why); err == nil {
					t.Errorf("%s: accepted", args)
				}
			}
			if _, err := p.graph(ctx, proj, "maps", map[string]any{"collection": "procedure"}); err == nil {
				t.Error("a graph that is not there")
			}
			// Through the tool, as gosidian calls it.
			var req mcp.CallToolRequest
			req.Params.Arguments = map[string]any{"graph": "docs", "with": map[string]any{"collection": "procedure"}}
			res, _ := p.handleGraph(ctx, req)
			if !res.IsError {
				t.Error("a graph without gosidian/project")
			}
			req.Params.Meta = mcp.NewMetaFromMap(map[string]any{metaProject: proj})
			res, _ = p.handleGraph(ctx, req)
			var out graphOut
			b, _ := json.Marshal(res.StructuredContent)
			if res.IsError || json.Unmarshal(b, &out) != nil || len(out.Nodes) != 2 {
				t.Errorf("the tool: %+v", res)
			}
		})
	}
}

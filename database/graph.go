package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/mark3labs/mcp-go/mcp"
)

// The graphs (gosidian's graph views): a sample of a collection's chunks,
// each linked to its k most similar, or its documents (the mean of their
// chunks), each linked to the most similar documents. The force of the
// graph places them: neighbours stay together, which a projection to two
// dimensions does not keep (a PCA kept 10 to 15% of the ten nearest
// neighbours of a bench of Italian passages). layout: pca fixes the places
// by the first components instead, for a small set.

const (
	graphTool = "gosidian_graph"
	// sampleMax caps the chunks of a graph: gosidian draws up to 5000 nodes.
	sampleMax     = 5000
	sampleDefault = 2000
	kMax          = 20
	// nodeText caps the text a node carries.
	nodeText = 400
)

var graphSchemas = map[string]map[string]any{
	"chunks": object([]string{"collection"}, map[string]any{
		"collection": prop("string", "The collection"),
		"k":          prop("integer", "Neighbours of each chunk (default 6, at most 20)"),
		"sample":     prop("integer", "Chunks drawn at most (default 2000, at most 5000), in proportion to the documents"),
		"color":      prop("string", "What groups the chunks: doc (default), level, parent, or meta.<key>"),
		"layout":     map[string]any{"type": "string", "enum": []string{"force", "pca"}, "description": "force (default): the neighbours place them; pca: the first components fix their places"},
	}),
	"docs": object([]string{"collection"}, map[string]any{
		"collection": prop("string", "The collection"),
		"k":          prop("integer", "Neighbours of each document (default 4, at most 20)"),
		"color":      prop("string", "What groups the documents: folder (default) or doc"),
		"layout":     map[string]any{"type": "string", "enum": []string{"force", "pca"}, "description": "force (default) or pca"},
	}),
}

var graphDescriptions = map[string]string{
	"chunks": "The chunks of a collection, each linked to its most similar: similar chunks pull together",
	"docs":   "The documents of a collection, each the mean of its chunks, linked to the most similar documents",
}

type graphNode struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Group string   `json:"group,omitempty"`
	Link  string   `json:"link,omitempty"`
	Text  string   `json:"text,omitempty"`
	X     *float64 `json:"x,omitempty"`
	Y     *float64 `json:"y,omitempty"`
	Z     *float64 `json:"z,omitempty"`
}

type graphEdge struct {
	Source string  `json:"source"`
	Target string  `json:"target"`
	Weight float64 `json:"weight"`
}

type graphOut struct {
	Nodes []graphNode `json:"nodes"`
	Edges []graphEdge `json:"edges"`
	Stats struct {
		Truncated bool   `json:"truncated"`
		Filter    string `json:"filter,omitempty"`
	} `json:"stats"`
}

func (p *Plugin) handleGraph(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	project, err := projectOf(req)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	var with map[string]any
	if err := decode(req.GetArguments(), "with", &with); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	out, err := p.graph(ctx, project, req.GetString("graph", ""), with)
	if err != nil {
		p.log.Warn("graph", "project", project, "err", err)
		return mcp.NewToolResultError(err.Error()), nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultStructured(json.RawMessage(b), fmt.Sprintf("%d nodes, %d edges", len(out.Nodes), len(out.Edges))), nil
}

func intArg(m map[string]any, name string, def, lo, hi int) (int, error) {
	v, ok := m[name]
	if !ok || v == nil {
		return def, nil
	}
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || int(f) < lo || int(f) > hi {
		return 0, fmt.Errorf("%s: a whole number from %d to %d", name, lo, hi)
	}
	return int(f), nil
}

func (p *Plugin) graph(ctx context.Context, project, name string, with map[string]any) (*graphOut, error) {
	if _, ok := graphSchemas[name]; !ok {
		return nil, fmt.Errorf("graph %q: chunks or docs", name)
	}
	collection, _ := with["collection"].(string)
	c, _, err := p.collection(ctx, project, collection)
	if err != nil {
		return nil, err
	}
	layout, _ := with["layout"].(string)
	if layout != "" && layout != "force" && layout != "pca" {
		return nil, fmt.Errorf("layout %q: force or pca", layout)
	}
	color, _ := with["color"].(string)
	limit := sampleMax
	k := 4
	if name == "chunks" {
		if limit, err = intArg(with, "sample", sampleDefault, 1, sampleMax); err != nil {
			return nil, err
		}
		k = 6
	}
	if k, err = intArg(with, "k", k, 1, kMax); err != nil {
		return nil, err
	}
	chunks, total, err := p.store.Sample(ctx, project, c, limit)
	if err != nil {
		return nil, err
	}
	out := &graphOut{Nodes: []graphNode{}, Edges: []graphEdge{}}
	var vecs [][]float32
	if name == "chunks" {
		for _, ch := range chunks {
			out.Nodes = append(out.Nodes, chunkNode(ch, color))
			vecs = append(vecs, ch.Vector)
		}
		if total > int64(len(chunks)) {
			out.Stats.Truncated = true
			out.Stats.Filter = fmt.Sprintf("a sample of %d chunks of %d", len(chunks), total)
		}
	} else {
		docs := map[string][]Chunk{}
		var order []string
		for _, ch := range chunks {
			d := ch.Doc
			if d == "" {
				d = "(no doc)"
			}
			if _, ok := docs[d]; !ok {
				order = append(order, d)
			}
			docs[d] = append(docs[d], ch)
		}
		sort.Strings(order)
		for _, d := range order {
			out.Nodes = append(out.Nodes, docNode(d, docs[d], color))
			vecs = append(vecs, centroid(docs[d]))
		}
		if total > int64(len(chunks)) {
			out.Stats.Truncated = true
			out.Stats.Filter = fmt.Sprintf("the documents of %d chunks of %d", len(chunks), total)
		}
	}
	for _, e := range neighbours(vecs, k) {
		out.Edges = append(out.Edges, graphEdge{Source: out.Nodes[e.a].ID, Target: out.Nodes[e.b].ID, Weight: round3(e.sim)})
	}
	if layout == "pca" {
		place(out.Nodes, vecs)
	}
	return out, nil
}

func round3(f float64) float64 { return math.Round(f*1000) / 1000 }

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

func chunkNode(ch Chunk, color string) graphNode {
	label := ch.Title
	if label == "" {
		label = path.Base(ch.Doc)
	}
	if label == "" || label == "." {
		label = ch.ID
	}
	n := graphNode{ID: ch.ID, Label: clip(label, 60), Text: clip(ch.Text, nodeText), Group: chunkGroup(ch, color)}
	if strings.HasSuffix(strings.ToLower(ch.Doc), ".md") {
		n.Link = ch.Doc
	}
	return n
}

func chunkGroup(ch Chunk, color string) string {
	switch {
	case color == "" || color == "doc":
		return ch.Doc
	case color == "level":
		return fmt.Sprint(ch.Level)
	case color == "parent":
		return ch.Parent
	case strings.HasPrefix(color, "meta."):
		if v, ok := ch.Meta[strings.TrimPrefix(color, "meta.")]; ok {
			return fmt.Sprint(v)
		}
	}
	return ""
}

func docNode(doc string, chunks []Chunk, color string) graphNode {
	label := chunks[0].Title
	if label == "" {
		label = strings.TrimSuffix(path.Base(doc), path.Ext(doc))
	}
	group := path.Dir(doc)
	if group == "." {
		group = ""
	}
	if color == "doc" {
		group = doc
	}
	n := graphNode{ID: "doc:" + doc, Label: clip(label, 60), Group: group,
		Text: fmt.Sprintf("%s — %d chunks\n\n%s", doc, len(chunks), clip(chunks[0].Text, nodeText))}
	if strings.HasSuffix(strings.ToLower(doc), ".md") {
		n.Link = doc
	}
	return n
}

// centroid is the mean of chunks' vectors, of length 1.
func centroid(chunks []Chunk) []float32 {
	sum := make([]float64, len(chunks[0].Vector))
	for _, ch := range chunks {
		for i, x := range ch.Vector {
			sum[i] += float64(x)
		}
	}
	return normalize(sum)
}

type edge struct {
	a, b int
	sim  float64
}

// neighbours links each vector to its k most similar (cosine, the vectors
// being of length 1), once per pair, the work shared by the CPUs.
func neighbours(vecs [][]float32, k int) []edge {
	n := len(vecs)
	if n < 2 {
		return nil
	}
	k = min(k, n-1)
	best := make([][]edge, n)
	workers := max(1, min(runtime.NumCPU(), 8))
	var wg sync.WaitGroup
	next := make(chan int, n)
	for i := 0; i < n; i++ {
		next <- i
	}
	close(next)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			top := make([]edge, 0, k+1)
			for i := range next {
				top = top[:0]
				for j := 0; j < n; j++ {
					if j == i {
						continue
					}
					s := dot(vecs[i], vecs[j])
					if len(top) < k {
						top = append(top, edge{i, j, s})
						sort.Slice(top, func(x, y int) bool { return top[x].sim > top[y].sim })
						continue
					}
					if s <= top[k-1].sim {
						continue
					}
					top[k-1] = edge{i, j, s}
					for x := k - 1; x > 0 && top[x].sim > top[x-1].sim; x-- {
						top[x], top[x-1] = top[x-1], top[x]
					}
				}
				best[i] = append([]edge(nil), top...)
			}
		}()
	}
	wg.Wait()
	type pair struct{ a, b int }
	seen := map[pair]bool{}
	var out []edge
	for _, list := range best {
		for _, e := range list {
			p := pair{min(e.a, e.b), max(e.a, e.b)}
			if seen[p] {
				continue
			}
			seen[p] = true
			out = append(out, e)
		}
	}
	return out
}

func dot(a, b []float32) float64 {
	var s float32
	for i := range a {
		s += a[i] * b[i]
	}
	return float64(s)
}

// place fixes the nodes at the first three principal components of their
// vectors, by power iteration, scaled to -1…1.
func place(nodes []graphNode, vecs [][]float32) {
	n := len(vecs)
	if n < 3 {
		return
	}
	d := len(vecs[0])
	mean := make([]float64, d)
	for _, v := range vecs {
		for i, x := range v {
			mean[i] += float64(x) / float64(n)
		}
	}
	centred := make([][]float64, n)
	for r, v := range vecs {
		row := make([]float64, d)
		for i, x := range v {
			row[i] = float64(x) - mean[i]
		}
		centred[r] = row
	}
	var comps [][]float64
	for c := 0; c < 3; c++ {
		v := make([]float64, d)
		for i := range v {
			v[i] = math.Sin(float64(i*(c+1)) + 1)
		}
		for it := 0; it < 50; it++ {
			proj := make([]float64, n)
			for r, row := range centred {
				proj[r] = dotf(row, v)
			}
			next := make([]float64, d)
			for r, row := range centred {
				for i, x := range row {
					next[i] += proj[r] * x
				}
			}
			for _, prev := range comps {
				p := dotf(next, prev)
				for i := range next {
					next[i] -= p * prev[i]
				}
			}
			norm := math.Sqrt(dotf(next, next))
			if norm == 0 {
				break
			}
			for i := range next {
				next[i] /= norm
			}
			v = next
		}
		comps = append(comps, v)
	}
	coords := make([][3]float64, n)
	var span [3]float64
	for r, row := range centred {
		for c := 0; c < 3; c++ {
			coords[r][c] = dotf(row, comps[c])
			span[c] = math.Max(span[c], math.Abs(coords[r][c]))
		}
	}
	for r := range nodes {
		var xyz [3]*float64
		for c := 0; c < 3; c++ {
			v := 0.0
			if span[c] > 0 {
				v = round3(coords[r][c] / span[c])
			}
			xyz[c] = &v
		}
		nodes[r].X, nodes[r].Y, nodes[r].Z = xyz[0], xyz[1], xyz[2]
	}
}

func dotf(a, b []float64) float64 {
	var s float64
	for i := range a {
		s += a[i] * b[i]
	}
	return s
}

// parseVectorText reads a vector as pgvector writes it: [0.1,0.2,…].
func parseVectorText(s string) ([]float32, error) {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '[' || s[len(s)-1] != ']' {
		return nil, errors.New("not a vector")
	}
	var f []float32
	if err := json.Unmarshal([]byte(s), &f); err != nil {
		return nil, err
	}
	return f, nil
}

package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// The _meta fields gosidian calls a node or a tool with (gosidian
// docs/plugins.md): the project, which keeps the data of the projects
// apart, and who called a tool.
const (
	metaProject = "gosidian/project"
	metaCaller  = "gosidian/caller"
)

// Plugin is an archive of vectors: one store, one preset of embeddings,
// served to gosidian as nodes for the pipelines and tools for the agents.
type Plugin struct {
	cfg   *Config
	env   Env
	store Store
	emb   *Embedder
	rank  *Ranker
	query Querier
	sem   chan struct{}
	log   *slog.Logger
}

// NewPlugin is the plugin of a preset, its store, its embedder and its
// rerankers; query is nil while DB_QUERY is off.
func NewPlugin(cfg *Config, env Env, store Store, emb *Embedder, rank *Ranker, query Querier, log *slog.Logger) *Plugin {
	return &Plugin{cfg: cfg, env: env, store: store, emb: emb, rank: rank, query: query,
		sem: make(chan struct{}, max(env.QueryConcurrency, 1)), log: log}
}

// The operations: each is a node of the pipelines and a tool of the
// agents, with the access a token needs to call it.
type operation struct {
	name, access, description string
	input                     map[string]any
	handler                   func(*Plugin, context.Context, mcp.CallToolRequest, string) (any, error)
}

func prop(typ, desc string) map[string]any { return map[string]any{"type": typ, "description": desc} }

func object(required []string, props map[string]any) map[string]any {
	o := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		o["required"] = required
	}
	return o
}

var filterSchema = map[string]any{"type": "object", "description": "Every field set must hold: doc and parent (a string or a list), level (a number or a list), meta (an object of top-level keys: the value a key has, or an object of operators, eq, ne, in (a list), and gt, gte, lt, lte for numbers: {\"rev\": {\"gte\": 2, \"lt\": 5}}; ne holds for a chunk without the key)",
	"properties": map[string]any{"doc": map[string]any{}, "parent": map[string]any{}, "level": map[string]any{}, "meta": map[string]any{"type": "object"}}}

func (p *Plugin) operations() []operation {
	coll := prop("string", "The collection: lower-case letters, digits and _")
	search := map[string]any{
		"collection": coll,
		"query":      prop("string", "The text to look for"),
		"queries":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": fmt.Sprintf("Several texts at once, instead of query: at most %d (limits.max_queries)", p.cfg.Limits.MaxQueries)},
		"k":          prop("integer", "Results per text (default 5)"),
		"filter":     filterSchema,
		"min_score":  prop("number", "Leave out the results below this cosine similarity"),
		"with_text":  prop("boolean", "Give the chunks' text (default true)"),
		"exact":      prop("boolean", "Compare the text with every chunk the filter keeps, not through the index: slower, the reference an index's results are measured against (SQLite always does)"),
		"ef":         prop("integer", "The breadth of the HNSW search, 1 to 1000: more finds more, slower (Postgres hnsw.ef_search, Qdrant hnsw_ef); 0 or none the preset's store.ef, or max(40, 2k) up to 1000 and max(64, 2k)"),
	}
	searchDesc := "Chunks similar to a text, by the cosine of their embeddings: similar, not necessarily relevant"
	if len(p.cfg.Rerankers) > 0 {
		searchDesc += "; with rerank, a reranker reads the first candidates with the text and orders them by relevance"
		search["rerank"] = map[string]any{"description": fmt.Sprintf("Order the candidates again with a reranker: true for the preset's (%s), or its name (%s)", p.cfg.DefaultReranker, p.rerankerNames())}
		search["candidates"] = prop("integer", fmt.Sprintf("With rerank: the chunks the cosine finds first, per text, which the reranker reads, k of them kept (default 50, at least k, at most %d, limits.max_rerank)", p.cfg.Limits.MaxRerank))
		search["min_rerank_score"] = prop("number", "With rerank: leave out the results the reranker scores below this")
	}
	ops := []operation{
		{"upsert", "write", "Store chunks with their embeddings in a collection, which it creates with the model on first use; a chunk with the id of one stored replaces it, and keeps its embedding when its text and title, and the preset's definition of the model, are the same",
			object([]string{"collection", "chunks"}, map[string]any{
				"collection": coll,
				"model":      prop("string", "The embedding model of a new collection (default: the preset's); a collection keeps its own"),
				"reembed":    prop("boolean", "Embed every chunk again, also those whose text, title and model definition are the same as stored"),
				"chunks": map[string]any{"type": "array", "description": "The chunks, cut by the caller", "items": object([]string{"id", "text"}, map[string]any{
					"id": prop("string", "The chunk's id in the collection"), "text": prop("string", "The text to embed and keep"),
					"title": prop("string", "A title the model's document template may use"),
					"doc":   prop("string", "Where it comes from: a note, a file"), "parent": prop("string", "The id of the chunk it is part of"),
					"level": prop("integer", "Its level, for a cut on several levels"), "meta": prop("object", "Data of the caller's, kept and filterable"),
					"vector": map[string]any{"type": "array", "items": map[string]any{"type": "number"},
						"description": "Its embedding, made already by the collection's model (from list with vectors, in another archive): as many numbers as the collection's dims, kept instead of embedding the text; one of length 1 stays as given, another is made length 1"},
					"fingerprint": prop("string", "With vector: the fingerprint of the model's definition that made it, as list with vectors gives it; a later upsert of the same text keeps the vector only when it is the preset's")})},
			}), (*Plugin).doUpsert},
		{"search", "read", searchDesc, object([]string{"collection"}, search), (*Plugin).doSearch},
		{"get", "read", "Chunks of a collection by id",
			object([]string{"collection", "ids"}, map[string]any{"collection": coll,
				"ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}}), (*Plugin).doGet},
		{"list", "read", "Chunks of a collection by filter, a page at a time (by id; in Qdrant by point), without their embeddings and their text unless asked; the first page (no cursor) gives total, the chunks of the filter",
			object([]string{"collection"}, map[string]any{"collection": coll, "filter": filterSchema,
				"limit":     prop("integer", fmt.Sprintf("Chunks per page (default 100, at most %d): fewer when they do not fit in one result, and next goes on", p.cfg.Limits.MaxList)),
				"cursor":    prop("string", "The next page: the next of the page before"),
				"with_text": prop("boolean", "Give the chunks' text (default false)"),
				"vectors":   prop("boolean", fmt.Sprintf("Give the chunks' embeddings too (vector, and the fingerprint of the model's definition that made it), as stored, to copy them into another archive with upsert: at most %d chunks a page then", p.cfg.Limits.MaxItems)),
				"fields": map[string]any{"type": "array", "items": map[string]any{"type": "string"},
					"description": "Only these fields of each chunk: id, doc, parent, level, title, text, updated, meta, or meta.<key> for one key (default: all)"},
			}), (*Plugin).doList},
		{"update", "write", "Change keys of the meta of chunks, by id, by filter, or both, keeping their text and embeddings: a key set to null goes; an update that would make a chunk's meta larger than limits.max_meta changes nothing",
			object([]string{"collection", "meta"}, map[string]any{"collection": coll,
				"ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}, "filter": filterSchema,
				"meta": prop("object", fmt.Sprintf("The top-level keys to set, each to its value; null removes a key (at most %d keys)", p.cfg.Limits.MaxUpdateKeys)),
			}), (*Plugin).doUpdate},
		{"delete", "write", "Delete chunks of a collection by id, by filter, or both",
			object([]string{"collection"}, map[string]any{"collection": coll,
				"ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}, "filter": filterSchema}), (*Plugin).doDelete},
		{"collections", "read", "The collections of the project, with their model, size and chunks; with name, that one",
			object(nil, map[string]any{"name": prop("string", "One collection")}), (*Plugin).doCollections},
		{"drop", "write", "Delete a collection and all its chunks",
			object([]string{"collection"}, map[string]any{"collection": coll}), (*Plugin).doDrop},
		{"copy", "write", "Copy the chunks of a collection, or those a filter keeps, with their embeddings into another collection of this archive, made with the same model and size: no model is called. It goes a page at a time: one that fails leaves the chunks copied before in to, and says how many",
			object([]string{"collection", "to"}, map[string]any{"collection": coll,
				"to":     prop("string", "The collection to copy into: a new one, or one of the same model and size; a chunk with an id it has replaces it"),
				"filter": filterSchema}), (*Plugin).doCopy},
	}
	if len(p.cfg.Rerankers) > 0 {
		ops = append(ops, operation{"rerank", "read", "Order texts by how well they answer a question, with a reranker that reads the question with each: texts, objects with a text (a search's hits, results of another source), or chunks of a collection by id",
			object([]string{"query"}, map[string]any{
				"query":      prop("string", "The question"),
				"texts":      map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "The texts to order"},
				"items":      map[string]any{"type": "array", "items": map[string]any{"type": "object"}, "description": "Objects to order, each with its text (and title, for the reranker's template): given back whole, with rerank_score"},
				"collection": coll,
				"ids":        map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "With collection: the chunks to order"},
				"model":      prop("string", fmt.Sprintf("The reranker (default %s): %s", p.cfg.DefaultReranker, p.rerankerNames())),
				"k":          prop("integer", "Keep the first k (default all)"),
				"min_score":  prop("number", "Leave out those the reranker scores below this"),
			}), (*Plugin).doRerank})
	}
	if p.query != nil {
		desc, props := p.queryInput()
		ops = append(ops, operation{"query", p.env.Query, desc, object(nil, props), (*Plugin).doQuery})
	}
	return ops
}

func (p *Plugin) queryInput() (string, map[string]any) {
	embed := map[string]any{"type": "object", "description": "Texts whose embeddings (with the collection's model) the query uses, by name"}
	vectors := prop("boolean", "Give vectors in full, not their size")
	if p.cfg.Store.Kind == "qdrant" {
		return "A direct query on Qdrant: an operation of its API on a collection of the project, its body as the API takes it; a string \"$name\" in the body is the vector of embed's name",
			map[string]any{"op": prop("string", "query, query_groups, scroll, count, facet, retrieve, matrix_pairs, matrix_offsets, info; with write also set_payload, overwrite_payload, delete_payload, delete_points"),
				"collection": prop("string", "The collection"), "body": prop("object", "The operation's body"),
				"embed": embed, "model": prop("string", "The model of embed (default: the collection's)"), "vectors": vectors}
	}
	param := "@name"
	if p.cfg.Store.Kind == "sqlite" {
		param = ":name"
	}
	cast := ""
	if p.cfg.Store.Kind == "postgres" {
		cast = " (a vector as text: cast it, @q::vector, or ::halfvec for a collection over 2000 numbers)"
	}
	return "A direct query in SQL, in the project's own space: each collection is a table or view by its name (id, doc, parent, level, title, text, meta, updated, embedding), and collections lists them; " + param + " names a parameter, embed's vectors among them" + cast,
		map[string]any{"sql": prop("string", "One statement"), "params": prop("object", "The statement's named parameters"),
			"embed": embed, "model": prop("string", "The model of embed (default: the preset's)"), "vectors": vectors}
}

// Manifest is what the plugin says of itself to gosidian.
func (p *Plugin) Manifest() map[string]any {
	ops := p.operations()
	nodes := make([]any, 0, len(ops))
	tools := make([]any, 0, len(ops))
	for _, o := range ops {
		nodes = append(nodes, map[string]any{"name": o.name, "tool": o.name, "description": o.description, "input_schema": o.input})
		tools = append(tools, map[string]any{"name": o.name, "access": o.access, "description": o.description, "input_schema": o.input})
	}
	desc := p.cfg.Description
	if desc == "" {
		desc = "An archive of vectors (" + p.cfg.Store.Kind + ")"
	}
	network := p.cfg.Hosts()
	if network == nil {
		network = []string{}
	}
	graphs := []any{}
	for _, name := range []string{"chunks", "docs"} {
		graphs = append(graphs, map[string]any{"name": name, "description": graphDescriptions[name], "input_schema": graphSchemas[name]})
	}
	return map[string]any{"name": p.env.Name, "version": version, "gosidian": 1, "description": desc,
		"nodes": nodes, "tools": tools, "graphs": graphs, "permissions": map[string]any{"files": false, "network": network}}
}

// result is a tool's result, at most limits.max_result bytes, which
// follows what gosidian takes of a node's output.
func (p *Plugin) result(v any) (*mcp.CallToolResult, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if max := p.cfg.Limits.MaxResult; len(b) > max {
		return mcp.NewToolResultError(fmt.Sprintf("the result is %d bytes, more than limits.max_result (%d): ask for fewer chunks, or without their text, or raise it with gosidian's [pipelines] max_output_bytes", len(b), max)), nil
	}
	return mcp.NewToolResultStructured(json.RawMessage(b), string(b)), nil
}

// projectOf is the project a call acts for, from its _meta: only gosidian
// holds the plugin's token, and it names the project of the pipeline or
// of the agent's call.
func projectOf(req mcp.CallToolRequest) (string, error) {
	if req.Params.Meta != nil {
		if p, ok := req.Params.Meta.AdditionalFields[metaProject].(string); ok && p != "" && utf8.ValidString(p) && len(p) <= 255 {
			return p, nil
		}
	}
	return "", errors.New("the call has no gosidian/project in its _meta: gosidian 2.86 or later names the project of every call")
}

func (p *Plugin) handle(o operation) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		project, err := projectOf(req)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		start := time.Now()
		out, err := o.handler(p, ctx, req, project)
		// A direct query writes its own line, with the query.
		if o.name != "query" {
			if err != nil {
				p.log.Warn(o.name, "project", project, "err", err, "ms", time.Since(start).Milliseconds())
			} else {
				p.log.Info(o.name, "project", project, "ms", time.Since(start).Milliseconds())
			}
		}
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		return p.result(out)
	}
}

func checkCollection(name string) error {
	if !collectionName.MatchString(name) || name == "collections" {
		return fmt.Errorf("collection %q: lower-case letters, digits and _, starting with a letter, at most 48 (and not collections)", name)
	}
	return nil
}

// collection finds the collection a call names, and its model.
func (p *Plugin) collection(ctx context.Context, project, name string) (Collection, Model, error) {
	if err := checkCollection(name); err != nil {
		return Collection{}, Model{}, err
	}
	c, ok, err := p.store.Collection(ctx, project, name)
	if err != nil {
		return c, Model{}, err
	}
	if !ok {
		return c, Model{}, fmt.Errorf("project %q has no collection %q", project, name)
	}
	m, ok := p.cfg.Model(c.Model)
	if !ok {
		return c, m, fmt.Errorf("collection %s is of the model %s, which the preset no longer has", name, c.Model)
	}
	if m.Size() != c.Dims {
		return c, m, fmt.Errorf("collection %s keeps vectors of %d, and the preset's %s makes %d", name, c.Dims, m.Name, m.Size())
	}
	return c, m, nil
}

func decode(args map[string]any, name string, out any) error {
	v, ok := args[name]
	if !ok || v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

func (p *Plugin) doUpsert(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	name := req.GetString("collection", "")
	if err := checkCollection(name); err != nil {
		return nil, err
	}
	var in []chunkIn
	if err := decode(req.GetArguments(), "chunks", &in); err != nil {
		return nil, err
	}
	chunks := make([]Chunk, len(in))
	for i := range in {
		chunks[i] = in[i].Chunk
	}
	switch {
	case len(chunks) == 0:
		return nil, errors.New("chunks: at least one")
	case len(chunks) > p.cfg.Limits.MaxItems:
		return nil, fmt.Errorf("chunks: %d, at most %d per call", len(chunks), p.cfg.Limits.MaxItems)
	}
	seen := map[string]bool{}
	for i, ch := range chunks {
		switch {
		case ch.ID == "" || len(ch.ID) > 256:
			return nil, fmt.Errorf("chunks[%d]: an id of 1 to 256 bytes", i)
		case seen[ch.ID]:
			return nil, fmt.Errorf("chunks[%d]: the id %q twice", i, ch.ID)
		case strings.TrimSpace(ch.Text) == "":
			return nil, fmt.Errorf("chunks[%d] (%s): no text", i, ch.ID)
		case utf8.RuneCountInString(ch.Text) > p.cfg.Limits.MaxText:
			return nil, fmt.Errorf("chunks[%d] (%s): a text over %d characters", i, ch.ID, p.cfg.Limits.MaxText)
		case len(ch.Doc) > 1024 || len(ch.Parent) > 256 || len(ch.Title) > 1024:
			return nil, fmt.Errorf("chunks[%d] (%s): doc, title or parent too long", i, ch.ID)
		}
		if b, _ := json.Marshal(ch.Meta); len(b) > p.cfg.Limits.MaxMeta {
			return nil, fmt.Errorf("chunks[%d] (%s): meta of %d bytes, more than limits.max_meta (%d)", i, ch.ID, len(b), p.cfg.Limits.MaxMeta)
		}
		seen[ch.ID] = true
	}
	c, ok, err := p.store.Collection(ctx, project, name)
	if err != nil {
		return nil, err
	}
	want := req.GetString("model", "")
	if !ok {
		if want == "" {
			want = p.cfg.DefaultModel
		}
		m, found := p.cfg.Model(want)
		if !found {
			return nil, fmt.Errorf("model %q is no model of the preset (%s)", want, p.modelNames())
		}
		c = Collection{Name: name, Model: m.Name, Dims: m.Size()}
		if err := givenVectors(in, c.Dims); err != nil {
			return nil, err
		}
		if err := p.store.Create(ctx, project, c); err != nil {
			return nil, err
		}
		p.log.Info("created", "project", project, "collection", name, "model", m.Name, "dims", c.Dims)
	} else if want != "" && want != c.Model {
		return nil, fmt.Errorf("collection %s is of the model %s, not %s: one model per collection", name, c.Model, want)
	}
	c, m, err := p.collection(ctx, project, name)
	if err != nil {
		return nil, err
	}
	if err := givenVectors(in, c.Dims); err != nil {
		return nil, err
	}
	// A chunk with its embedding made already is stored with it, and with
	// the fingerprint that came with it, if any.
	var given []Chunk
	for i := range in {
		if in[i].Vector != nil {
			ch := in[i].Chunk
			ch.Vector, ch.Fingerprint = unitVector(in[i].Vector), in[i].Fingerprint
			given = append(given, ch)
		}
	}
	if len(given) > 0 {
		if err := p.store.Upsert(ctx, project, c, given); err != nil {
			return nil, err
		}
	}
	// A chunk stored with the same text and title, embedded by the same
	// definition of the model, keeps its embedding: it would be the same.
	// One stored without a fingerprint (before 0.3.0, or given without
	// one) is embedded again, once: what made it is unknown.
	fp := m.fingerprint(p.cfg.Endpoint)
	same := map[string]bool{}
	if ok && !req.GetBool("reembed", false) {
		stored, err := p.store.Get(ctx, project, c, chunkIDs(chunks))
		if err != nil {
			return nil, err
		}
		byID := make(map[string]Chunk, len(stored))
		for _, s := range stored {
			byID[s.ID] = s
		}
		for _, ch := range chunks {
			if s, found := byID[ch.ID]; found && s.Text == ch.Text && s.Title == ch.Title && s.Fingerprint == fp {
				same[ch.ID] = true
			}
		}
	}
	var embed, keep []Chunk
	for i, ch := range chunks {
		if in[i].Vector != nil {
			continue
		}
		if same[ch.ID] {
			keep = append(keep, ch)
		} else {
			embed = append(embed, ch)
		}
	}
	var usage Usage
	if len(embed) > 0 {
		docs := make([]Document, len(embed))
		for i, ch := range embed {
			docs[i] = Document{Text: ch.Text, Title: ch.Title}
		}
		vecs, u, err := p.emb.Documents(ctx, m, docs)
		if err != nil {
			return nil, err
		}
		usage = u
		for i := range embed {
			embed[i].Vector, embed[i].Fingerprint = vecs[i], fp
		}
		if err := p.store.Upsert(ctx, project, c, embed); err != nil {
			return nil, err
		}
	}
	if len(keep) > 0 {
		if err := p.store.Refresh(ctx, project, c, keep); err != nil {
			return nil, err
		}
	}
	return map[string]any{"collection": name, "model": m.Name, "dims": c.Dims, "upserted": len(chunks),
		"embedded": len(embed), "kept": len(keep), "given": len(given), "usage": usage}, nil
}

// msSince is the time from a to b in milliseconds, to a tenth.
func msSince(a, b time.Time) float64 {
	return math.Round(float64(b.Sub(a).Microseconds())/100) / 10
}

// chunkIn is a chunk as upsert takes it: with its embedding made already
// (vector) and the fingerprint of what made it, or to embed.
type chunkIn struct {
	Chunk
	Vector      []float64 `json:"vector"`
	Fingerprint string    `json:"fingerprint"`
}

// chunkOut is a chunk as list gives it with vectors.
type chunkOut struct {
	Chunk
	Vector      []float32 `json:"vector,omitempty"`
	Fingerprint string    `json:"fingerprint,omitempty"`
}

// givenVectors checks the embeddings a caller gives: dims finite numbers
// that make a vector of length 1 as float32, and a fingerprint as list
// gives it. Numbers whose squares overflow or underflow float64 (1e200,
// 1e-200) made a vector of zeros, whose cosine is NaN: a search that met
// it ranked nothing right.
func givenVectors(in []chunkIn, dims int) error {
	for i, ch := range in {
		if ch.Vector == nil {
			continue
		}
		if len(ch.Vector) != dims {
			return fmt.Errorf("chunks[%d] (%s): a vector of %d numbers, and the collection keeps %d", i, ch.ID, len(ch.Vector), dims)
		}
		zero := true
		for _, x := range ch.Vector {
			if math.IsNaN(x) || math.IsInf(x, 0) {
				return fmt.Errorf("chunks[%d] (%s): a vector of finite numbers", i, ch.ID)
			}
			if x != 0 {
				zero = false
			}
		}
		if zero {
			return fmt.Errorf("chunks[%d] (%s): a vector of zeros has no direction", i, ch.ID)
		}
		if !unitLength(unitVector(ch.Vector)) {
			return fmt.Errorf("chunks[%d] (%s): a vector that cannot be made length 1, its numbers too small or too large", i, ch.ID)
		}
		if ch.Fingerprint != "" && !fingerprintFormat.MatchString(ch.Fingerprint) {
			return fmt.Errorf("chunks[%d] (%s): the fingerprint %q is none list gives", i, ch.ID, ch.Fingerprint)
		}
	}
	return nil
}

// unitVector is a given embedding as the archive keeps them, length 1: one
// of length 1 already (an archive's, copied) stays as it is, number by
// number, so a copy searches as the original.
func unitVector(v []float64) []float32 {
	var n float64
	for _, x := range v {
		n += x * x
	}
	if math.Abs(math.Sqrt(n)-1) > 1e-3 {
		return normalize(v)
	}
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = float32(x)
	}
	return out
}

func (p *Plugin) doSearch(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	c, m, err := p.collection(ctx, project, req.GetString("collection", ""))
	if err != nil {
		return nil, err
	}
	var queries []string
	if err := decode(req.GetArguments(), "queries", &queries); err != nil {
		return nil, err
	}
	single := false
	if q := req.GetString("query", ""); q != "" {
		queries, single = append([]string{q}, queries...), len(queries) == 0
	}
	switch {
	case len(queries) == 0:
		return nil, errors.New("query (or queries) is the text to look for")
	case len(queries) > p.cfg.Limits.MaxQueries:
		return nil, fmt.Errorf("queries: at most %d (limits.max_queries)", p.cfg.Limits.MaxQueries)
	}
	k := int(req.GetFloat("k", 5))
	if k <= 0 || k > p.cfg.Limits.MaxK {
		return nil, fmt.Errorf("k: 1 to %d", p.cfg.Limits.MaxK)
	}
	f, err := parseFilter(req.GetArguments()["filter"], p.cfg.Limits.MaxIn)
	if err != nil {
		return nil, err
	}
	rr, reranked, err := p.searchReranker(req.GetArguments()["rerank"])
	if err != nil {
		return nil, err
	}
	withText, n := req.GetBool("with_text", true), k
	if reranked {
		n = int(req.GetFloat("candidates", float64(max(k, 50))))
		if n < k || n > p.cfg.Limits.MaxRerank {
			return nil, fmt.Errorf("candidates: k (%d) to %d (limits.max_rerank)", k, p.cfg.Limits.MaxRerank)
		}
	}
	t0 := time.Now()
	vecs, usage, err := p.emb.Queries(ctx, m, queries)
	if err != nil {
		return nil, err
	}
	t1 := time.Now()
	exact := req.GetBool("exact", false)
	ef := int(req.GetFloat("ef", 0))
	if ef < 0 || ef > 1000 {
		return nil, errors.New("ef: 1 to 1000, or 0 for the default")
	}
	if ef == 0 {
		ef = p.cfg.Store.EF
	}
	results, err := p.store.Search(ctx, project, c, vecs, n, f, SearchOptions{WithText: withText || reranked, Exact: exact, EF: ef})
	if err != nil {
		return nil, err
	}
	// The time of the model and of the store apart: a comparison of
	// archives or indexes reads the second.
	t2 := time.Now()
	ms := map[string]float64{"embed": msSince(t0, t1), "search": msSince(t1, t2)}
	if min, ok := req.GetArguments()["min_score"].(float64); ok {
		for i, hits := range results {
			kept := hits[:0]
			for _, h := range hits {
				if h.Score >= min {
					kept = append(kept, h)
				}
			}
			results[i] = kept
		}
	}
	if reranked {
		minRerank, hasMin := req.GetArguments()["min_rerank_score"].(float64)
		for i, hits := range results {
			docs := make([]Document, len(hits))
			for j, h := range hits {
				docs[j] = Document{Text: h.Text, Title: h.Title}
			}
			scores, u, err := p.rank.Scores(ctx, rr, queries[i], docs)
			if err != nil {
				return nil, err
			}
			usage.add(u)
			for j := range hits {
				hits[j].RerankScore = &scores[j]
			}
			// Equal scores keep the cosine's order.
			sort.SliceStable(hits, func(a, b int) bool { return *hits[a].RerankScore > *hits[b].RerankScore })
			kept := hits[:0]
			for _, h := range hits {
				if len(kept) < k && (!hasMin || *h.RerankScore >= minRerank) {
					if !withText {
						h.Text = ""
					}
					kept = append(kept, h)
				}
			}
			results[i] = kept
		}
		ms["rerank"] = msSince(t2, time.Now())
	}
	for i := range results {
		if results[i] == nil {
			results[i] = []Hit{}
		}
	}
	out := map[string]any{"collection": c.Name, "usage": usage, "ms": ms}
	if exact {
		out["exact"] = true
	}
	if reranked {
		out["reranker"], out["candidates"] = rr.Name, n
	}
	if single {
		out["hits"] = results[0]
	} else {
		out["results"] = results
	}
	return out, nil
}

// searchReranker is the reranker a search's rerank names: true the
// preset's default, a string by name; none (false, absent) reranks not.
func (p *Plugin) searchReranker(v any) (Reranker, bool, error) {
	switch v := v.(type) {
	case nil:
		return Reranker{}, false, nil
	case bool:
		if !v {
			return Reranker{}, false, nil
		}
		r, err := p.reranker("")
		return r, err == nil, err
	case string:
		r, err := p.reranker(v)
		return r, err == nil, err
	}
	return Reranker{}, false, errors.New("rerank: true, or the name of a reranker of the preset")
}

// reranker finds a reranker by name; empty, the preset's default.
func (p *Plugin) reranker(name string) (Reranker, error) {
	if len(p.cfg.Rerankers) == 0 {
		return Reranker{}, errors.New("rerank: the preset has no rerankers")
	}
	if name == "" {
		name = p.cfg.DefaultReranker
	}
	r, ok := p.cfg.Reranker(name)
	if !ok {
		return r, fmt.Errorf("reranker %q is no reranker of the preset (%s)", name, p.rerankerNames())
	}
	return r, nil
}

func (p *Plugin) rerankerNames() string {
	names := make([]string, len(p.cfg.Rerankers))
	for i, r := range p.cfg.Rerankers {
		names[i] = r.Name
	}
	return strings.Join(names, ", ")
}

// doRerank orders texts, objects with a text, or stored chunks by the
// reranker's score for a question.
func (p *Plugin) doRerank(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	query := req.GetString("query", "")
	if strings.TrimSpace(query) == "" {
		return nil, errors.New("query: the question the texts are ordered for")
	}
	rr, err := p.reranker(req.GetString("model", ""))
	if err != nil {
		return nil, err
	}
	var texts []string
	var items []map[string]any
	if err := decode(req.GetArguments(), "texts", &texts); err != nil {
		return nil, err
	}
	if err := decode(req.GetArguments(), "items", &items); err != nil {
		return nil, err
	}
	ids, err := p.ids(req)
	if err != nil {
		return nil, err
	}
	given := 0
	for _, n := range []int{len(texts), len(items), len(ids)} {
		if n > 0 {
			given++
		}
	}
	if given != 1 {
		return nil, errors.New("one of texts, items, or collection with ids")
	}
	if n := len(texts) + len(items) + len(ids); n > p.cfg.Limits.MaxRerank {
		return nil, fmt.Errorf("%d texts, at most %d (limits.max_rerank)", n, p.cfg.Limits.MaxRerank)
	}
	var docs []Document
	var out []map[string]any
	switch {
	case len(texts) > 0:
		for i, t := range texts {
			docs = append(docs, Document{Text: t})
			out = append(out, map[string]any{"index": i, "text": t})
		}
	case len(items) > 0:
		for i, it := range items {
			t, _ := it["text"].(string)
			if strings.TrimSpace(t) == "" {
				return nil, fmt.Errorf("items[%d]: no text", i)
			}
			title, _ := it["title"].(string)
			docs = append(docs, Document{Text: t, Title: title})
			out = append(out, it)
		}
	default:
		c, _, err := p.collection(ctx, project, req.GetString("collection", ""))
		if err != nil {
			return nil, err
		}
		chunks, err := p.store.Get(ctx, project, c, ids)
		if err != nil {
			return nil, err
		}
		for _, ch := range chunks {
			docs = append(docs, Document{Text: ch.Text, Title: ch.Title})
			b, err := json.Marshal(ch)
			if err != nil {
				return nil, err
			}
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				return nil, err
			}
			out = append(out, m)
		}
	}
	k := int(req.GetFloat("k", float64(len(docs))))
	if k <= 0 {
		return nil, errors.New("k: 1 or more")
	}
	start := time.Now()
	var scores []float64
	var usage Usage
	if len(docs) > 0 {
		if scores, usage, err = p.rank.Scores(ctx, rr, query, docs); err != nil {
			return nil, err
		}
	}
	for i := range out {
		out[i]["rerank_score"] = scores[i]
	}
	order := make([]int, len(out))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return scores[order[a]] > scores[order[b]] })
	minScore, hasMin := req.GetArguments()["min_score"].(float64)
	hits := []map[string]any{}
	for _, i := range order {
		if len(hits) < k && (!hasMin || scores[i] >= minScore) {
			hits = append(hits, out[i])
		}
	}
	return map[string]any{"reranker": rr.Name, "hits": hits, "usage": usage, "ms": map[string]float64{"rerank": msSince(start, time.Now())}}, nil
}

func (p *Plugin) ids(req mcp.CallToolRequest) ([]string, error) {
	var ids []string
	if err := decode(req.GetArguments(), "ids", &ids); err != nil {
		return nil, err
	}
	if len(ids) > p.cfg.Limits.MaxItems {
		return nil, fmt.Errorf("ids: %d, at most %d per call", len(ids), p.cfg.Limits.MaxItems)
	}
	return ids, nil
}

func (p *Plugin) doGet(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	c, _, err := p.collection(ctx, project, req.GetString("collection", ""))
	if err != nil {
		return nil, err
	}
	ids, err := p.ids(req)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, errors.New("ids: at least one")
	}
	chunks, err := p.store.Get(ctx, project, c, ids)
	if err != nil {
		return nil, err
	}
	if chunks == nil {
		chunks = []Chunk{}
	}
	return map[string]any{"collection": c.Name, "chunks": chunks}, nil
}

func (p *Plugin) doList(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	c, _, err := p.collection(ctx, project, req.GetString("collection", ""))
	if err != nil {
		return nil, err
	}
	f, err := parseFilter(req.GetArguments()["filter"], p.cfg.Limits.MaxIn)
	if err != nil {
		return nil, err
	}
	limit := int(req.GetFloat("limit", 100))
	vectors := req.GetBool("vectors", false)
	switch {
	case vectors && (limit <= 0 || limit > p.cfg.Limits.MaxItems):
		return nil, fmt.Errorf("limit: 1 to %d with vectors", p.cfg.Limits.MaxItems)
	case limit <= 0 || limit > p.cfg.Limits.MaxList:
		return nil, fmt.Errorf("limit: 1 to %d", p.cfg.Limits.MaxList)
	}
	cursor := req.GetString("cursor", "")
	if len(cursor) > 256 {
		return nil, errors.New("cursor: the next of the page before")
	}
	var fields []string
	if err := decode(req.GetArguments(), "fields", &fields); err != nil {
		return nil, err
	}
	for _, f := range fields {
		if !chunkFields[f] && !(strings.HasPrefix(f, "meta.") && metaKey.MatchString(f[5:])) {
			return nil, fmt.Errorf("fields: %q; id, doc, parent, level, title, text, updated, meta or meta.<key>", f)
		}
	}
	chunks, next, err := p.store.List(ctx, project, c, f, cursor, limit, req.GetBool("with_text", false), vectors)
	if err != nil {
		return nil, err
	}
	// The total on the first page only: a count is a pass over all the
	// filter keeps, and a caller paging through needs it once.
	var total *int64
	if cursor == "" {
		n, err := p.store.Count(ctx, project, c, f)
		if err != nil {
			return nil, err
		}
		total = &n
	}
	items := make([]any, len(chunks))
	for i, ch := range chunks {
		switch {
		case len(fields) > 0:
			m := pickFields(ch, fields)
			if vectors {
				m["vector"] = ch.Vector
				if ch.Fingerprint != "" {
					m["fingerprint"] = ch.Fingerprint
				}
			}
			items[i] = m
		case vectors:
			items[i] = chunkOut{Chunk: ch, Vector: ch.Vector, Fingerprint: ch.Fingerprint}
		default:
			items[i] = ch
		}
	}
	// A page holds the chunks that fit in a result gosidian takes: with
	// their vectors or long texts, fewer than limit, and next goes on from
	// the first left out.
	used := 0
	for i, it := range items {
		b, err := json.Marshal(it)
		if err != nil {
			return nil, err
		}
		if used += len(b) + 1; used <= p.cfg.Limits.MaxResult-listHeadroom {
			continue
		}
		if i == 0 {
			return nil, fmt.Errorf("the chunk %s alone is %d bytes, more than limits.max_result (%d): ask without its text or vector", chunks[0].ID, len(b), p.cfg.Limits.MaxResult)
		}
		next = p.store.Resume(project, c, chunks[i-1], chunks[i])
		items = items[:i]
		break
	}
	out := map[string]any{"collection": c.Name, "count": len(items), "next": next, "chunks": items}
	if total != nil {
		out["total"] = *total
	}
	if vectors {
		out["model"], out["dims"] = c.Model, c.Dims
	}
	return out, nil
}

// listHeadroom is the room a list leaves in a result for what is not its
// chunks.
const listHeadroom = 4 << 10

var chunkFields = map[string]bool{"id": true, "doc": true, "parent": true, "level": true, "title": true, "text": true, "updated": true, "meta": true}

// pickFields is a chunk with only some of its fields, and of its meta's
// keys (meta.<key>); a key the chunk has not is left out.
func pickFields(ch Chunk, fields []string) map[string]any {
	all := map[string]any{"id": ch.ID, "doc": ch.Doc, "parent": ch.Parent, "level": ch.Level, "title": ch.Title, "text": ch.Text, "updated": ch.Updated, "meta": ch.Meta}
	out := map[string]any{}
	for _, f := range fields {
		if key, ok := strings.CutPrefix(f, "meta."); ok {
			if v, ok := ch.Meta[key]; ok {
				m, _ := out["meta"].(map[string]any)
				if m == nil {
					m = map[string]any{}
					out["meta"] = m
				}
				m[key] = v
			}
			continue
		}
		out[f] = all[f]
	}
	return out
}

func (p *Plugin) doUpdate(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	c, _, err := p.collection(ctx, project, req.GetString("collection", ""))
	if err != nil {
		return nil, err
	}
	ids, err := p.ids(req)
	if err != nil {
		return nil, err
	}
	f, err := parseFilter(req.GetArguments()["filter"], p.cfg.Limits.MaxIn)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 && f.empty() {
		return nil, errors.New("update needs ids or a filter")
	}
	meta, err := parseMetaUpdate(req.GetArguments()["meta"], p.cfg.Limits)
	if err != nil {
		return nil, err
	}
	n, err := p.store.Update(ctx, project, c, ids, f, meta, p.cfg.Limits.MaxMeta)
	if err != nil {
		return nil, err
	}
	return map[string]any{"collection": c.Name, "updated": n}, nil
}

func (p *Plugin) doDelete(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	c, _, err := p.collection(ctx, project, req.GetString("collection", ""))
	if err != nil {
		return nil, err
	}
	ids, err := p.ids(req)
	if err != nil {
		return nil, err
	}
	f, err := parseFilter(req.GetArguments()["filter"], p.cfg.Limits.MaxIn)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 && f.empty() {
		return nil, errors.New("delete needs ids or a filter (drop deletes a whole collection)")
	}
	n, err := p.store.Delete(ctx, project, c, ids, f)
	if err != nil {
		return nil, err
	}
	return map[string]any{"collection": c.Name, "deleted": n}, nil
}

func (p *Plugin) doCollections(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	if name := req.GetString("name", ""); name != "" {
		c, m, err := p.collection(ctx, project, name)
		if err != nil {
			return nil, err
		}
		return map[string]any{"collection": c, "query_prefix": m.QueryPrefix, "document_template": m.DocumentTemplate}, nil
	}
	list, err := p.store.Collections(ctx, project)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []Collection{}
	}
	out := map[string]any{"collections": list, "models": p.modelNames(), "default_model": p.cfg.DefaultModel}
	if len(p.cfg.Rerankers) > 0 {
		out["rerankers"], out["default_reranker"] = p.rerankerNames(), p.cfg.DefaultReranker
	}
	return out, nil
}

// doCopy copies a collection's chunks, those of a filter, into another
// collection of the store, a page at a time, vectors and fingerprints as
// stored. A copy is no transaction: one that fails says how many chunks
// it left in the destination, which a copy again completes (a chunk with
// an id there is replaced).
func (p *Plugin) doCopy(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	src, _, err := p.collection(ctx, project, req.GetString("collection", ""))
	if err != nil {
		return nil, err
	}
	to := req.GetString("to", "")
	if err := checkCollection(to); err != nil {
		return nil, fmt.Errorf("to: %w", err)
	}
	if to == src.Name {
		return nil, errors.New("to: another collection than the one copied")
	}
	f, err := parseFilter(req.GetArguments()["filter"], p.cfg.Limits.MaxIn)
	if err != nil {
		return nil, err
	}
	dst, ok, err := p.store.Collection(ctx, project, to)
	if err != nil {
		return nil, err
	}
	switch {
	case !ok:
		dst = Collection{Name: to, Model: src.Model, Dims: src.Dims}
		if err := p.store.Create(ctx, project, dst); err != nil {
			return nil, err
		}
		p.log.Info("created", "project", project, "collection", to, "model", dst.Model, "dims", dst.Dims)
	case dst.Model != src.Model || dst.Dims != src.Dims:
		return nil, fmt.Errorf("collection %s keeps %s at %d numbers, and %s %s at %d: a copy keeps the model and the size", to, dst.Model, dst.Dims, src.Name, src.Model, src.Dims)
	}
	n, after := 0, ""
	for {
		chunks, next, err := p.store.List(ctx, project, src, f, after, p.cfg.Limits.MaxItems, true, true)
		if err != nil {
			return nil, fmt.Errorf("copy: %d chunks copied into %s before: %w", n, to, err)
		}
		if len(chunks) > 0 {
			if err := p.store.Upsert(ctx, project, dst, chunks); err != nil {
				return nil, fmt.Errorf("copy: %d chunks copied into %s before: %w", n, to, err)
			}
			n += len(chunks)
		}
		if next == "" {
			break
		}
		after = next
	}
	return map[string]any{"collection": src.Name, "to": to, "model": src.Model, "dims": src.Dims, "copied": n}, nil
}

func (p *Plugin) doDrop(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	c, _, err := p.collection(ctx, project, req.GetString("collection", ""))
	if err != nil {
		return nil, err
	}
	if err := p.store.Drop(ctx, project, c.Name); err != nil {
		return nil, err
	}
	p.log.Info("dropped", "project", project, "collection", c.Name)
	return map[string]any{"dropped": c.Name, "chunks": c.Count}, nil
}

func (p *Plugin) doQuery(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	args := req.GetArguments()
	dq := DirectQuery{SQL: req.GetString("sql", ""), Op: req.GetString("op", ""), Collection: req.GetString("collection", ""),
		Vectors: req.GetBool("vectors", false), Params: map[string]any{}}
	if err := decode(args, "params", &dq.Params); err != nil {
		return nil, err
	}
	if dq.Params == nil {
		dq.Params = map[string]any{}
	}
	if err := decode(args, "body", &dq.Body); err != nil {
		return nil, err
	}
	var embed map[string]string
	if err := decode(args, "embed", &embed); err != nil {
		return nil, err
	}
	var usage Usage
	if len(embed) > 0 {
		m, err := p.embedModel(ctx, project, req.GetString("model", ""), dq.Collection)
		if err != nil {
			return nil, err
		}
		names := sortedKeys(embed)
		texts := make([]string, len(names))
		for i, n := range names {
			texts[i] = embed[n]
		}
		vecs, u, err := p.emb.Queries(ctx, m, texts)
		if err != nil {
			return nil, err
		}
		usage = u
		dq.Embedded = map[string][]float32{}
		for i, n := range names {
			dq.Embedded[n] = vecs[i]
			if p.cfg.Store.Kind == "sqlite" {
				dq.Params[n] = blob(vecs[i])
			} else {
				dq.Params[n] = vectorText(vecs[i])
			}
		}
	}
	select {
	case p.sem <- struct{}{}:
		defer func() { <-p.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	qctx, cancel := context.WithTimeout(ctx, p.env.QueryTimeout)
	defer cancel()
	start := time.Now()
	res, err := p.query.Query(qctx, project, dq)
	what := dq.SQL
	if what == "" {
		b, _ := json.Marshal(dq.Body)
		what = dq.Op + " " + dq.Collection + " " + string(b)
	}
	if err != nil {
		p.log.Warn("query", "project", project, "caller", callerOf(req), "query", what, "ms", time.Since(start).Milliseconds(), "err", err)
		return nil, err
	}
	p.log.Info("query", "project", project, "caller", callerOf(req), "query", what, "rows", len(res.Rows), "ms", time.Since(start).Milliseconds())
	out := map[string]any{"columns": res.Columns, "rows": res.Rows, "truncated": res.Truncated}
	if res.Command != "" {
		out["command"] = res.Command
	}
	if res.Result != nil {
		out = map[string]any{"result": res.Result}
	}
	if len(embed) > 0 {
		out["usage"] = usage
	}
	return out, nil
}

// embedModel is the model of a direct query's embed: the one named, else
// the collection's, else the preset's.
func (p *Plugin) embedModel(ctx context.Context, project, name, collection string) (Model, error) {
	if name == "" && collection != "" {
		if c, ok, err := p.store.Collection(ctx, project, collection); err == nil && ok {
			name = c.Model
		}
	}
	if name == "" {
		name = p.cfg.DefaultModel
	}
	m, ok := p.cfg.Model(name)
	if !ok {
		return m, fmt.Errorf("model %q is no model of the preset (%s)", name, p.modelNames())
	}
	return m, nil
}

func callerOf(req mcp.CallToolRequest) string {
	if req.Params.Meta != nil {
		if c, ok := req.Params.Meta.AdditionalFields[metaCaller].(string); ok {
			return c
		}
	}
	return "pipeline"
}

func (p *Plugin) modelNames() string {
	names := make([]string, len(p.cfg.Models))
	for i, m := range p.cfg.Models {
		names[i] = m.Name
	}
	return strings.Join(names, ", ")
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedStrings(s []string) []string {
	sort.Strings(s)
	return s
}

// Handler serves the plugin: MCP at /mcp (with the token when set) and
// /health.
func (p *Plugin) Handler() http.Handler {
	ms := server.NewMCPServer("gosidian-database", version, server.WithToolCapabilities(false))
	ms.AddTool(mcp.NewTool("gosidian_manifest", mcp.WithDescription("The plugin's manifest, for gosidian")),
		func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) { return p.result(p.Manifest()) })
	for _, o := range p.operations() {
		schema, _ := json.Marshal(o.input)
		ms.AddTool(mcp.NewToolWithRawSchema(o.name, o.description, schema), p.handle(o))
	}
	ms.AddTool(mcp.NewTool(graphTool, mcp.WithDescription("A graph of the archive, for gosidian's graph views"),
		mcp.WithString("graph", mcp.Required()), mcp.WithObject("with")), p.handleGraph)
	mcpH := server.NewStreamableHTTPServer(ms)
	mux := http.NewServeMux()
	mux.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p.env.Token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+p.env.Token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mcpH.ServeHTTP(w, r)
	}))
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"status":"ok","version":%q,"store":%q,"query":%q}`+"\n", version, p.cfg.Store.Kind, p.env.Query)
	})
	return mux
}

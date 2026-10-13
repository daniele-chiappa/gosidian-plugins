package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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

// maxResult caps a result: gosidian takes up to 1 MiB of a node's output
// and of a tool's result.
const maxResult = 1000 << 10

// Plugin is an archive of vectors: one store, one preset of embeddings,
// served to gosidian as nodes for the pipelines and tools for the agents.
type Plugin struct {
	cfg   *Config
	env   Env
	store Store
	emb   *Embedder
	query Querier
	sem   chan struct{}
	log   *slog.Logger
}

// NewPlugin is the plugin of a preset, its store and its embedder; query
// is nil while DB_QUERY is off.
func NewPlugin(cfg *Config, env Env, store Store, emb *Embedder, query Querier, log *slog.Logger) *Plugin {
	return &Plugin{cfg: cfg, env: env, store: store, emb: emb, query: query,
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

var filterSchema = map[string]any{"type": "object", "description": "Every field set must hold: doc and parent (a string or a list), level (a number or a list), meta (an object of top-level keys and the values they have)",
	"properties": map[string]any{"doc": map[string]any{}, "parent": map[string]any{}, "level": map[string]any{}, "meta": map[string]any{"type": "object"}}}

func (p *Plugin) operations() []operation {
	coll := prop("string", "The collection: lower-case letters, digits and _")
	ops := []operation{
		{"upsert", "write", "Store chunks with their embeddings in a collection, which it creates with the model on first use; a chunk with the id of one stored replaces it",
			object([]string{"collection", "chunks"}, map[string]any{
				"collection": coll,
				"model":      prop("string", "The embedding model of a new collection (default: the preset's); a collection keeps its own"),
				"chunks": map[string]any{"type": "array", "description": "The chunks, cut by the caller", "items": object([]string{"id", "text"}, map[string]any{
					"id": prop("string", "The chunk's id in the collection"), "text": prop("string", "The text to embed and keep"),
					"title": prop("string", "A title the model's document template may use"),
					"doc":   prop("string", "Where it comes from: a note, a file"), "parent": prop("string", "The id of the chunk it is part of"),
					"level": prop("integer", "Its level, for a cut on several levels"), "meta": prop("object", "Data of the caller's, kept and filterable")})},
			}), (*Plugin).doUpsert},
		{"search", "read", "Chunks similar to a text, by the cosine of their embeddings: similar, not necessarily relevant",
			object([]string{"collection"}, map[string]any{
				"collection": coll,
				"query":      prop("string", "The text to look for"),
				"queries":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Several texts at once, instead of query"},
				"k":          prop("integer", "Results per text (default 5)"),
				"filter":     filterSchema,
				"min_score":  prop("number", "Leave out the results below this cosine similarity"),
				"with_text":  prop("boolean", "Give the chunks' text (default true)"),
			}), (*Plugin).doSearch},
		{"get", "read", "Chunks of a collection by id",
			object([]string{"collection", "ids"}, map[string]any{"collection": coll,
				"ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}}), (*Plugin).doGet},
		{"delete", "write", "Delete chunks of a collection by id, by filter, or both",
			object([]string{"collection"}, map[string]any{"collection": coll,
				"ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}, "filter": filterSchema}), (*Plugin).doDelete},
		{"collections", "read", "The collections of the project, with their model, size and chunks; with name, that one",
			object(nil, map[string]any{"name": prop("string", "One collection")}), (*Plugin).doCollections},
		{"drop", "write", "Delete a collection and all its chunks",
			object([]string{"collection"}, map[string]any{"collection": coll}), (*Plugin).doDrop},
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

func result(v any) (*mcp.CallToolResult, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if len(b) > maxResult {
		return mcp.NewToolResultError(fmt.Sprintf("the result is %d bytes, more than gosidian takes (%d): ask for fewer chunks, or without their text", len(b), maxResult)), nil
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
		return result(out)
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
	var chunks []Chunk
	if err := decode(req.GetArguments(), "chunks", &chunks); err != nil {
		return nil, err
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
		if b, _ := json.Marshal(ch.Meta); len(b) > 16<<10 {
			return nil, fmt.Errorf("chunks[%d] (%s): meta over 16 KiB", i, ch.ID)
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
	docs := make([]Document, len(chunks))
	for i, ch := range chunks {
		docs[i] = Document{Text: ch.Text, Title: ch.Title}
	}
	vecs, usage, err := p.emb.Documents(ctx, m, docs)
	if err != nil {
		return nil, err
	}
	for i := range chunks {
		chunks[i].Vector = vecs[i]
	}
	if err := p.store.Upsert(ctx, project, c, chunks); err != nil {
		return nil, err
	}
	return map[string]any{"collection": name, "model": m.Name, "dims": c.Dims, "upserted": len(chunks), "usage": usage}, nil
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
	case len(queries) > 32:
		return nil, errors.New("queries: at most 32")
	}
	k := int(req.GetFloat("k", 5))
	if k <= 0 || k > p.cfg.Limits.MaxK {
		return nil, fmt.Errorf("k: 1 to %d", p.cfg.Limits.MaxK)
	}
	f, err := parseFilter(req.GetArguments()["filter"])
	if err != nil {
		return nil, err
	}
	vecs, usage, err := p.emb.Queries(ctx, m, queries)
	if err != nil {
		return nil, err
	}
	results, err := p.store.Search(ctx, project, c, vecs, k, f, req.GetBool("with_text", true))
	if err != nil {
		return nil, err
	}
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
	for i := range results {
		if results[i] == nil {
			results[i] = []Hit{}
		}
	}
	if single {
		return map[string]any{"collection": c.Name, "hits": results[0], "usage": usage}, nil
	}
	return map[string]any{"collection": c.Name, "results": results, "usage": usage}, nil
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

func (p *Plugin) doDelete(ctx context.Context, req mcp.CallToolRequest, project string) (any, error) {
	c, _, err := p.collection(ctx, project, req.GetString("collection", ""))
	if err != nil {
		return nil, err
	}
	ids, err := p.ids(req)
	if err != nil {
		return nil, err
	}
	f, err := parseFilter(req.GetArguments()["filter"])
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
	return map[string]any{"collections": list, "models": p.modelNames(), "default_model": p.cfg.DefaultModel}, nil
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
		func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) { return result(p.Manifest()) })
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

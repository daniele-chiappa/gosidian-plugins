package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

// qdrantStore keeps the collections in Qdrant, through its REST API: a
// collection <key>__<name> for each project's collection, the chunk's id
// in the payload (chunk_id) and a point id made from it, and
// gosidian_meta, whose points list the collections.
type qdrantStore struct {
	base string
	key  string
	hc   *http.Client
}

const qdrantMeta = "gosidian_meta"

func openQdrant(ctx context.Context, sc StoreConfig, key string) (*qdrantStore, error) {
	s := &qdrantStore{base: strings.TrimRight(sc.URL, "/"), key: key, hc: &http.Client{Timeout: 2 * time.Minute}}
	var info struct{}
	err := s.do(ctx, s.key, http.MethodGet, "/collections/"+qdrantMeta, nil, &info)
	var qe *qdrantError
	if errors.As(err, &qe) && qe.status == http.StatusNotFound {
		err = s.do(ctx, s.key, http.MethodPut, "/collections/"+qdrantMeta, map[string]any{"vectors": map[string]any{"size": 1, "distance": "Dot"}}, nil)
		if err == nil {
			err = s.do(ctx, s.key, http.MethodPut, "/collections/"+qdrantMeta+"/index?wait=true", map[string]any{"field_name": "project", "field_schema": "keyword"}, nil)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("qdrant: %w", err)
	}
	return s, nil
}

func (s *qdrantStore) Close() error { return nil }

type qdrantError struct {
	status int
	msg    string
}

func (e *qdrantError) Error() string { return fmt.Sprintf("qdrant: %d %s", e.status, e.msg) }

// do calls Qdrant with key and reads its result into out.
func (s *qdrantStore) do(ctx context.Context, key, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.base+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("api-key", key)
	}
	resp, err := s.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return err
	}
	var env struct {
		Result json.RawMessage `json:"result"`
		Status any             `json:"status"`
	}
	_ = json.Unmarshal(b, &env)
	if resp.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(b))
		if m, ok := env.Status.(map[string]any); ok {
			if e, ok := m["error"].(string); ok {
				msg = e
			}
		}
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
		return &qdrantError{status: resp.StatusCode, msg: msg}
	}
	if out == nil {
		return nil
	}
	if raw, ok := out.(*json.RawMessage); ok {
		*raw = env.Result
		return nil
	}
	return json.Unmarshal(env.Result, out)
}

func qdrantCollection(project, name string) string { return projectKey(project) + "__" + name }

// pointID is a point's id: a UUID made from what it names.
func pointID(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

type qdrantMetaPoint struct {
	ID      string `json:"id"`
	Payload struct {
		Project string `json:"project"`
		Name    string `json:"name"`
		Model   string `json:"model"`
		Dims    int    `json:"dims"`
		Created string `json:"created"`
	} `json:"payload"`
}

func (s *qdrantStore) count(ctx context.Context, coll string, filter map[string]any) (int64, error) {
	body := map[string]any{"exact": true}
	if filter != nil {
		body["filter"] = filter
	}
	var r struct {
		Count int64 `json:"count"`
	}
	err := s.do(ctx, s.key, http.MethodPost, "/collections/"+coll+"/points/count", body, &r)
	return r.Count, err
}

func (s *qdrantStore) Collections(ctx context.Context, project string) ([]Collection, error) {
	var r struct {
		Points []qdrantMetaPoint `json:"points"`
	}
	err := s.do(ctx, s.key, http.MethodPost, "/collections/"+qdrantMeta+"/points/scroll", map[string]any{
		"filter": map[string]any{"must": []any{map[string]any{"key": "project", "match": map[string]any{"value": project}}}},
		"limit":  10000, "with_payload": true, "with_vector": false}, &r)
	if err != nil {
		return nil, err
	}
	out := make([]Collection, 0, len(r.Points))
	for _, p := range r.Points {
		c := Collection{Name: p.Payload.Name, Model: p.Payload.Model, Dims: p.Payload.Dims}
		c.Created, _ = time.Parse(time.RFC3339Nano, p.Payload.Created)
		if c.Count, err = s.count(ctx, qdrantCollection(project, c.Name), nil); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

func (s *qdrantStore) Collection(ctx context.Context, project, name string) (Collection, bool, error) {
	var points []qdrantMetaPoint
	if err := s.do(ctx, s.key, http.MethodPost, "/collections/"+qdrantMeta+"/points",
		map[string]any{"ids": []string{pointID(project, "", name)}, "with_payload": true}, &points); err != nil {
		return Collection{}, false, err
	}
	if len(points) == 0 {
		return Collection{Name: name}, false, nil
	}
	p := points[0].Payload
	c := Collection{Name: name, Model: p.Model, Dims: p.Dims}
	c.Created, _ = time.Parse(time.RFC3339Nano, p.Created)
	var err error
	c.Count, err = s.count(ctx, qdrantCollection(project, name), nil)
	return c, true, err
}

func (s *qdrantStore) Create(ctx context.Context, project string, c Collection) error {
	coll := qdrantCollection(project, c.Name)
	if err := s.do(ctx, s.key, http.MethodPut, "/collections/"+coll, map[string]any{
		"vectors": map[string]any{"size": c.Dims, "distance": "Cosine"}}, nil); err != nil {
		return err
	}
	for field, schema := range map[string]string{"chunk_id": "keyword", "doc": "keyword", "parent": "keyword", "level": "integer"} {
		if err := s.do(ctx, s.key, http.MethodPut, "/collections/"+coll+"/index?wait=true",
			map[string]any{"field_name": field, "field_schema": schema}, nil); err != nil {
			return err
		}
	}
	return s.do(ctx, s.key, http.MethodPut, "/collections/"+qdrantMeta+"/points?wait=true", map[string]any{"points": []any{map[string]any{
		"id": pointID(project, "", c.Name), "vector": []float32{1},
		"payload": map[string]any{"project": project, "name": c.Name, "model": c.Model, "dims": c.Dims,
			"created": time.Now().UTC().Format(time.RFC3339Nano)}}}}, nil)
}

func (s *qdrantStore) Drop(ctx context.Context, project, name string) error {
	if err := s.do(ctx, s.key, http.MethodDelete, "/collections/"+qdrantCollection(project, name), nil, nil); err != nil {
		var qe *qdrantError
		if !errors.As(err, &qe) || qe.status != http.StatusNotFound {
			return err
		}
	}
	return s.do(ctx, s.key, http.MethodPost, "/collections/"+qdrantMeta+"/points/delete?wait=true",
		map[string]any{"points": []string{pointID(project, "", name)}}, nil)
}

func (s *qdrantStore) Upsert(ctx context.Context, project string, c Collection, chunks []Chunk) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	points := make([]any, 0, len(chunks))
	for _, ch := range chunks {
		payload := map[string]any{"chunk_id": ch.ID, "text": ch.Text, "level": ch.Level, "updated": now}
		for k, v := range map[string]string{"doc": ch.Doc, "parent": ch.Parent, "title": ch.Title} {
			if v != "" {
				payload[k] = v
			}
		}
		if len(ch.Meta) > 0 {
			payload["meta"] = ch.Meta
		}
		points = append(points, map[string]any{"id": pointID(project, c.Name, ch.ID), "vector": ch.Vector, "payload": payload})
	}
	return s.do(ctx, s.key, http.MethodPut, "/collections/"+qdrantCollection(project, c.Name)+"/points?wait=true",
		map[string]any{"points": points}, nil)
}

// qdrantFilter is a filter as Qdrant reads it; ids narrow it to points.
func qdrantFilter(project, coll string, f Filter, ids []string) map[string]any {
	var must []any
	if len(f.Docs) > 0 {
		must = append(must, map[string]any{"key": "doc", "match": map[string]any{"any": f.Docs}})
	}
	if len(f.Parents) > 0 {
		must = append(must, map[string]any{"key": "parent", "match": map[string]any{"any": f.Parents}})
	}
	if len(f.Levels) > 0 {
		must = append(must, map[string]any{"key": "level", "match": map[string]any{"any": f.Levels}})
	}
	for k, v := range f.Meta {
		if n, ok := v.(float64); ok && n != math.Trunc(n) {
			must = append(must, map[string]any{"key": "meta." + k, "range": map[string]any{"gte": n, "lte": n}})
			continue
		}
		must = append(must, map[string]any{"key": "meta." + k, "match": map[string]any{"value": v}})
	}
	if len(ids) > 0 {
		pids := make([]string, len(ids))
		for i, id := range ids {
			pids[i] = pointID(project, coll, id)
		}
		must = append(must, map[string]any{"has_id": pids})
	}
	if len(must) == 0 {
		return nil
	}
	return map[string]any{"must": must}
}

type qdrantPoint struct {
	ID      any            `json:"id"`
	Score   float64        `json:"score"`
	Payload map[string]any `json:"payload"`
}

func (p qdrantPoint) chunk() Chunk {
	str := func(k string) string { s, _ := p.Payload[k].(string); return s }
	ch := Chunk{ID: str("chunk_id"), Text: str("text"), Title: str("title"), Doc: str("doc"), Parent: str("parent")}
	if l, ok := p.Payload["level"].(float64); ok {
		ch.Level = int(l)
	}
	if m, ok := p.Payload["meta"].(map[string]any); ok {
		ch.Meta = m
	}
	ch.Updated, _ = time.Parse(time.RFC3339Nano, str("updated"))
	return ch
}

func (s *qdrantStore) Search(ctx context.Context, project string, c Collection, vecs [][]float32, k int, f Filter, withText bool) ([][]Hit, error) {
	filter := qdrantFilter(project, c.Name, f, nil)
	var payload any = true
	if !withText {
		payload = map[string]any{"exclude": []string{"text"}}
	}
	searches := make([]any, len(vecs))
	for i, v := range vecs {
		q := map[string]any{"query": v, "limit": k, "with_payload": payload, "params": map[string]any{"hnsw_ef": max(64, 2*k)}}
		if filter != nil {
			q["filter"] = filter
		}
		searches[i] = q
	}
	var r []struct {
		Points []qdrantPoint `json:"points"`
	}
	if err := s.do(ctx, s.key, http.MethodPost, "/collections/"+qdrantCollection(project, c.Name)+"/points/query/batch",
		map[string]any{"searches": searches}, &r); err != nil {
		return nil, err
	}
	out := make([][]Hit, len(vecs))
	for i := range r {
		if i >= len(out) {
			break
		}
		for _, p := range r[i].Points {
			out[i] = append(out[i], Hit{Chunk: p.chunk(), Score: p.Score})
		}
	}
	return out, nil
}

func (s *qdrantStore) Get(ctx context.Context, project string, c Collection, ids []string) ([]Chunk, error) {
	pids := make([]string, len(ids))
	for i, id := range ids {
		pids[i] = pointID(project, c.Name, id)
	}
	var points []qdrantPoint
	if err := s.do(ctx, s.key, http.MethodPost, "/collections/"+qdrantCollection(project, c.Name)+"/points",
		map[string]any{"ids": pids, "with_payload": true}, &points); err != nil {
		return nil, err
	}
	out := make([]Chunk, 0, len(points))
	for _, p := range points {
		out = append(out, p.chunk())
	}
	return out, nil
}

func (s *qdrantStore) Delete(ctx context.Context, project string, c Collection, ids []string, f Filter) (int64, error) {
	filter := qdrantFilter(project, c.Name, f, ids)
	if filter == nil {
		return 0, errors.New("delete needs ids or a filter")
	}
	coll := qdrantCollection(project, c.Name)
	n, err := s.count(ctx, coll, filter)
	if err != nil {
		return 0, err
	}
	if n == 0 {
		return 0, nil
	}
	return n, s.do(ctx, s.key, http.MethodPost, "/collections/"+coll+"/points/delete?wait=true", map[string]any{"filter": filter}, nil)
}

// The operations of a direct query on Qdrant: its API's, on a collection
// of the project, the reads with read and the payload's changes and the
// deletes with write.
var qdrantOps = map[string]struct {
	method, path string
	write, limit bool
}{
	"query":          {http.MethodPost, "/points/query", false, true},
	"query_groups":   {http.MethodPost, "/points/query/groups", false, true},
	"scroll":         {http.MethodPost, "/points/scroll", false, true},
	"count":          {http.MethodPost, "/points/count", false, false},
	"facet":          {http.MethodPost, "/facet", false, true},
	"retrieve":       {http.MethodPost, "/points", false, false},
	"matrix_pairs":   {http.MethodPost, "/points/search/matrix/pairs", false, false},
	"matrix_offsets": {http.MethodPost, "/points/search/matrix/offsets", false, false},
	"info":           {http.MethodGet, "", false, false},

	"set_payload":       {http.MethodPost, "/points/payload", true, false},
	"overwrite_payload": {http.MethodPut, "/points/payload", true, false},
	"delete_payload":    {http.MethodPost, "/points/payload/delete", true, false},
	"delete_points":     {http.MethodPost, "/points/delete", true, false},
}

// qdrantQuerier runs the direct queries, with DB_QUERY_KEY when given (a
// key whoever runs Qdrant made for them), else the plugin's: either way
// only on the project's collections and the operations DB_QUERY allows.
type qdrantQuerier struct {
	s     *qdrantStore
	env   Env
	key   string
	write bool
}

func (q *qdrantQuerier) Close() {}

func (q *qdrantQuerier) Query(ctx context.Context, project string, dq DirectQuery) (*QueryResult, error) {
	op, ok := qdrantOps[dq.Op]
	if !ok {
		names := make([]string, 0, len(qdrantOps))
		for n, o := range qdrantOps {
			if !o.write || q.write {
				names = append(names, n)
			}
		}
		return nil, fmt.Errorf("op %q: one of %s", dq.Op, strings.Join(sortedStrings(names), ", "))
	}
	if op.write && !q.write {
		return nil, fmt.Errorf("op %s changes the collection, and DB_QUERY is read", dq.Op)
	}
	list, err := q.s.Collections(ctx, project)
	if err != nil {
		return nil, err
	}
	mine := map[string]bool{}
	for _, c := range list {
		mine[c.Name] = true
	}
	if !mine[dq.Collection] {
		return nil, fmt.Errorf("project %q has no collection %q", project, dq.Collection)
	}
	body, err := qdrantBody(dq.Body, project, mine, dq.Embedded)
	if err != nil {
		return nil, err
	}
	if op.limit {
		if n, ok := body["limit"].(float64); !ok || int(n) > q.env.QueryRows {
			body["limit"] = q.env.QueryRows
		}
	}
	var payload any = body
	if op.method == http.MethodGet {
		payload = nil
	}
	var raw json.RawMessage
	if err := q.s.do(ctx, q.key, op.method, "/collections/"+qdrantCollection(project, dq.Collection)+op.path, payload, &raw); err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("the query took longer than the limit")
		}
		return nil, err
	}
	if !dq.Vectors {
		var v any
		if json.Unmarshal(raw, &v) == nil {
			if b, err := json.Marshal(hideVectors(v)); err == nil {
				raw = b
			}
		}
	}
	if len(raw) > q.env.QueryBytes {
		return nil, fmt.Errorf("the result is %d bytes, more than %d (DB_QUERY_BYTES): ask for fewer points", len(raw), q.env.QueryBytes)
	}
	return &QueryResult{Result: raw}, nil
}

// qdrantBody is a body with the project's names for its collections, the
// vectors of embed in place of their "$name", and a reference to a
// collection of another project refused.
func qdrantBody(in map[string]any, project string, mine map[string]bool, vecs map[string][]float32) (map[string]any, error) {
	if in == nil {
		in = map[string]any{}
	}
	var walk func(v any) (any, error)
	walk = func(v any) (any, error) {
		switch x := v.(type) {
		case map[string]any:
			out := make(map[string]any, len(x))
			for k, e := range x {
				if s, ok := e.(string); ok && (k == "collection" || k == "with_lookup") {
					if !mine[s] {
						return nil, fmt.Errorf("the body names the collection %q, which is no collection of the project", s)
					}
					out[k] = qdrantCollection(project, s)
					continue
				}
				w, err := walk(e)
				if err != nil {
					return nil, err
				}
				out[k] = w
			}
			return out, nil
		case []any:
			out := make([]any, len(x))
			for i, e := range x {
				w, err := walk(e)
				if err != nil {
					return nil, err
				}
				out[i] = w
			}
			return out, nil
		case string:
			if strings.HasPrefix(x, "$") {
				if v, ok := vecs[x[1:]]; ok {
					return v, nil
				}
			}
			return x, nil
		}
		return v, nil
	}
	out, err := walk(in)
	if err != nil {
		return nil, err
	}
	return out.(map[string]any), nil
}

// hideVectors puts a vector's size in place of its numbers.
func hideVectors(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			if k == "vector" {
				x[k] = vectorShape(e)
				continue
			}
			x[k] = hideVectors(e)
		}
		return x
	case []any:
		for i, e := range x {
			x[i] = hideVectors(e)
		}
		return x
	}
	return v
}

func vectorShape(v any) any {
	switch x := v.(type) {
	case []any:
		return map[string]any{"vector": len(x)}
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			out[k] = vectorShape(e)
		}
		return out
	}
	return v
}

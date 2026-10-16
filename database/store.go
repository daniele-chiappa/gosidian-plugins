package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Collection is a collection of chunks of a project: their vectors come
// from one model, at one size.
type Collection struct {
	Name    string    `json:"name"`
	Model   string    `json:"model"`
	Dims    int       `json:"dims"`
	Created time.Time `json:"created"`
	Count   int64     `json:"count"`
}

// Chunk is a piece of a document, cut by whoever calls the plugin: the
// plugin keeps it, with where it comes from (doc), the chunk it is part of
// (parent) and its level, for a cut on several levels.
type Chunk struct {
	ID      string         `json:"id"`
	Text    string         `json:"text,omitempty"`
	Title   string         `json:"title,omitempty"`
	Doc     string         `json:"doc,omitempty"`
	Parent  string         `json:"parent,omitempty"`
	Level   int            `json:"level,omitempty"`
	Meta    map[string]any `json:"meta,omitempty"`
	Updated time.Time      `json:"updated,omitzero"`
	Vector  []float32      `json:"-"`
	// Fingerprint is that of the model's definition that made Vector
	// (Model.fingerprint): empty for a chunk stored before 0.3.0, or given
	// with its vector and none.
	Fingerprint string `json:"-"`
}

// SearchOptions shape a search: WithText gives the chunks' text; Exact
// compares each vector with every chunk the filter keeps instead of going
// through the index; EF, when set, is the breadth of the HNSW search
// (Postgres hnsw.ef_search, Qdrant hnsw_ef), more finding more, slower.
type SearchOptions struct {
	WithText bool
	Exact    bool
	EF       int
}

// Hit is a chunk found for a question: its score is the cosine
// similarity, 1 for the same direction; RerankScore, with a rerank, the
// reranker's.
type Hit struct {
	Chunk
	Score       float64  `json:"score"`
	RerankScore *float64 `json:"rerank_score,omitempty"`
}

// Filter narrows a search, a list, an update or a delete: every field it
// sets must hold.
type Filter struct {
	Docs    []string
	Parents []string
	Levels  []int
	// Meta are top-level keys of a chunk's meta and the values they must
	// have (strings, numbers, booleans).
	Meta map[string]any
	// Conds are the other conditions on keys of the meta, in the order of
	// their keys.
	Conds []MetaCond
}

// MetaCond is a condition on a top-level key of a chunk's meta other than
// equality: ne (a chunk without the key holds it too), in (a list of
// values), or a comparison of numbers, gt, gte, lt, lte (a chunk whose
// value is no number fails it).
type MetaCond struct {
	Key   string
	Op    string
	Value any
}

func (f Filter) empty() bool {
	return len(f.Docs) == 0 && len(f.Parents) == 0 && len(f.Levels) == 0 && len(f.Meta) == 0 && len(f.Conds) == 0
}

// The comparisons of numbers, with their symbol in SQL and jsonpath.
var compareOps = map[string]string{"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}

// metaKey is a key a condition or an update names: it goes in a path of
// JSON, so letters, digits, _ and - only.
var metaKey = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Store is a database of collections, each project's apart.
type Store interface {
	Collections(ctx context.Context, project string) ([]Collection, error)
	Collection(ctx context.Context, project, name string) (Collection, bool, error)
	Create(ctx context.Context, project string, c Collection) error
	Drop(ctx context.Context, project, name string) error
	Upsert(ctx context.Context, project string, c Collection, chunks []Chunk) error
	// Search finds the k chunks nearest each vector.
	Search(ctx context.Context, project string, c Collection, vecs [][]float32, k int, f Filter, o SearchOptions) ([][]Hit, error)
	Get(ctx context.Context, project string, c Collection, ids []string) ([]Chunk, error)
	// List gives up to limit chunks of a filter, with their vectors only
	// when withVectors (as stored, to copy them into another archive), from
	// the cursor after on (empty: the first page), and the cursor of the
	// next page (empty after the last).
	List(ctx context.Context, project string, c Collection, f Filter, after string, limit int, withText, withVectors bool) ([]Chunk, string, error)
	// Resume is the cursor of a page that starts at next, the chunk after
	// last in a page of List: for a page cut short.
	Resume(project string, c Collection, last, next Chunk) string
	// Count is how many chunks a filter holds.
	Count(ctx context.Context, project string, c Collection, f Filter) (int64, error)
	// Update changes keys of the meta of the chunks of ids and f (a nil
	// value removes the key), keeping their text and vectors. It changes
	// none when it would make the meta of one larger than maxMeta bytes of
	// JSON (metaTooLarge).
	Update(ctx context.Context, project string, c Collection, ids []string, f Filter, meta map[string]any, maxMeta int) (int64, error)
	// Refresh writes the doc, parent, level, title and meta of chunks
	// already stored, keeping their text, vectors and fingerprint.
	Refresh(ctx context.Context, project string, c Collection, chunks []Chunk) error
	Delete(ctx context.Context, project string, c Collection, ids []string, f Filter) (int64, error)
	// Sample draws up to limit chunks with their vectors, the same ones
	// from one call to the next, and the collection's count, for a graph.
	Sample(ctx context.Context, project string, c Collection, limit int) ([]Chunk, int64, error)
	Close() error
}

// projectKey names a project's place in a database: lower-case letters,
// digits and _, with a hash of the name, so two projects whose names
// differ only in other characters stay apart.
func projectKey(project string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(project) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	s := strings.Trim(b.String(), "_")
	if len(s) > 40 {
		s = s[:40]
	}
	sum := sha256.Sum256([]byte(project))
	return s + "_" + hex.EncodeToString(sum[:4])
}

// parseFilter reads a filter: doc, parent (a string or a list), level (a
// number or a list) and meta (an object whose keys hold a scalar, which
// they must equal, or an object of operators); an in has up to maxIn
// values (limits.max_in).
func parseFilter(v any, maxIn int) (Filter, error) {
	var f Filter
	if v == nil {
		return f, nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return f, fmt.Errorf("filter is an object with doc, parent, level, meta")
	}
	var err error
	for k, x := range m {
		switch k {
		case "doc":
			f.Docs, err = strings1(k, x)
		case "parent":
			f.Parents, err = strings1(k, x)
		case "level":
			f.Levels, err = ints1(k, x)
		case "meta":
			mm, ok := x.(map[string]any)
			if !ok {
				return f, fmt.Errorf("filter.meta is an object of keys and values")
			}
			f.Meta, f.Conds, err = parseMeta(mm, maxIn)
		default:
			return f, fmt.Errorf("filter.%s: the filter has doc, parent, level, meta", k)
		}
		if err != nil {
			return f, err
		}
	}
	return f, nil
}

// scalar is a value a key of the meta can be compared with: what JSON
// decodes to, and the integers of a caller in Go.
func scalar(v any) bool {
	switch v.(type) {
	case string, float64, bool, json.Number, int, int64:
		return true
	}
	return false
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

// parseMeta reads filter.meta: a scalar is the value a key must have, an
// object its operators ({"gte": 1, "lt": 9}, {"in": ["a", "b"]}).
func parseMeta(mm map[string]any, maxIn int) (map[string]any, []MetaCond, error) {
	eq := map[string]any{}
	var conds []MetaCond
	for _, k := range sortedKeys(mm) {
		mv := mm[k]
		if scalar(mv) {
			eq[k] = mv
			continue
		}
		ops, ok := mv.(map[string]any)
		if !ok || len(ops) == 0 {
			return nil, nil, fmt.Errorf("filter.meta.%s: a string, a number, a boolean, or an object of operators (eq, ne, in, gt, gte, lt, lte)", k)
		}
		if !metaKey.MatchString(k) {
			return nil, nil, fmt.Errorf("filter.meta: the key %q, with operators, has characters other than letters, digits, _ and -", k)
		}
		for _, op := range sortedKeys(ops) {
			val := ops[op]
			switch {
			case op == "eq" || op == "ne":
				if !scalar(val) {
					return nil, nil, fmt.Errorf("filter.meta.%s.%s: a string, a number or a boolean", k, op)
				}
				if op == "eq" {
					if prev, ok := eq[k]; ok && prev != val {
						return nil, nil, fmt.Errorf("filter.meta.%s: two values to equal", k)
					}
					eq[k] = val
					continue
				}
			case op == "in":
				list, ok := val.([]any)
				if !ok || len(list) == 0 || len(list) > maxIn {
					return nil, nil, fmt.Errorf("filter.meta.%s.in: a list of 1 to %d values (limits.max_in)", k, maxIn)
				}
				for _, e := range list {
					if !scalar(e) {
						return nil, nil, fmt.Errorf("filter.meta.%s.in: strings, numbers or booleans", k)
					}
				}
			case compareOps[op] != "":
				n, ok := number(val)
				if !ok {
					return nil, nil, fmt.Errorf("filter.meta.%s.%s: a number", k, op)
				}
				val = n
			default:
				return nil, nil, fmt.Errorf("filter.meta.%s: the operator %q; eq, ne, in, gt, gte, lt or lte", k, op)
			}
			conds = append(conds, MetaCond{Key: k, Op: op, Value: val})
		}
	}
	if len(eq) == 0 {
		eq = nil
	}
	return eq, conds, nil
}

// parseMetaUpdate reads the meta of an update: the keys to set, and those
// to remove (null), up to limits.max_update_keys of them and
// limits.max_meta bytes.
func parseMetaUpdate(v any, lim Limits) (map[string]any, error) {
	m, ok := v.(map[string]any)
	if !ok || len(m) == 0 {
		return nil, errors.New("meta: an object of the keys to set (null removes one)")
	}
	if len(m) > lim.MaxUpdateKeys {
		return nil, fmt.Errorf("meta: %d keys, at most %d (limits.max_update_keys)", len(m), lim.MaxUpdateKeys)
	}
	for k := range m {
		if !metaKey.MatchString(k) {
			return nil, fmt.Errorf("meta: the key %q has characters other than letters, digits, _ and -", k)
		}
	}
	if b, _ := json.Marshal(m); len(b) > lim.MaxMeta {
		return nil, fmt.Errorf("meta: %d bytes, more than limits.max_meta (%d)", len(b), lim.MaxMeta)
	}
	return m, nil
}

// metaTooLarge is the error of an update that would make the meta of the
// chunk id size bytes, over max.
func metaTooLarge(id string, size, max int) error {
	return fmt.Errorf("meta: the update makes the meta of %s %d bytes, more than limits.max_meta (%d): nothing changed", id, size, max)
}

// mergedMetaSize is the size in bytes of JSON of the meta an update makes
// of old, and whether that is over max: larger than max and than old.
// Qdrant's update checks with it; PostgreSQL's and SQLite's apply the same
// rule in their SQL. An update that does not make a meta larger passes, so
// one over a cap lowered since can still shrink.
func mergedMetaSize(old, set map[string]any, remove []string, max int) (int, bool) {
	merged := make(map[string]any, len(old)+len(set))
	for k, v := range old {
		merged[k] = v
	}
	for k, v := range set {
		merged[k] = v
	}
	for _, k := range remove {
		delete(merged, k)
	}
	before, _ := json.Marshal(old)
	after, _ := json.Marshal(merged)
	if len(old) == 0 {
		before = []byte("{}")
	}
	return len(after), len(after) > max && len(after) > len(before)
}

// splitUpdate is an update's keys to set, by name, and the sorted keys
// to remove.
func splitUpdate(meta map[string]any) (map[string]any, []string) {
	set := map[string]any{}
	var remove []string
	for _, k := range sortedKeys(meta) {
		if meta[k] == nil {
			remove = append(remove, k)
		} else {
			set[k] = meta[k]
		}
	}
	return set, remove
}

// andWhere adds a condition to a WHERE clause, made or empty.
func andWhere(where, cond string) string {
	if where == "" {
		return " WHERE " + cond
	}
	return where + " AND " + cond
}

func strings1(name string, x any) ([]string, error) {
	switch v := x.(type) {
	case string:
		return []string{v}, nil
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			s, ok := e.(string)
			if !ok {
				return nil, fmt.Errorf("filter.%s: strings", name)
			}
			out = append(out, s)
		}
		return out, nil
	}
	return nil, fmt.Errorf("filter.%s: a string or a list of strings", name)
}

func ints1(name string, x any) ([]int, error) {
	one := func(e any) (int, bool) {
		f, ok := e.(float64)
		return int(f), ok && f == float64(int(f))
	}
	if n, ok := one(x); ok {
		return []int{n}, nil
	}
	if v, ok := x.([]any); ok {
		out := make([]int, 0, len(v))
		for _, e := range v {
			n, ok := one(e)
			if !ok {
				return nil, fmt.Errorf("filter.%s: whole numbers", name)
			}
			out = append(out, n)
		}
		return out, nil
	}
	return nil, fmt.Errorf("filter.%s: a whole number or a list", name)
}

// vectorText is a vector as pgvector and sqlite-vec read it: [0.1,0.2,…].
func vectorText(v []float32) string {
	var b strings.Builder
	b.Grow(len(v) * 10)
	b.WriteByte('[')
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(x), 'g', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
}

// Hit is a chunk found for a question: its score is the cosine
// similarity, 1 for the same direction.
type Hit struct {
	Chunk
	Score float64 `json:"score"`
}

// Filter narrows a search or a delete: every field it sets must hold.
type Filter struct {
	Docs    []string
	Parents []string
	Levels  []int
	// Meta are top-level keys of a chunk's meta and the values they must
	// have (strings, numbers, booleans).
	Meta map[string]any
}

func (f Filter) empty() bool {
	return len(f.Docs) == 0 && len(f.Parents) == 0 && len(f.Levels) == 0 && len(f.Meta) == 0
}

// Store is a database of collections, each project's apart.
type Store interface {
	Collections(ctx context.Context, project string) ([]Collection, error)
	Collection(ctx context.Context, project, name string) (Collection, bool, error)
	Create(ctx context.Context, project string, c Collection) error
	Drop(ctx context.Context, project, name string) error
	Upsert(ctx context.Context, project string, c Collection, chunks []Chunk) error
	Search(ctx context.Context, project string, c Collection, vecs [][]float32, k int, f Filter, withText bool) ([][]Hit, error)
	Get(ctx context.Context, project string, c Collection, ids []string) ([]Chunk, error)
	Delete(ctx context.Context, project string, c Collection, ids []string, f Filter) (int64, error)
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
// number or a list) and meta (an object of scalars).
func parseFilter(v any) (Filter, error) {
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
			for mk, mv := range mm {
				switch mv.(type) {
				case string, float64, bool, json.Number:
				default:
					return f, fmt.Errorf("filter.meta.%s: a string, a number or a boolean", mk)
				}
			}
			f.Meta = mm
		default:
			return f, fmt.Errorf("filter.%s: the filter has doc, parent, level, meta", k)
		}
		if err != nil {
			return f, err
		}
	}
	return f, nil
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

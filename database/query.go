package main

import (
	"context"
	"encoding/json"
)

// DirectQuery is a query in the database's own language: SQL for
// PostgreSQL and SQLite, an operation of Qdrant's API for Qdrant.
type DirectQuery struct {
	SQL string
	// Params are the SQL's named arguments (@name in PostgreSQL, :name in
	// SQLite), the vectors of embed among them.
	Params map[string]any
	// Vectors shows the vectors of a result in full, not their size.
	Vectors bool

	Op         string
	Collection string
	Body       map[string]any
	// Embedded are the vectors of embed, for a Qdrant body's "$name".
	Embedded map[string][]float32
}

// QueryResult is what a direct query gives: rows, or Qdrant's result.
type QueryResult struct {
	Columns   []string          `json:"columns,omitempty"`
	Rows      []json.RawMessage `json:"rows,omitempty"`
	Truncated bool              `json:"truncated,omitempty"`
	Command   string            `json:"command,omitempty"`
	Result    json.RawMessage   `json:"result,omitempty"`
}

// Querier runs the direct queries of a store.
type Querier interface {
	Query(ctx context.Context, project string, dq DirectQuery) (*QueryResult, error)
	Close()
}

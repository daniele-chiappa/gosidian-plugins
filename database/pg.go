package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pgStore keeps the collections in PostgreSQL with pgvector. A project is
// a schema, p_<key>, with a table per collection (_c_<name>) and a view by
// the collection's name, which the direct queries read; gosidian_meta
// lists the collections.
type pgStore struct {
	pool *pgxpool.Pool
	user string
}

// The column types pgvector indexes: vector up to 2000 dimensions,
// halfvec up to 4000; above, halfvec with an index on the binary
// quantization and a reranking of its candidates.
const (
	pgVector   = "vector"
	pgHalfvec  = "halfvec"
	pgBitIndex = "halfvec-bit"
	// bitRerank is how many candidates per result the binary index gives
	// the exact reranking.
	bitRerank = 10
)

func pgType(dims int) string {
	switch {
	case dims <= 2000:
		return pgVector
	case dims <= 4000:
		return pgHalfvec
	default:
		return pgBitIndex
	}
}

func pgColumn(dims int) string {
	if pgType(dims) == pgVector {
		return fmt.Sprintf("vector(%d)", dims)
	}
	return fmt.Sprintf("halfvec(%d)", dims)
}

func pgCast(dims int) string {
	if pgType(dims) == pgVector {
		return "::vector"
	}
	return "::halfvec"
}

func openPostgres(ctx context.Context, sc StoreConfig, password string) (*pgStore, error) {
	pc, err := pgxpool.ParseConfig(sc.URL)
	if err != nil {
		return nil, fmt.Errorf("store.url: %w", err)
	}
	if password != "" {
		pc.ConnConfig.Password = password
	}
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, err
	}
	s := &pgStore{pool: pool, user: pc.ConnConfig.User}
	// Several containers of the same database may start at once: the
	// first one makes the schema of the collections.
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		for _, q := range []string{
			`SELECT pg_advisory_xact_lock(7211900181)`,
			`CREATE EXTENSION IF NOT EXISTS vector`,
			`CREATE SCHEMA IF NOT EXISTS gosidian_meta`,
			`CREATE TABLE IF NOT EXISTS gosidian_meta.collections (
				project text NOT NULL, name text NOT NULL, model text NOT NULL, dims int NOT NULL,
				created timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project, name))`,
			`CREATE TABLE IF NOT EXISTS gosidian_meta.query_project (
				id int PRIMARY KEY CHECK (id = 1), project text NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
		} {
			if _, err := tx.Exec(ctx, q); err != nil {
				return fmt.Errorf("preparing the database: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		pool.Close()
		return nil, err
	}
	return s, nil
}

func (s *pgStore) Close() error {
	s.pool.Close()
	return nil
}

func pgSchema(project string) string { return pgx.Identifier{"p_" + projectKey(project)}.Sanitize() }

func pgTable(project, name string) string {
	return pgx.Identifier{"p_" + projectKey(project), "_c_" + name}.Sanitize()
}

func pgView(project, name string) string {
	return pgx.Identifier{"p_" + projectKey(project), name}.Sanitize()
}

func quoteLiteral(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func (s *pgStore) Collections(ctx context.Context, project string) ([]Collection, error) {
	rows, err := s.pool.Query(ctx, `SELECT name, model, dims, created FROM gosidian_meta.collections WHERE project = $1 ORDER BY name`, project)
	if err != nil {
		return nil, err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Collection, error) {
		var c Collection
		err := r.Scan(&c.Name, &c.Model, &c.Dims, &c.Created)
		return c, err
	})
	if err != nil {
		return nil, err
	}
	for i := range list {
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM `+pgTable(project, list[i].Name)).Scan(&list[i].Count); err != nil {
			return nil, err
		}
	}
	return list, nil
}

func (s *pgStore) Collection(ctx context.Context, project, name string) (Collection, bool, error) {
	c := Collection{Name: name}
	err := s.pool.QueryRow(ctx, `SELECT model, dims, created FROM gosidian_meta.collections WHERE project = $1 AND name = $2`, project, name).
		Scan(&c.Model, &c.Dims, &c.Created)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, false, nil
	}
	if err != nil {
		return c, false, err
	}
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM `+pgTable(project, name)).Scan(&c.Count)
	return c, true, err
}

func (s *pgStore) Create(ctx context.Context, project string, c Collection) error {
	t, view := pgTable(project, c.Name), pgView(project, c.Name)
	var index string
	switch pgType(c.Dims) {
	case pgVector:
		index = `USING hnsw (embedding vector_cosine_ops)`
	case pgHalfvec:
		index = `USING hnsw (embedding halfvec_cosine_ops)`
	default:
		index = fmt.Sprintf(`USING hnsw ((binary_quantize(embedding)::bit(%d)) bit_hamming_ops)`, c.Dims)
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		for _, q := range []string{
			`SELECT pg_advisory_xact_lock(7211900181)`,
			`CREATE SCHEMA IF NOT EXISTS ` + pgSchema(project),
			`CREATE TABLE ` + t + ` (id text PRIMARY KEY, doc text, parent text, level int NOT NULL DEFAULT 0,
				title text, text text NOT NULL, meta jsonb NOT NULL DEFAULT '{}', updated timestamptz NOT NULL DEFAULT now(),
				embedding ` + pgColumn(c.Dims) + ` NOT NULL)`,
			`CREATE INDEX ON ` + t + ` ` + index,
			`CREATE INDEX ON ` + t + ` (doc)`,
			`CREATE INDEX ON ` + t + ` (parent)`,
			`CREATE INDEX ON ` + t + ` USING gin (meta jsonb_path_ops)`,
			`CREATE VIEW ` + view + ` AS SELECT id, doc, parent, level, title, text, meta, updated, embedding FROM ` + t,
			`CREATE OR REPLACE VIEW ` + pgView(project, "collections") + ` AS
				SELECT name, model, dims, created FROM gosidian_meta.collections WHERE project = ` + quoteLiteral(project),
		} {
			if _, err := tx.Exec(ctx, q); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `INSERT INTO gosidian_meta.collections (project, name, model, dims) VALUES ($1, $2, $3, $4)`,
			project, c.Name, c.Model, c.Dims)
		return err
	})
}

func (s *pgStore) Drop(ctx context.Context, project, name string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		for _, q := range []string{
			`DROP VIEW IF EXISTS ` + pgView(project, name),
			`DROP TABLE IF EXISTS ` + pgTable(project, name),
		} {
			if _, err := tx.Exec(ctx, q); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `DELETE FROM gosidian_meta.collections WHERE project = $1 AND name = $2`, project, name)
		return err
	})
}

func metaJSON(m map[string]any) ([]byte, error) {
	if m == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(m)
}

func (s *pgStore) Upsert(ctx context.Context, project string, c Collection, chunks []Chunk) error {
	q := `INSERT INTO ` + pgTable(project, c.Name) + ` (id, doc, parent, level, title, text, meta, embedding, updated)
		VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4, NULLIF($5, ''), $6, $7::jsonb, $8` + pgCast(c.Dims) + `, now())
		ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, parent = excluded.parent, level = excluded.level,
		title = excluded.title, text = excluded.text, meta = excluded.meta, embedding = excluded.embedding, updated = now()`
	b := &pgx.Batch{}
	for _, ch := range chunks {
		meta, err := metaJSON(ch.Meta)
		if err != nil {
			return err
		}
		b.Queue(q, ch.ID, ch.Doc, ch.Parent, ch.Level, ch.Title, ch.Text, string(meta), vectorText(ch.Vector))
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		return tx.SendBatch(ctx, b).Close()
	})
}

// where is the SQL of a filter, its arguments numbered from n.
func pgWhere(f Filter, args []any) (string, []any) {
	var conds []string
	add := func(cond string, v any) {
		args = append(args, v)
		conds = append(conds, fmt.Sprintf(cond, len(args)))
	}
	if len(f.Docs) > 0 {
		add("doc = ANY($%d)", f.Docs)
	}
	if len(f.Parents) > 0 {
		add("parent = ANY($%d)", f.Parents)
	}
	if len(f.Levels) > 0 {
		add("level = ANY($%d)", f.Levels)
	}
	if len(f.Meta) > 0 {
		b, _ := json.Marshal(f.Meta)
		add("meta @> $%d::jsonb", string(b))
	}
	if len(conds) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

func pgColumns(withText bool) string {
	if withText {
		return "id, coalesce(doc, ''), coalesce(parent, ''), level, coalesce(title, ''), text, meta, updated"
	}
	return "id, coalesce(doc, ''), coalesce(parent, ''), level, coalesce(title, ''), '', meta, updated"
}

func scanChunk(r pgx.Row, extra ...any) (Chunk, error) {
	var ch Chunk
	var meta []byte
	dest := append([]any{&ch.ID, &ch.Doc, &ch.Parent, &ch.Level, &ch.Title, &ch.Text, &meta, &ch.Updated}, extra...)
	if err := r.Scan(dest...); err != nil {
		return ch, err
	}
	if len(meta) > 0 && string(meta) != "{}" {
		if err := json.Unmarshal(meta, &ch.Meta); err != nil {
			return ch, err
		}
	}
	return ch, nil
}

func (s *pgStore) Search(ctx context.Context, project string, c Collection, vecs [][]float32, k int, f Filter, withText bool) ([][]Hit, error) {
	out := make([][]Hit, len(vecs))
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// A filter the index cannot follow would leave fewer than k
		// results: the iterative scan keeps looking (pgvector 0.8).
		for _, q := range []string{
			fmt.Sprintf(`SET LOCAL hnsw.ef_search = %d`, max(40, 2*k)),
			`SET LOCAL hnsw.iterative_scan = relaxed_order`,
		} {
			if _, err := tx.Exec(ctx, q); err != nil {
				return err
			}
		}
		for i, v := range vecs {
			where, args := pgWhere(f, []any{vectorText(v)})
			cast := pgCast(c.Dims)
			var q string
			if pgType(c.Dims) == pgBitIndex {
				q = fmt.Sprintf(`SELECT %s, 1 - (embedding <=> $1%s) FROM (SELECT * FROM %s%s
					ORDER BY binary_quantize(embedding)::bit(%d) <~> binary_quantize($1%s) LIMIT %d) c
					ORDER BY embedding <=> $1%s LIMIT %d`,
					pgColumns(withText), cast, pgTable(project, c.Name), where, c.Dims, cast, k*bitRerank, cast, k)
			} else {
				q = fmt.Sprintf(`SELECT %s, 1 - (embedding <=> $1%s) FROM %s%s ORDER BY embedding <=> $1%s LIMIT %d`,
					pgColumns(withText), cast, pgTable(project, c.Name), where, cast, k)
			}
			rows, err := tx.Query(ctx, q, args...)
			if err != nil {
				return err
			}
			hits, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Hit, error) {
				var h Hit
				ch, err := scanChunk(r, &h.Score)
				h.Chunk = ch
				return h, err
			})
			if err != nil {
				return err
			}
			out[i] = hits
		}
		return nil
	})
	return out, err
}

func (s *pgStore) Get(ctx context.Context, project string, c Collection, ids []string) ([]Chunk, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+pgColumns(true)+` FROM `+pgTable(project, c.Name)+` WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Chunk, error) { return scanChunk(r) })
}

func (s *pgStore) Delete(ctx context.Context, project string, c Collection, ids []string, f Filter) (int64, error) {
	var args []any
	where, args := pgWhere(f, args)
	if len(ids) > 0 {
		args = append(args, ids)
		cond := fmt.Sprintf("id = ANY($%d)", len(args))
		if where == "" {
			where = " WHERE " + cond
		} else {
			where += " AND " + cond
		}
	}
	if where == "" {
		return 0, errors.New("delete needs ids or a filter")
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM `+pgTable(project, c.Name)+where, args...)
	return tag.RowsAffected(), err
}

// pgError is a database error as the caller should read it: the message,
// without the connection details.
func pgError(err error) error {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		msg := pe.Message
		if pe.Detail != "" {
			msg += ": " + pe.Detail
		}
		return fmt.Errorf("postgres: %s (%s)", msg, pe.Code)
	}
	return err
}

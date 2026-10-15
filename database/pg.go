package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

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
	// ready are the tables given the columns of this version, by this
	// process (columns).
	ready sync.Map
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
	// pgMaxEF is the widest hnsw.ef_search pgvector takes.
	pgMaxEF = 1000
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
	if err := s.columns(ctx, pgTable(project, name)); err != nil {
		return c, true, err
	}
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM `+pgTable(project, name)).Scan(&c.Count)
	return c, true, err
}

// columns gives a collection's table the columns of this version, once per
// process: one made before 0.3.0 has no fingerprint, which a NULL then
// fills. The catalog is read first, as an ALTER TABLE locks the table even
// when it has the column.
func (s *pgStore) columns(ctx context.Context, table string) error {
	if _, ok := s.ready.Load(table); ok {
		return nil
	}
	var has bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_attribute
		WHERE attrelid = $1::regclass AND attname = 'fingerprint' AND NOT attisdropped)`, table).Scan(&has); err != nil {
		return err
	}
	if !has {
		if _, err := s.pool.Exec(ctx, `ALTER TABLE `+table+` ADD COLUMN IF NOT EXISTS fingerprint text`); err != nil {
			return fmt.Errorf("adding the fingerprint of the vectors to %s: %w", table, err)
		}
	}
	s.ready.Store(table, true)
	return nil
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
				embedding ` + pgColumn(c.Dims) + ` NOT NULL, fingerprint text)`,
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
	s.ready.Delete(pgTable(project, name))
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
	q := `INSERT INTO ` + pgTable(project, c.Name) + ` (id, doc, parent, level, title, text, meta, embedding, fingerprint, updated)
		VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4, NULLIF($5, ''), $6, $7::jsonb, $8` + pgCast(c.Dims) + `, NULLIF($9, ''), now())
		ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, parent = excluded.parent, level = excluded.level,
		title = excluded.title, text = excluded.text, meta = excluded.meta, embedding = excluded.embedding,
		fingerprint = excluded.fingerprint, updated = now()`
	b := &pgx.Batch{}
	for _, ch := range chunks {
		meta, err := metaJSON(ch.Meta)
		if err != nil {
			return err
		}
		b.Queue(q, ch.ID, ch.Doc, ch.Parent, ch.Level, ch.Title, ch.Text, string(meta), vectorText(ch.Vector), ch.Fingerprint)
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
	for _, mc := range f.Conds {
		switch mc.Op {
		case "ne":
			b, _ := json.Marshal(map[string]any{mc.Key: mc.Value})
			add("NOT (meta @> $%d::jsonb)", string(b))
		case "in":
			vals := make([]string, 0, len(mc.Value.([]any)))
			for _, v := range mc.Value.([]any) {
				b, _ := json.Marshal(v)
				vals = append(vals, string(b))
			}
			args = append(args, mc.Key, vals)
			conds = append(conds, fmt.Sprintf("(meta -> $%d::text) = ANY($%d::text[]::jsonb[])", len(args)-1, len(args)))
		default:
			// A jsonpath comparison is false, not an error, on a value that
			// is no number. The key is checked: letters, digits, _ and -.
			b, _ := json.Marshal(map[string]any{"v": mc.Value})
			args = append(args, `$."`+mc.Key+`" ? (@ `+compareOps[mc.Op]+` $v)`, string(b))
			conds = append(conds, fmt.Sprintf("jsonb_path_exists(meta, $%d::jsonpath, $%d::jsonb)", len(args)-1, len(args)))
		}
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

func (s *pgStore) Search(ctx context.Context, project string, c Collection, vecs [][]float32, k int, f Filter, o SearchOptions) ([][]Hit, error) {
	withText, exact := o.WithText, o.Exact
	// pgvector refuses a breadth over 1000, which 2k passes from a max_k
	// over 500 on; a search asking for more goes on with the iterative scan.
	ef := min(max(40, 2*k), pgMaxEF)
	if o.EF > 0 {
		ef = min(o.EF, pgMaxEF)
	}
	out := make([][]Hit, len(vecs))
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// A filter the index cannot follow would leave fewer than k
		// results: the iterative scan keeps looking (pgvector 0.8). Each
		// search is planned with its own values: after five runs of a
		// statement Postgres may keep a generic plan, which for a filter on
		// the meta read the whole table instead of the HNSW index. One
		// statement, with the breadth a parameter: a SET with it written in
		// was a statement of its own, prepared again, for each breadth.
		if _, err := tx.Exec(ctx, `SELECT set_config('hnsw.ef_search', $1, true),
			set_config('hnsw.iterative_scan', 'relaxed_order', true), set_config('plan_cache_mode', 'force_custom_plan', true)`,
			strconv.Itoa(ef)); err != nil {
			return err
		}
		// An exact search reads the chunks the filter keeps, not the HNSW
		// index (a bitmap of the meta's index may still pick them).
		if exact {
			if _, err := tx.Exec(ctx, `SET LOCAL enable_indexscan = off`); err != nil {
				return err
			}
		}
		for i, v := range vecs {
			where, args := pgWhere(f, []any{vectorText(v)})
			cast := pgCast(c.Dims)
			var q string
			if pgType(c.Dims) == pgBitIndex && !exact {
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
	rows, err := s.pool.Query(ctx, `SELECT `+pgColumns(true)+`, coalesce(fingerprint, '') FROM `+pgTable(project, c.Name)+` WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Chunk, error) {
		var fp string
		ch, err := scanChunk(r, &fp)
		ch.Fingerprint = fp
		return ch, err
	})
}

// pgWhereIDs is the WHERE clause of a filter and ids, its arguments
// numbered after those given.
func pgWhereIDs(f Filter, ids []string, args []any) (string, []any) {
	where, args := pgWhere(f, args)
	if len(ids) > 0 {
		args = append(args, ids)
		where = andWhere(where, fmt.Sprintf("id = ANY($%d)", len(args)))
	}
	return where, args
}

func (s *pgStore) Delete(ctx context.Context, project string, c Collection, ids []string, f Filter) (int64, error) {
	where, args := pgWhereIDs(f, ids, nil)
	if where == "" {
		return 0, errors.New("delete needs ids or a filter")
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM `+pgTable(project, c.Name)+where, args...)
	return tag.RowsAffected(), err
}

// Resume goes on after the last chunk given: pages follow the ids.
func (s *pgStore) Resume(_ string, _ Collection, last, _ Chunk) string { return last.ID }

func (s *pgStore) List(ctx context.Context, project string, c Collection, f Filter, after string, limit int, withText, withVectors bool) ([]Chunk, string, error) {
	where, args := pgWhere(f, nil)
	if after != "" {
		args = append(args, after)
		where = andWhere(where, fmt.Sprintf("id > $%d", len(args)))
	}
	args = append(args, limit+1)
	cols := pgColumns(withText)
	if withVectors {
		cols += ", coalesce(fingerprint, ''), embedding::text"
	}
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`SELECT %s FROM %s%s ORDER BY id LIMIT $%d`,
		cols, pgTable(project, c.Name), where, len(args)), args...)
	if err != nil {
		return nil, "", err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Chunk, error) {
		if !withVectors {
			return scanChunk(r)
		}
		var fp, vec string
		ch, err := scanChunk(r, &fp, &vec)
		if err != nil {
			return ch, err
		}
		ch.Fingerprint = fp
		// As stored: pgvector writes a float4 in its shortest exact form.
		ch.Vector, err = parseVectorText(vec)
		return ch, err
	})
	if err != nil || len(out) <= limit {
		return out, "", err
	}
	return out[:limit], out[limit-1].ID, nil
}

func (s *pgStore) Count(ctx context.Context, project string, c Collection, f Filter) (int64, error) {
	where, args := pgWhere(f, nil)
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM `+pgTable(project, c.Name)+where, args...).Scan(&n)
	return n, err
}

// Update checks first, in its transaction, that no meta it makes grows
// over maxMeta, measured as Postgres writes jsonb as text (a space after
// each : and ,), then changes them all in one statement.
func (s *pgStore) Update(ctx context.Context, project string, c Collection, ids []string, f Filter, meta map[string]any, maxMeta int) (int64, error) {
	set, remove := splitUpdate(meta)
	b, err := json.Marshal(set)
	if err != nil {
		return 0, err
	}
	if remove == nil {
		remove = []string{}
	}
	where, args := pgWhereIDs(f, ids, []any{string(b), remove})
	if where == "" {
		return 0, errors.New("update needs ids or a filter")
	}
	const merged = `((meta || $1::jsonb) - $2::text[])`
	t := pgTable(project, c.Name)
	var n int64
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		check := append(append([]any(nil), args...), maxMeta)
		var id string
		var size int
		err := tx.QueryRow(ctx, fmt.Sprintf(`SELECT id, octet_length(%[1]s::text) FROM %[2]s%[3]s
			AND octet_length(%[1]s::text) > $%[4]d AND octet_length(%[1]s::text) > octet_length(meta::text) LIMIT 1`,
			merged, t, where, len(check)), check...).Scan(&id, &size)
		switch {
		case err == nil:
			return metaTooLarge(id, size, maxMeta)
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE `+t+` SET meta = `+merged+`, updated = now()`+where, args...)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		return 0, err
	}
	return n, nil
}

func (s *pgStore) Refresh(ctx context.Context, project string, c Collection, chunks []Chunk) error {
	q := `UPDATE ` + pgTable(project, c.Name) + ` SET doc = NULLIF($2, ''), parent = NULLIF($3, ''), level = $4,
		title = NULLIF($5, ''), meta = $6::jsonb, updated = now() WHERE id = $1`
	b := &pgx.Batch{}
	for _, ch := range chunks {
		meta, err := metaJSON(ch.Meta)
		if err != nil {
			return err
		}
		b.Queue(q, ch.ID, ch.Doc, ch.Parent, ch.Level, ch.Title, string(meta))
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		return tx.SendBatch(ctx, b).Close()
	})
}

func (s *pgStore) Sample(ctx context.Context, project string, c Collection, limit int) ([]Chunk, int64, error) {
	var total int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM `+pgTable(project, c.Name)).Scan(&total); err != nil {
		return nil, 0, err
	}
	// md5 of the id orders the chunks at random, and the same way each time.
	rows, err := s.pool.Query(ctx, `SELECT id, coalesce(doc, ''), coalesce(parent, ''), level, coalesce(title, ''), left(text, 600), meta, updated, embedding::text
		FROM `+pgTable(project, c.Name)+` ORDER BY md5(id) LIMIT $1`, limit)
	if err != nil {
		return nil, 0, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Chunk, error) {
		var vec string
		ch, err := scanChunk(r, &vec)
		if err != nil {
			return ch, err
		}
		v, err := parseVectorText(vec)
		ch.Vector = renormalize(v)
		return ch, err
	})
	return out, total, err
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

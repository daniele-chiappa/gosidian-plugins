package main

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/mattn/go-sqlite3"
)

// sqliteStore keeps each project's collections in a file of its own,
// <path>/<key>.db: a table per collection, by its name, with the vectors
// as float32 BLOBs that sqlite-vec compares (an exact search: fine up to
// some tens of thousands of chunks), and _collections with the view
// collections.
type sqliteStore struct {
	dir string

	mu  sync.Mutex
	dbs map[string]*sql.DB
}

// The drivers: one loading sqlite-vec, one for the direct queries with an
// authorizer, read-only or not. The extension's path is the preset's,
// known only at run time.
var registerDrivers sync.Once

const (
	driverSQLite      = "gosidian_sqlite"
	driverSQLiteRead  = "gosidian_sqlite_read"
	driverSQLiteWrite = "gosidian_sqlite_write"
)

// The operations of SQLite's authorizer (sqlite3.h); mattn leaves out
// SQLITE_RECURSIVE.
const sqliteRecursive = 33

func registerSQLite(ext string) {
	registerDrivers.Do(func() {
		sql.Register(driverSQLite, &sqlite3.SQLiteDriver{Extensions: []string{ext}})
		sql.Register(driverSQLiteRead, &sqlite3.SQLiteDriver{Extensions: []string{ext},
			ConnectHook: func(c *sqlite3.SQLiteConn) error { c.RegisterAuthorizer(sqliteAuthorizer(false)); return nil }})
		sql.Register(driverSQLiteWrite, &sqlite3.SQLiteDriver{Extensions: []string{ext},
			ConnectHook: func(c *sqlite3.SQLiteConn) error { c.RegisterAuthorizer(sqliteAuthorizer(true)); return nil }})
	})
}

// sqliteAuthorizer lets a direct query read, and with write change rows:
// no schema change, no pragma, no other file attached.
func sqliteAuthorizer(write bool) func(int, string, string, string) int {
	return func(op int, _, _, _ string) int {
		switch op {
		case sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqliteRecursive:
			return sqlite3.SQLITE_OK
		case sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE:
			if write {
				return sqlite3.SQLITE_OK
			}
		}
		return sqlite3.SQLITE_DENY
	}
}

func openSQLite(sc StoreConfig) (*sqliteStore, error) {
	if _, err := os.Stat(sc.Extension + ".so"); err != nil {
		if _, err2 := os.Stat(sc.Extension); err2 != nil {
			return nil, fmt.Errorf("store.extension: sqlite-vec is not at %s(.so)", sc.Extension)
		}
	}
	if err := os.MkdirAll(sc.Path, 0o700); err != nil {
		return nil, err
	}
	registerSQLite(sc.Extension)
	return &sqliteStore{dir: sc.Path, dbs: map[string]*sql.DB{}}, nil
}

func (s *sqliteStore) file(project string) string {
	return filepath.Join(s.dir, projectKey(project)+".db")
}

func (s *sqliteStore) db(ctx context.Context, project string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if db, ok := s.dbs[project]; ok {
		return db, nil
	}
	db, err := sql.Open(driverSQLite, "file:"+s.file(project)+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS _collections (name TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, created TEXT NOT NULL)`,
		`CREATE VIEW IF NOT EXISTS collections AS SELECT name, model, dims, created FROM _collections`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			db.Close()
			return nil, err
		}
	}
	s.dbs[project] = db
	return db, nil
}

func (s *sqliteStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, db := range s.dbs {
		db.Close()
	}
	return nil
}

func sqliteIdent(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

func (s *sqliteStore) Collections(ctx context.Context, project string) ([]Collection, error) {
	db, err := s.db(ctx, project)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT name, model, dims, created FROM _collections ORDER BY name`)
	if err != nil {
		return nil, err
	}
	var list []Collection
	for rows.Next() {
		var c Collection
		var created string
		if err := rows.Scan(&c.Name, &c.Model, &c.Dims, &created); err != nil {
			rows.Close()
			return nil, err
		}
		c.Created, _ = time.Parse(time.RFC3339Nano, created)
		list = append(list, c)
	}
	rows.Close()
	for i := range list {
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM `+sqliteIdent(list[i].Name)).Scan(&list[i].Count); err != nil {
			return nil, err
		}
	}
	return list, rows.Err()
}

func (s *sqliteStore) Collection(ctx context.Context, project, name string) (Collection, bool, error) {
	list, err := s.Collections(ctx, project)
	if err != nil {
		return Collection{}, false, err
	}
	for _, c := range list {
		if c.Name == name {
			return c, true, nil
		}
	}
	return Collection{Name: name}, false, nil
}

func (s *sqliteStore) Create(ctx context.Context, project string, c Collection) error {
	db, err := s.db(ctx, project)
	if err != nil {
		return err
	}
	t := sqliteIdent(c.Name)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`CREATE TABLE ` + t + ` (id TEXT PRIMARY KEY, doc TEXT, parent TEXT, level INTEGER NOT NULL DEFAULT 0,
			title TEXT, text TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL, embedding BLOB NOT NULL)`,
		`CREATE INDEX ` + sqliteIdent(c.Name+"_doc") + ` ON ` + t + ` (doc)`,
		`CREATE INDEX ` + sqliteIdent(c.Name+"_parent") + ` ON ` + t + ` (parent)`,
	} {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO _collections (name, model, dims, created) VALUES (?, ?, ?, ?)`,
		c.Name, c.Model, c.Dims, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *sqliteStore) Drop(ctx context.Context, project, name string) error {
	db, err := s.db(ctx, project)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DROP TABLE IF EXISTS `+sqliteIdent(name)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM _collections WHERE name = ?`, name); err != nil {
		return err
	}
	return tx.Commit()
}

// blob is a vector as sqlite-vec reads it: float32, little-endian.
func blob(v []float32) []byte {
	b := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(x))
	}
	return b
}

func unblob(b []byte) []float32 {
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[4*i:]))
	}
	return out
}

func (s *sqliteStore) Upsert(ctx context.Context, project string, c Collection, chunks []Chunk) error {
	db, err := s.db(ctx, project)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	q := `INSERT INTO ` + sqliteIdent(c.Name) + ` (id, doc, parent, level, title, text, meta, updated, embedding)
		VALUES (?, NULLIF(?, ''), NULLIF(?, ''), ?, NULLIF(?, ''), ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, parent = excluded.parent, level = excluded.level,
		title = excluded.title, text = excluded.text, meta = excluded.meta, updated = excluded.updated, embedding = excluded.embedding`
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, ch := range chunks {
		meta, err := metaJSON(ch.Meta)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, q, ch.ID, ch.Doc, ch.Parent, ch.Level, ch.Title, ch.Text, string(meta), now, blob(ch.Vector)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

var metaKey = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func sqliteWhere(f Filter, args []any) (string, []any, error) {
	var conds []string
	in := func(col string, vals []any) {
		marks := make([]string, len(vals))
		for i, v := range vals {
			args = append(args, v)
			marks[i] = "?"
		}
		conds = append(conds, col+" IN ("+strings.Join(marks, ", ")+")")
	}
	if len(f.Docs) > 0 {
		in("doc", anys(f.Docs))
	}
	if len(f.Parents) > 0 {
		in("parent", anys(f.Parents))
	}
	if len(f.Levels) > 0 {
		in("level", anys(f.Levels))
	}
	for k, v := range f.Meta {
		if !metaKey.MatchString(k) {
			return "", nil, fmt.Errorf("filter.meta: the key %q has characters other than letters, digits, _ and -", k)
		}
		args = append(args, v)
		conds = append(conds, `json_extract(meta, '$."`+k+`"') = ?`)
	}
	if len(conds) == 0 {
		return "", args, nil
	}
	return " WHERE " + strings.Join(conds, " AND "), args, nil
}

func anys[T any](v []T) []any {
	out := make([]any, len(v))
	for i, x := range v {
		out[i] = x
	}
	return out
}

func sqliteColumns(withText bool) string {
	if withText {
		return "id, coalesce(doc, ''), coalesce(parent, ''), level, coalesce(title, ''), text, meta, updated"
	}
	return "id, coalesce(doc, ''), coalesce(parent, ''), level, coalesce(title, ''), '', meta, updated"
}

type scanner interface{ Scan(...any) error }

func sqliteChunk(r scanner, extra ...any) (Chunk, error) {
	var ch Chunk
	var meta, updated string
	if err := r.Scan(append([]any{&ch.ID, &ch.Doc, &ch.Parent, &ch.Level, &ch.Title, &ch.Text, &meta, &updated}, extra...)...); err != nil {
		return ch, err
	}
	ch.Updated, _ = time.Parse(time.RFC3339Nano, updated)
	if meta != "" && meta != "{}" {
		if err := json.Unmarshal([]byte(meta), &ch.Meta); err != nil {
			return ch, err
		}
	}
	return ch, nil
}

func (s *sqliteStore) Search(ctx context.Context, project string, c Collection, vecs [][]float32, k int, f Filter, withText bool) ([][]Hit, error) {
	db, err := s.db(ctx, project)
	if err != nil {
		return nil, err
	}
	out := make([][]Hit, len(vecs))
	for i, v := range vecs {
		b := blob(v)
		where, args, err := sqliteWhere(f, []any{b})
		if err != nil {
			return nil, err
		}
		// The first ? is the score's, then come the filter's.
		q := fmt.Sprintf(`SELECT %s, 1 - vec_distance_cosine(embedding, ?) AS score FROM %s%s ORDER BY score DESC LIMIT %d`,
			sqliteColumns(withText), sqliteIdent(c.Name), where, k)
		rows, err := db.QueryContext(ctx, q, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var h Hit
			ch, err := sqliteChunk(rows, &h.Score)
			if err != nil {
				rows.Close()
				return nil, err
			}
			h.Chunk = ch
			out[i] = append(out[i], h)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *sqliteStore) Get(ctx context.Context, project string, c Collection, ids []string) ([]Chunk, error) {
	db, err := s.db(ctx, project)
	if err != nil {
		return nil, err
	}
	marks := strings.TrimSuffix(strings.Repeat("?, ", len(ids)), ", ")
	rows, err := db.QueryContext(ctx, `SELECT `+sqliteColumns(true)+` FROM `+sqliteIdent(c.Name)+` WHERE id IN (`+marks+`)`, anys(ids)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Chunk
	for rows.Next() {
		ch, err := sqliteChunk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ch)
	}
	return out, rows.Err()
}

func (s *sqliteStore) Delete(ctx context.Context, project string, c Collection, ids []string, f Filter) (int64, error) {
	db, err := s.db(ctx, project)
	if err != nil {
		return 0, err
	}
	where, args, err := sqliteWhere(f, nil)
	if err != nil {
		return 0, err
	}
	if len(ids) > 0 {
		cond := "id IN (" + strings.TrimSuffix(strings.Repeat("?, ", len(ids)), ", ") + ")"
		args = append(args, anys(ids)...)
		if where == "" {
			where = " WHERE " + cond
		} else {
			where += " AND " + cond
		}
	}
	if where == "" {
		return 0, errors.New("delete needs ids or a filter")
	}
	res, err := db.ExecContext(ctx, `DELETE FROM `+sqliteIdent(c.Name)+where, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// sqliteQuerier runs the direct queries: on the project's own file, with
// the authorizer of DB_QUERY, read-only (mode=ro and query_only) for read.
type sqliteQuerier struct {
	s     *sqliteStore
	write bool
	rows  int
	bytes int
}

func (q *sqliteQuerier) Close() {}

func (q *sqliteQuerier) Query(ctx context.Context, project string, dq DirectQuery) (*QueryResult, error) {
	if strings.TrimSpace(dq.SQL) == "" {
		return nil, errors.New("sql is the statement to run")
	}
	if _, err := os.Stat(q.s.file(project)); err != nil {
		return nil, fmt.Errorf("project %q has no collections yet", project)
	}
	driver, dsn := driverSQLiteRead, "file:"+q.s.file(project)+"?mode=ro&_query_only=1&_busy_timeout=5000"
	if q.write {
		driver, dsn = driverSQLiteWrite, "file:"+q.s.file(project)+"?_busy_timeout=5000"
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	args := make([]any, 0, len(dq.Params))
	for k, v := range dq.Params {
		args = append(args, sql.Named(k, v))
	}
	rows, err := db.QueryContext(ctx, dq.SQL, args...)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("the query took longer than the limit")
		}
		return nil, fmt.Errorf("sqlite: %w", err)
	}
	defer rows.Close()
	cols, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	res := &QueryResult{}
	for _, c := range cols {
		res.Columns = append(res.Columns, c.Name())
	}
	size := 0
	for rows.Next() {
		if len(res.Rows) == q.rows {
			res.Truncated = true
			break
		}
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		for i, v := range vals {
			if b, ok := v.([]byte); ok {
				// A BLOB is a vector of the plugin's, or the caller's bytes.
				if dq.Vectors && len(b)%4 == 0 {
					vals[i] = unblob(b)
				} else if len(b)%4 == 0 {
					vals[i] = map[string]any{"vector": len(b) / 4}
				} else {
					vals[i] = map[string]any{"bytes": len(b)}
				}
			}
		}
		b, err := json.Marshal(vals)
		if err != nil {
			return nil, err
		}
		if size += len(b); size > q.bytes {
			res.Truncated = true
			break
		}
		res.Rows = append(res.Rows, json.RawMessage(b))
	}
	if err := rows.Err(); err != nil && !res.Truncated {
		if ctx.Err() != nil {
			return nil, errors.New("the query took longer than the limit")
		}
		return nil, fmt.Errorf("sqlite: %w", err)
	}
	return res, nil
}

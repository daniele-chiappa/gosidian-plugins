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
		sql.Register(driverSQLite, &sqlite3.SQLiteDriver{Extensions: []string{ext}, ConnectHook: sqliteTempInMemory})
		sql.Register(driverSQLiteRead, &sqlite3.SQLiteDriver{Extensions: []string{ext},
			ConnectHook: func(c *sqlite3.SQLiteConn) error {
				if err := sqliteTempInMemory(c); err != nil {
					return err
				}
				c.RegisterAuthorizer(sqliteAuthorizer(false))
				return nil
			}})
		sql.Register(driverSQLiteWrite, &sqlite3.SQLiteDriver{Extensions: []string{ext},
			ConnectHook: func(c *sqlite3.SQLiteConn) error {
				if err := sqliteTempInMemory(c); err != nil {
					return err
				}
				c.RegisterAuthorizer(sqliteAuthorizer(true))
				return nil
			}})
	})
}

// sqliteTempInMemory keeps SQLite's temporary files in memory: a sort of
// large rows (chunks with their vectors and texts) spills to them, and the
// image runs on a read-only file system, where it failed as "disk I/O
// error: permission denied".
func sqliteTempInMemory(c *sqlite3.SQLiteConn) error {
	_, err := c.Exec("PRAGMA temp_store = MEMORY", nil)
	return err
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
	if err := sqliteAddColumns(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	s.dbs[project] = db
	return db, nil
}

// sqliteAddColumns gives the tables of a project's file the columns of this
// version, when the file opens: one made before 0.3.0 has no fingerprint,
// which a NULL then fills.
func sqliteAddColumns(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, `SELECT name FROM _collections WHERE NOT EXISTS
		(SELECT 1 FROM pragma_table_info(_collections.name) WHERE name = 'fingerprint')`)
	if err != nil {
		return err
	}
	var old []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		old = append(old, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, name := range old {
		if _, err := db.ExecContext(ctx, `ALTER TABLE `+sqliteIdent(name)+` ADD COLUMN fingerprint TEXT`); err != nil {
			return fmt.Errorf("adding the fingerprint of the vectors to %s: %w", name, err)
		}
	}
	return nil
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
			title TEXT, text TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL, embedding BLOB NOT NULL, fingerprint TEXT)`,
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
	q := `INSERT INTO ` + sqliteIdent(c.Name) + ` (id, doc, parent, level, title, text, meta, updated, embedding, fingerprint)
		VALUES (?, NULLIF(?, ''), NULLIF(?, ''), ?, NULLIF(?, ''), ?, ?, ?, ?, NULLIF(?, ''))
		ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, parent = excluded.parent, level = excluded.level,
		title = excluded.title, text = excluded.text, meta = excluded.meta, updated = excluded.updated, embedding = excluded.embedding,
		fingerprint = excluded.fingerprint`
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, ch := range chunks {
		meta, err := metaJSON(ch.Meta)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, q, ch.ID, ch.Doc, ch.Parent, ch.Level, ch.Title, ch.Text, string(meta), now, blob(ch.Vector), ch.Fingerprint); err != nil {
			return err
		}
	}
	return tx.Commit()
}

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
	for _, k := range sortedKeys(f.Meta) {
		if !metaKey.MatchString(k) {
			return "", nil, fmt.Errorf("filter.meta: the key %q has characters other than letters, digits, _ and -", k)
		}
		args = append(args, f.Meta[k])
		conds = append(conds, sqliteMeta(k)+` = ?`)
	}
	for _, mc := range f.Conds {
		switch mc.Op {
		case "ne":
			// IS NOT holds for a chunk without the key, whose value is NULL.
			args = append(args, mc.Value)
			conds = append(conds, sqliteMeta(mc.Key)+` IS NOT ?`)
		case "in":
			vals := mc.Value.([]any)
			args = append(args, vals...)
			conds = append(conds, sqliteMeta(mc.Key)+` IN (`+strings.TrimSuffix(strings.Repeat("?, ", len(vals)), ", ")+`)`)
		default:
			// SQLite puts any text after any number: only numbers compare.
			args = append(args, mc.Value)
			conds = append(conds, `(json_type(meta, '$."`+mc.Key+`"') IN ('integer', 'real') AND `+sqliteMeta(mc.Key)+` `+compareOps[mc.Op]+` ?)`)
		}
	}
	if len(conds) == 0 {
		return "", args, nil
	}
	return " WHERE " + strings.Join(conds, " AND "), args, nil
}

// sqliteMeta is the value of a key of the meta, checked by metaKey.
func sqliteMeta(key string) string { return `json_extract(meta, '$."` + key + `"')` }

// sqliteWhereIDs is the WHERE clause of a filter and ids, after the
// arguments given.
func sqliteWhereIDs(f Filter, ids []string, args []any) (string, []any, error) {
	where, args, err := sqliteWhere(f, args)
	if err != nil {
		return "", nil, err
	}
	if len(ids) > 0 {
		args = append(args, anys(ids)...)
		where = andWhere(where, "id IN ("+strings.TrimSuffix(strings.Repeat("?, ", len(ids)), ", ")+")")
	}
	return where, args, nil
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

// Search compares each vector with every chunk the filter keeps: always
// exact.
func (s *sqliteStore) Search(ctx context.Context, project string, c Collection, vecs [][]float32, k int, f Filter, o SearchOptions) ([][]Hit, error) {
	withText := o.WithText
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
	rows, err := db.QueryContext(ctx, `SELECT `+sqliteColumns(true)+`, coalesce(fingerprint, '') FROM `+sqliteIdent(c.Name)+` WHERE id IN (`+marks+`)`, anys(ids)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Chunk
	for rows.Next() {
		var fp string
		ch, err := sqliteChunk(rows, &fp)
		if err != nil {
			return nil, err
		}
		ch.Fingerprint = fp
		out = append(out, ch)
	}
	return out, rows.Err()
}

func (s *sqliteStore) Delete(ctx context.Context, project string, c Collection, ids []string, f Filter) (int64, error) {
	db, err := s.db(ctx, project)
	if err != nil {
		return 0, err
	}
	where, args, err := sqliteWhereIDs(f, ids, nil)
	if err != nil {
		return 0, err
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

// Resume goes on after the last chunk given: pages follow the ids.
func (s *sqliteStore) Resume(_ string, _ Collection, last, _ Chunk) string { return last.ID }

func (s *sqliteStore) List(ctx context.Context, project string, c Collection, f Filter, after string, limit int, withText, withVectors bool) ([]Chunk, string, error) {
	db, err := s.db(ctx, project)
	if err != nil {
		return nil, "", err
	}
	where, args, err := sqliteWhere(f, nil)
	if err != nil {
		return nil, "", err
	}
	if after != "" {
		args = append(args, after)
		where = andWhere(where, "id > ?")
	}
	args = append(args, limit+1)
	cols := sqliteColumns(withText)
	if withVectors {
		cols += ", coalesce(fingerprint, ''), embedding"
	}
	rows, err := db.QueryContext(ctx, `SELECT `+cols+` FROM `+sqliteIdent(c.Name)+where+` ORDER BY id LIMIT ?`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	var out []Chunk
	for rows.Next() {
		var b []byte
		var fp string
		var extra []any
		if withVectors {
			extra = append(extra, &fp, &b)
		}
		ch, err := sqliteChunk(rows, extra...)
		if err != nil {
			return nil, "", err
		}
		if withVectors {
			ch.Vector, ch.Fingerprint = unblob(b), fp
		}
		out = append(out, ch)
	}
	if err := rows.Err(); err != nil || len(out) <= limit {
		return out, "", err
	}
	return out[:limit], out[limit-1].ID, nil
}

func (s *sqliteStore) Count(ctx context.Context, project string, c Collection, f Filter) (int64, error) {
	db, err := s.db(ctx, project)
	if err != nil {
		return 0, err
	}
	where, args, err := sqliteWhere(f, nil)
	if err != nil {
		return 0, err
	}
	var n int64
	err = db.QueryRowContext(ctx, `SELECT count(*) FROM `+sqliteIdent(c.Name)+where, args...).Scan(&n)
	return n, err
}

// Update checks first that no meta it makes grows over maxMeta, then
// changes them all in one statement. The two are no transaction: a write
// after a read in one could fail on another connection's write
// (SQLITE_BUSY), and the cap only bounds what a caller stores.
func (s *sqliteStore) Update(ctx context.Context, project string, c Collection, ids []string, f Filter, meta map[string]any, maxMeta int) (int64, error) {
	db, err := s.db(ctx, project)
	if err != nil {
		return 0, err
	}
	set, remove := splitUpdate(meta)
	expr, args := "meta", []any{}
	if len(set) > 0 {
		parts := []string{"meta"}
		for _, k := range sortedKeys(set) {
			b, err := json.Marshal(set[k])
			if err != nil {
				return 0, err
			}
			parts = append(parts, `'$."`+k+`"'`, "json(?)")
			args = append(args, string(b))
		}
		expr = "json_set(" + strings.Join(parts, ", ") + ")"
	}
	if len(remove) > 0 {
		paths := make([]string, len(remove))
		for i, k := range remove {
			paths[i] = `'$."` + k + `"'`
		}
		expr = "json_remove(" + expr + ", " + strings.Join(paths, ", ") + ")"
	}
	where, wargs, err := sqliteWhereIDs(f, ids, nil)
	if err != nil {
		return 0, err
	}
	if where == "" {
		return 0, errors.New("update needs ids or a filter")
	}
	// SQLite's JSON functions write it compact, as the plugin does.
	check := append(append(append([]any(nil), args...), wargs...), maxMeta)
	var id string
	var size int
	err = db.QueryRowContext(ctx, `SELECT id, n FROM (SELECT id, length(CAST(`+expr+` AS BLOB)) AS n, length(CAST(meta AS BLOB)) AS o
		FROM `+sqliteIdent(c.Name)+where+`) WHERE n > ? AND n > o LIMIT 1`, check...).Scan(&id, &size)
	switch {
	case err == nil:
		return 0, metaTooLarge(id, size, maxMeta)
	case !errors.Is(err, sql.ErrNoRows):
		return 0, err
	}
	args = append(append(args, time.Now().UTC().Format(time.RFC3339Nano)), wargs...)
	res, err := db.ExecContext(ctx, `UPDATE `+sqliteIdent(c.Name)+` SET meta = `+expr+`, updated = ?`+where, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *sqliteStore) Refresh(ctx context.Context, project string, c Collection, chunks []Chunk) error {
	db, err := s.db(ctx, project)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	q := `UPDATE ` + sqliteIdent(c.Name) + ` SET doc = NULLIF(?, ''), parent = NULLIF(?, ''), level = ?,
		title = NULLIF(?, ''), meta = ?, updated = ? WHERE id = ?`
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, ch := range chunks {
		meta, err := metaJSON(ch.Meta)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, q, ch.Doc, ch.Parent, ch.Level, ch.Title, string(meta), now, ch.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *sqliteStore) Sample(ctx context.Context, project string, c Collection, limit int) ([]Chunk, int64, error) {
	db, err := s.db(ctx, project)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM `+sqliteIdent(c.Name)).Scan(&total); err != nil {
		return nil, 0, err
	}
	// A hash of the rowid orders the chunks at random, the same way each time.
	rows, err := db.QueryContext(ctx, `SELECT id, coalesce(doc, ''), coalesce(parent, ''), level, coalesce(title, ''), substr(text, 1, 600), meta, updated, embedding
		FROM `+sqliteIdent(c.Name)+` ORDER BY (rowid * 1103515245 + 12345) % 2147483648 LIMIT ?`, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Chunk
	for rows.Next() {
		var b []byte
		ch, err := sqliteChunk(rows, &b)
		if err != nil {
			return nil, 0, err
		}
		ch.Vector = renormalize(unblob(b))
		out = append(out, ch)
	}
	return out, total, rows.Err()
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

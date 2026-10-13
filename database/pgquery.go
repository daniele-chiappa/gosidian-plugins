package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The direct queries on PostgreSQL: SQL of the caller's, run
// with the role whoever runs the database gives them (DB_QUERY_USER), in
// the schema of the project, as one statement in a transaction (READ ONLY
// for read), within the plugin's limits, in a session cleaned after.

// pgQuerier runs the direct queries.
type pgQuerier struct {
	s    *pgStore
	env  Env
	base *pgxpool.Config

	mu    sync.Mutex
	pools map[string]*pgxpool.Pool // by role
	safe  map[string]bool          // roles checked
	// vectorOIDs are pgvector's types, whose values a result shows as
	// their size unless the caller asks for them.
	vectorOIDs map[uint32]bool
}

func newPgQuerier(ctx context.Context, s *pgStore, sc StoreConfig, env Env) (*pgQuerier, error) {
	base, err := pgxpool.ParseConfig(sc.URL)
	if err != nil {
		return nil, err
	}
	q := &pgQuerier{s: s, env: env, base: base, pools: map[string]*pgxpool.Pool{}, safe: map[string]bool{}, vectorOIDs: map[uint32]bool{}}
	rows, err := s.pool.Query(ctx, `SELECT oid FROM pg_type WHERE typname IN ('vector', 'halfvec', 'sparsevec')`)
	if err != nil {
		return nil, err
	}
	oids, err := pgx.CollectRows(rows, pgx.RowTo[uint32])
	if err != nil {
		return nil, err
	}
	for _, o := range oids {
		q.vectorOIDs[o] = true
	}
	if env.QueryUser == "" {
		return nil, errors.New("DB_QUERY is on and DB_QUERY_USER is empty: the direct queries run as the role you give them")
	}
	// A role without {project} is checked now: a wrong one stops the
	// plugin, not a call.
	if !strings.Contains(env.QueryUser, "{project}") {
		if err := q.checkRole(ctx, env.QueryUser); err != nil {
			return nil, err
		}
	}
	return q, nil
}

func (q *pgQuerier) Close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, p := range q.pools {
		p.Close()
	}
}

// checkRole refuses a role that would get past the database's own rules:
// a superuser (COPY … TO PROGRAM, the server's files), one that bypasses
// row security, and the plugin's own, which owns its tables.
func (q *pgQuerier) checkRole(ctx context.Context, role string) error {
	q.mu.Lock()
	ok := q.safe[role]
	q.mu.Unlock()
	if ok {
		return nil
	}
	if role == q.s.user {
		return fmt.Errorf("DB_QUERY_USER %q is the plugin's own role, the owner of its tables: give the direct queries another one", role)
	}
	var super, bypass bool
	err := q.s.pool.QueryRow(ctx, `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, role).Scan(&super, &bypass)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("the role %q of the direct queries does not exist: whoever runs the database creates it (CREATE ROLE … LOGIN)", role)
	}
	if err != nil {
		return err
	}
	if super || bypass {
		return fmt.Errorf("the role %q of the direct queries is a superuser or bypasses row security: the plugin refuses it", role)
	}
	q.mu.Lock()
	q.safe[role] = true
	q.mu.Unlock()
	return nil
}

// role is the role of a project's direct queries. Without {project} one
// role reads every schema it is granted, so the direct queries belong to
// one project only: the first that runs one.
func (q *pgQuerier) role(ctx context.Context, project string) (string, error) {
	if strings.Contains(q.env.QueryUser, "{project}") {
		role := strings.ReplaceAll(q.env.QueryUser, "{project}", project)
		return role, q.checkRole(ctx, role)
	}
	var owner string
	err := q.s.pool.QueryRow(ctx, `INSERT INTO gosidian_meta.query_project (id, project) VALUES (1, $1)
		ON CONFLICT (id) DO UPDATE SET id = 1 RETURNING project`, project).Scan(&owner)
	if err != nil {
		return "", err
	}
	if owner != project {
		return "", fmt.Errorf("the direct queries of this archive belong to project %q: with one role for all (DB_QUERY_USER without {project}) a single project may run them", owner)
	}
	return q.env.QueryUser, nil
}

func (q *pgQuerier) pool(ctx context.Context, role string) (*pgxpool.Pool, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if p, ok := q.pools[role]; ok {
		return p, nil
	}
	pc := q.base.Copy()
	pc.ConnConfig.User, pc.ConnConfig.Password = role, q.env.QueryPassword
	pc.MaxConns = int32(q.env.QueryConcurrency)
	// No statement is kept between calls: each session is cleaned with
	// DISCARD ALL after a query.
	pc.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeDescribeExec
	p, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, err
	}
	q.pools[role] = p
	return p, nil
}

// grant lets role read the project's views, and nothing else of the
// plugin's: its tables stay the plugin's, and anything more is a GRANT of
// whoever runs the database.
func (q *pgQuerier) grant(ctx context.Context, project, role string) error {
	list, err := q.s.Collections(ctx, project)
	if err != nil {
		return err
	}
	r := pgx.Identifier{role}.Sanitize()
	stmts := []string{`GRANT USAGE ON SCHEMA ` + pgSchema(project) + ` TO ` + r}
	views := []string{pgView(project, "collections")}
	for _, c := range list {
		views = append(views, pgView(project, c.Name))
	}
	stmts = append(stmts, `GRANT SELECT ON `+strings.Join(views, ", ")+` TO `+r)
	for _, st := range stmts {
		if _, err := q.s.pool.Exec(ctx, st); err != nil {
			return pgError(err)
		}
	}
	return nil
}

// Query runs a direct query for project.
func (q *pgQuerier) Query(ctx context.Context, project string, dq DirectQuery) (*QueryResult, error) {
	if strings.TrimSpace(dq.SQL) == "" {
		return nil, errors.New("sql is the statement to run")
	}
	list, err := q.s.Collections(ctx, project)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("project %q has no collections yet", project)
	}
	role, err := q.role(ctx, project)
	if err != nil {
		return nil, err
	}
	if err := q.grant(ctx, project, role); err != nil {
		return nil, err
	}
	pool, err := q.pool(ctx, role)
	if err != nil {
		return nil, err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, pgError(err)
	}
	defer conn.Release()
	opts := pgx.TxOptions{}
	if q.env.Query != QueryWrite {
		opts.AccessMode = pgx.ReadOnly
	}
	res := &QueryResult{}
	err = pgx.BeginTxFunc(ctx, conn, opts, func(tx pgx.Tx) error {
		// The setting is the role's to change; the context's timeout
		// cancels the query anyway.
		for _, st := range []string{
			// public holds pgvector's types and operators; what a role
			// reads there is still what it is granted.
			`SET LOCAL search_path = ` + pgSchema(project) + `, public`,
			fmt.Sprintf(`SET LOCAL statement_timeout = %d`, q.env.QueryTimeout.Milliseconds()),
		} {
			if _, err := tx.Exec(ctx, st); err != nil {
				return err
			}
		}
		rows, err := tx.Query(ctx, dq.SQL, pgx.NamedArgs(dq.Params))
		if err != nil {
			return err
		}
		defer rows.Close()
		fields := rows.FieldDescriptions()
		for _, f := range fields {
			res.Columns = append(res.Columns, f.Name)
		}
		size := 0
		for rows.Next() {
			if len(res.Rows) == q.env.QueryRows {
				res.Truncated = true
				break
			}
			vals, err := rows.Values()
			if err != nil {
				return err
			}
			for i, v := range vals {
				if q.vectorOIDs[fields[i].DataTypeOID] && !dq.Vectors {
					vals[i] = vectorSize(v)
				}
			}
			b, err := json.Marshal(vals)
			if err != nil {
				return err
			}
			if size += len(b); size > q.env.QueryBytes {
				res.Truncated = true
				break
			}
			res.Rows = append(res.Rows, json.RawMessage(b))
		}
		if err := rows.Err(); err != nil && !res.Truncated {
			return err
		}
		rows.Close()
		res.Command = rows.CommandTag().String()
		return nil
	})
	// A session keeps nothing of a query for the next one: temporary
	// tables, settings, prepared statements, listens.
	if _, derr := conn.Exec(context.WithoutCancel(ctx), `DISCARD ALL`); derr != nil {
		// A closed connection goes back to the pool, which drops it.
		_ = conn.Conn().Close(context.WithoutCancel(ctx))
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("the query took longer than %s", q.env.QueryTimeout)
		}
		return nil, pgError(err)
	}
	return res, nil
}

// vectorSize is a vector as a result shows it without vectors: its size.
func vectorSize(v any) any {
	s, ok := v.(string)
	if !ok {
		return map[string]any{"vector": nil}
	}
	if strings.TrimSpace(s) == "[]" {
		return map[string]any{"vector": 0}
	}
	return map[string]any{"vector": strings.Count(s, ",") + 1}
}

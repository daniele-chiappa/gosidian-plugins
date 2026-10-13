package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// loaded is a plugin of b with DB_QUERY query and the procedures in
// project's collection procedure.
func loaded(t *testing.T, b backend, query, project string) *Plugin {
	t.Helper()
	p, _ := testPlugin(t, b, query)
	chunks := []any{}
	for _, ch := range procedures {
		chunks = append(chunks, map[string]any{"id": ch.ID, "text": ch.Text, "doc": ch.Doc, "level": ch.Level, "meta": ch.Meta})
	}
	call(t, p, "upsert", project, map[string]any{"collection": "procedure", "chunks": chunks}, "")
	t.Cleanup(func() { _ = p.store.Drop(context.Background(), project, "procedure") })
	return p
}

func TestQuery_SQLite(t *testing.T) {
	ext := sqliteExtension(t)
	dir := t.TempDir()
	b := backend{"sqlite", StoreConfig{Kind: "sqlite", Path: dir, Extension: ext}, Env{Name: "vec-sqlite"}}
	proj := uniq("rag")
	p := loaded(t, b, QueryRead, proj)
	out := call(t, p, "query", proj, map[string]any{
		"sql":   "SELECT id, doc, embedding, 1 - vec_distance_cosine(embedding, :q) AS score FROM procedure WHERE level = :lvl ORDER BY score DESC",
		"embed": map[string]any{"q": "foglie ingialliscono annaffiare"}, "params": map[string]any{"lvl": 1}}, "")
	rows := out["rows"].([]any)
	if len(rows) != 2 || rows[0].([]any)[0] != "orto-1" {
		t.Fatalf("query: %v", out)
	}
	if v := rows[0].([]any)[2].(map[string]any); v["vector"] != float64(12) {
		t.Errorf("the vector shows as %v", v)
	}
	out = call(t, p, "query", proj, map[string]any{"sql": "SELECT name, model, dims FROM collections"}, "")
	if rows := out["rows"].([]any); len(rows) != 1 || rows[0].([]any)[1] != "bag" {
		t.Errorf("collections: %v", out)
	}
	for sql, why := range map[string]string{
		"INSERT INTO procedure (id, text, updated, embedding) VALUES ('x', 'x', '', x'00')": "not authorized",
		"DELETE FROM procedure":                   "not authorized",
		"ATTACH DATABASE '" + dir + "/x.db' AS x": "not authorized",
		"PRAGMA journal_mode = DELETE":            "not authorized",
		"CREATE TABLE x (a)":                      "not authorized",
		"SELECT load_extension('/tmp/x')":         "not authorized",
	} {
		call(t, p, "query", proj, map[string]any{"sql": sql}, why)
	}
	call(t, p, "query", uniq("altro"), map[string]any{"sql": "SELECT 1"}, "no collections yet")

	w := loaded(t, backend{"sqlite", StoreConfig{Kind: "sqlite", Path: t.TempDir(), Extension: ext}, Env{Name: "vec-sqlite"}}, QueryWrite, proj)
	call(t, w, "query", proj, map[string]any{"sql": "UPDATE procedure SET meta = json_set(meta, '$.ok', 1) WHERE id = 'orto-1'"}, "")
	call(t, w, "query", proj, map[string]any{"sql": "DROP TABLE procedure"}, "not authorized")
}

// TestQuery_Postgres needs PG_URL to name a superuser, who makes the
// roles of the test.
func TestQuery_Postgres(t *testing.T) {
	u := os.Getenv("PG_URL")
	if u == "" {
		t.Skip("PG_URL")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	pa, pb := uniq("rag a"), uniq("rag b")
	for _, q := range []string{
		`CREATE ROLE ` + pgx.Identifier{"q_" + pa}.Sanitize() + ` LOGIN PASSWORD 'pw'`,
		`CREATE ROLE ` + pgx.Identifier{"q_" + pb}.Sanitize() + ` LOGIN PASSWORD 'pw'`,
		`CREATE ROLE ` + pgx.Identifier{"q_super_" + pa}.Sanitize() + ` LOGIN SUPERUSER PASSWORD 'pw'`,
	} {
		if _, err := admin.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		for _, r := range []string{"q_" + pa, "q_" + pb, "q_super_" + pa} {
			id := pgx.Identifier{r}.Sanitize()
			_, _ = admin.Exec(context.Background(), `DROP OWNED BY `+id)
			_, _ = admin.Exec(context.Background(), `DROP ROLE `+id)
		}
	})
	b := backend{"postgres", StoreConfig{Kind: "postgres", URL: u}, Env{Name: "vec-pg", QueryUser: "q_{project}", QueryPassword: "pw", QueryTimeout: time.Second}}
	p := loaded(t, b, QueryRead, pa)
	call(t, p, "upsert", pb, map[string]any{"collection": "procedure", "chunks": []any{map[string]any{"id": "b1", "text": "progetto b"}}}, "")
	t.Cleanup(func() { _ = p.store.Drop(context.Background(), pb, "procedure") })

	out := call(t, p, "query", pa, map[string]any{
		"sql":   "SELECT id, embedding, 1 - (embedding <=> @q::vector) AS score FROM procedure WHERE meta->>'rev' = @rev ORDER BY embedding <=> @q::vector LIMIT 5",
		"embed": map[string]any{"q": "foglie ingialliscono annaffiare"}, "params": map[string]any{"rev": "02"}}, "")
	rows := out["rows"].([]any)
	if len(rows) != 2 || rows[0].([]any)[0] != "orto-1" || rows[0].([]any)[1].(map[string]any)["vector"] != float64(12) {
		t.Fatalf("query: %v", out)
	}
	out = call(t, p, "query", pa, map[string]any{"sql": "SELECT name, dims FROM collections"}, "")
	if rows := out["rows"].([]any); len(rows) != 1 {
		t.Errorf("collections: %v", out)
	}
	// Read-only, one statement, within the time, in the project's schema.
	call(t, p, "query", pa, map[string]any{"sql": "DELETE FROM procedure"}, "permission denied")
	// A role granted more still only reads with read.
	if _, err := admin.Exec(ctx, `GRANT DELETE ON `+pgView(pa, "procedure")+` TO `+pgx.Identifier{"q_" + pa}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	call(t, p, "query", pa, map[string]any{"sql": "DELETE FROM procedure"}, "read-only transaction")
	call(t, p, "query", pa, map[string]any{"sql": "SELECT 1; SELECT 2"}, "multiple commands")
	call(t, p, "query", pa, map[string]any{"sql": "SET statement_timeout = 0; SELECT pg_sleep(5)"}, "multiple commands")
	call(t, p, "query", pa, map[string]any{"sql": "SELECT pg_sleep(5)"}, "longer than")
	call(t, p, "query", pa, map[string]any{"sql": "SELECT * FROM " + pgTable(pb, "procedure")}, "permission denied")
	call(t, p, "query", pa, map[string]any{"sql": "SELECT * FROM " + pgView(pb, "procedure")}, "permission denied")
	call(t, p, "query", pa, map[string]any{"sql": "SELECT * FROM gosidian_meta.collections"}, "permission denied")
	call(t, p, "query", pa, map[string]any{"sql": "SELECT * FROM " + pgTable(pa, "procedure")}, "permission denied")
	// The session keeps nothing for the next call.
	call(t, p, "query", pa, map[string]any{"sql": "SELECT set_config('gosidian.test', 'left', false)"}, "")
	for range 3 {
		out := call(t, p, "query", pa, map[string]any{"sql": "SELECT coalesce(current_setting('gosidian.test', true), '')"}, "")
		if v := out["rows"].([]any)[0].([]any)[0]; v != "" {
			t.Errorf("a setting of the call before is still there: %v", v)
		}
	}

	// The roles the plugin refuses.
	for user, why := range map[string]string{
		"q_super_{project}": "superuser",
		"q_missing":         "does not exist",
	} {
		b.env.QueryUser = user
		if user == "q_missing" {
			if _, _, err := Open(ctx, b.sc, Env{Name: "vec-pg", Query: QueryRead, QueryUser: user}); err == nil || !strings.Contains(err.Error(), why) {
				t.Errorf("%s: %v", user, err)
			}
			continue
		}
		bad, _ := testPlugin(t, b, QueryRead)
		call(t, bad, "query", pa, map[string]any{"sql": "SELECT 1"}, why)
	}
	cfg, _ := pgx.ParseConfig(u)
	if _, _, err := Open(ctx, b.sc, Env{Name: "vec-pg", Query: QueryRead, QueryUser: cfg.User}); err == nil || !strings.Contains(err.Error(), "own role") {
		t.Errorf("the plugin's own role: %v", err)
	}
}

func TestQuery_Qdrant(t *testing.T) {
	u := os.Getenv("QDRANT_URL")
	if u == "" {
		t.Skip("QDRANT_URL")
	}
	b := backend{"qdrant", StoreConfig{Kind: "qdrant", URL: u}, Env{Name: "vec-qdrant"}}
	pa, pb := uniq("rag a"), uniq("rag b")
	p := loaded(t, b, QueryRead, pa)
	call(t, p, "upsert", pb, map[string]any{"collection": "altra", "chunks": []any{map[string]any{"id": "b1", "text": "progetto b"}}}, "")
	t.Cleanup(func() { _ = p.store.Drop(context.Background(), pb, "altra") })

	out := call(t, p, "query", pa, map[string]any{"op": "query", "collection": "procedure",
		"body": map[string]any{"query": "$q", "limit": 2, "with_payload": []any{"chunk_id"}, "with_vector": true}, "embed": map[string]any{"q": "foglie ingialliscono annaffiare"}}, "")
	res := out["result"].(map[string]any)["points"].([]any)
	first := res[0].(map[string]any)
	if len(res) != 2 || first["payload"].(map[string]any)["chunk_id"] != "orto-1" || first["vector"].(map[string]any)["vector"] != float64(12) {
		t.Fatalf("query: %v", out)
	}
	out = call(t, p, "query", pa, map[string]any{"op": "facet", "collection": "procedure", "body": map[string]any{"key": "doc"}}, "")
	if hits := out["result"].(map[string]any)["hits"].([]any); len(hits) != 2 {
		t.Errorf("facet: %v", out)
	}
	call(t, p, "query", pa, map[string]any{"op": "delete_points", "collection": "procedure", "body": map[string]any{"points": []any{}}}, "DB_QUERY is read")
	call(t, p, "query", pa, map[string]any{"op": "drop", "collection": "procedure"}, "one of")
	call(t, p, "query", pa, map[string]any{"op": "count", "collection": "altra"}, "no collection")
	call(t, p, "query", pa, map[string]any{"op": "query", "collection": "procedure",
		"body": map[string]any{"query": "$q", "lookup_from": map[string]any{"collection": "altra"}}, "embed": map[string]any{"q": "x"}}, "no collection of the project")
	call(t, p, "query", pa, map[string]any{"op": "query", "collection": "procedure",
		"body": map[string]any{"query": "$q", "lookup_from": map[string]any{"collection": qdrantCollection(pb, "altra")}}, "embed": map[string]any{"q": "x"}}, "no collection of the project")
}

// Command gosidian-database is a gosidian plugin that keeps chunks and
// their embeddings in a database of vectors (PostgreSQL with pgvector,
// Qdrant, or SQLite with sqlite-vec) and searches them: nodes for the
// pipelines, tools for the agents, each project's data apart (gosidian
// docs/plugins.md). One container is one archive: a store, and a preset
// of the endpoint that computes the embeddings and its models. The
// chunks come cut: how to cut them is the caller's choice. Direct queries
// in the database's own language are an option (DB_QUERY), run with the
// role whoever runs the database gives them.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// version is set at build time (-ldflags "-X main.version=…").
var version = "dev"

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func main() {
	port := env("PORT", "8000")
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(port))
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(port, log); err != nil {
		log.Error("gosidian-database", "err", err)
		os.Exit(1)
	}
}

func run(port string, log *slog.Logger) error {
	cfgPath := env("DB_PRESET", "/etc/gosidian-database/preset.yaml")
	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		return fmt.Errorf("preset: %w", err)
	}
	e, err := LoadEnv(os.Getenv)
	if err != nil {
		return err
	}
	if e.Token == "" {
		log.Warn("GOSIDIAN_PLUGIN_TOKEN is empty: /mcp answers anyone who reaches it")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	octx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	store, query, err := Open(octx, cfg.Store, e)
	if err != nil {
		return err
	}
	defer store.Close()
	if query != nil {
		defer query.Close()
	}
	key := ""
	if cfg.Endpoint.APIKeyEnv != "" {
		if key = os.Getenv(cfg.Endpoint.APIKeyEnv); key == "" {
			log.Warn("the endpoint's key is empty", "env", cfg.Endpoint.APIKeyEnv)
		}
	}
	p := NewPlugin(cfg, e, store, NewEmbedder(cfg.Endpoint, key), query, log)
	srv := &http.Server{Addr: ":" + port, Handler: p.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	models := make([]string, len(cfg.Models))
	for i, m := range cfg.Models {
		models[i] = fmt.Sprintf("%s (%d)", m.Name, m.Size())
	}
	log.Info("gosidian-database", "version", version, "name", e.Name, "port", port, "store", cfg.Store.Kind,
		"endpoint", cfg.Endpoint.BaseURL, "models", models, "query", e.Query, "preset", cfgPath)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// Open opens the store of a preset and, with DB_QUERY on, what runs its
// direct queries.
func Open(ctx context.Context, sc StoreConfig, e Env) (Store, Querier, error) {
	if e.Query == "" {
		e.Query = QueryOff
	}
	switch sc.Kind {
	case "postgres":
		s, err := openPostgres(ctx, sc, e.Password)
		if err != nil {
			return nil, nil, pgError(err)
		}
		if e.Query == QueryOff {
			return s, nil, nil
		}
		q, err := newPgQuerier(ctx, s, sc, e)
		if err != nil {
			s.Close()
			return nil, nil, pgError(err)
		}
		return s, q, nil
	case "qdrant":
		s, err := openQdrant(ctx, sc, e.Password)
		if err != nil {
			return nil, nil, err
		}
		if e.Query == QueryOff {
			return s, nil, nil
		}
		key := e.QueryKey
		if key == "" {
			key = e.Password
		}
		return s, &qdrantQuerier{s: s, env: e, key: key, write: e.Query == QueryWrite}, nil
	case "sqlite":
		s, err := openSQLite(sc)
		if err != nil {
			return nil, nil, err
		}
		if e.Query == QueryOff {
			return s, nil, nil
		}
		return s, &sqliteQuerier{s: s, write: e.Query == QueryWrite, rows: e.QueryRows, bytes: e.QueryBytes}, nil
	}
	return nil, nil, fmt.Errorf("store.kind %q", sc.Kind)
}

// healthcheck asks the running plugin for /health: 0 when it answers.
func healthcheck(port string) int {
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// Command gosidian-storage is a gosidian plugin whose sources are remote
// stores (WebDAV, Nextcloud among them, S3, Google Drive and local
// folders), read with rclone in the process: gosidian binds a source to
// a project's IN folder, lists its files, and reads them, a range at a
// time, from the URLs the plugin gives (gosidian docs/plugins.md,
// «Sources»). The sources
// and their credentials are in storage.yaml and in files of their own,
// and never leave the plugin.
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

	"github.com/rclone/rclone/fs"
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
	cfgPath := env("STORAGE_CONFIG", "/etc/gosidian-storage/storage.yaml")
	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(1)
	}
	ttl, err := time.ParseDuration(env("STORAGE_LINK_TTL", "10m"))
	if err != nil || ttl <= 0 {
		log.Error("STORAGE_LINK_TTL is no duration", "value", os.Getenv("STORAGE_LINK_TTL"))
		os.Exit(1)
	}
	// Few retries of rclone's own: a server that refuses or fails is
	// asked again at gosidian's next check, not at once.
	ci := fs.GetConfig(context.Background())
	ci.LowLevelRetries = 2
	base := env("STORAGE_PUBLIC_URL", "http://gosidian-storage:"+port)
	token := os.Getenv("GOSIDIAN_PLUGIN_TOKEN")
	if token == "" {
		log.Warn("GOSIDIAN_PLUGIN_TOKEN is empty: /mcp answers anyone who reaches it")
	}
	p := NewPlugin(cfg, base, token, ttl, log)
	srv := &http.Server{Addr: ":" + port, Handler: p.Handler(), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	names := make([]string, 0, len(cfg.Sources))
	for _, s := range cfg.Sources {
		names = append(names, s.Name+" ("+s.Kind+")")
	}
	log.Info("gosidian-storage", "version", version, "port", port, "files", base+filesPath, "sources", names, "config", cfgPath)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
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

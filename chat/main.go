// Command gosidian-chat is a gosidian plugin that serves bots: a chat on
// the documents of a project, as a widget any web page loads and as a page
// of its own, which gosidian shows in the bot's note. gosidian configures
// each bot from its note type: chat (tools chat_configure and chat_remove,
// gosidian docs/chat.md); each message starts the bot's pipeline with its
// run token, and its answer comes back to the chat.
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

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(port))
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(port, log); err != nil {
		log.Error("gosidian-chat", "err", err)
		os.Exit(1)
	}
}

func run(port string, log *slog.Logger) error {
	set, err := LoadSettings(os.Getenv)
	if err != nil {
		return err
	}
	if set.Token == "" {
		log.Warn("GOSIDIAN_PLUGIN_TOKEN is empty: /mcp answers anyone who reaches it")
	}
	p := NewPlugin(set, log)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{Addr: ":" + port, Handler: p.Handler(), ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, IdleTimeout: 2 * time.Minute}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("gosidian-chat", "version", version, "name", set.Name, "port", port, "public_url", set.PublicURL,
		"wait", set.Wait, "per_minute", set.PerMinute, "per_session", set.PerSession, "ip_per_minute", set.IPPerMinute)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
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

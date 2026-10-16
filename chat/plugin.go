package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// metaProject is the _meta field gosidian names a call's project with.
const metaProject = "gosidian/project"

// Plugin is gosidian-chat: the bots gosidian configures, their chat on
// the internet (the widget, a page per bot, the API), and the calls to
// gosidian that start a bot's pipeline on each message.
type Plugin struct {
	set      Settings
	log      *slog.Logger
	client   *http.Client
	sessions *Sessions
	limits   *window
	now      func() time.Time

	mu   sync.RWMutex
	bots map[string]*Bot
}

// NewPlugin is the plugin of its settings.
func NewPlugin(set Settings, log *slog.Logger) *Plugin {
	return &Plugin{set: set, log: log, client: &http.Client{Timeout: set.Wait + 15*time.Second},
		sessions: NewSessions(set.SessionTTL, set.MaxSessions), limits: newWindow(),
		now: func() time.Time { return time.Now().UTC() }, bots: map[string]*Bot{}}
}

func (p *Plugin) bot(name string) (*Bot, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	b, ok := p.bots[name]
	return b, ok
}

const configureSchema = `{"type": "object", "required": ["bot", "run", "access"], "properties": {
  "bot": {"type": "string"}, "note": {"type": "string"},
  "title": {"type": "string"}, "welcome": {"type": "string"},
  "scopes": {"type": "array", "items": {"type": "object"}},
  "scope_labels": {"type": "array", "items": {"type": "string"}},
  "access": {"type": "object"}, "run": {"type": "object"}, "sources": {"type": "object"},
  "conversations": {"type": "object"}, "limits": {"type": "object"}, "gosidian_url": {"type": "string"}}}`

const removeSchema = `{"type": "object", "required": ["bot"], "properties": {"bot": {"type": "string"}}}`

// Manifest is what the plugin says of itself: two tools, which gosidian
// calls itself for the notes type: chat (its docs/chat.md).
func (p *Plugin) Manifest() map[string]any {
	return map[string]any{
		"name": p.set.Name, "version": version, "gosidian": 1,
		"description": "Bots: a chat on the documents of a project, as a widget for any page and a page of its own, answered by a pipeline of the project",
		"tools": []any{
			map[string]any{"name": "chat_configure", "access": "write", "input_schema": json.RawMessage(configureSchema),
				"description": "Configures a bot, as gosidian does from its note type: chat: its scopes, who may chat, the run token of its pipeline. Gosidian calls it; an agent has no use for it"},
			map[string]any{"name": "chat_remove", "access": "write", "input_schema": json.RawMessage(removeSchema),
				"description": "Takes a bot out, as gosidian does when its note goes"},
		},
		"permissions": map[string]any{"files": false, "network": []string{}},
	}
}

func (p *Plugin) result(v any) (*mcp.CallToolResult, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultStructured(json.RawMessage(b), string(b)), nil
}

func (p *Plugin) configure(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	raw, err := json.Marshal(req.GetArguments())
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	var b Bot
	if err := json.Unmarshal(raw, &b); err != nil {
		return mcp.NewToolResultError("the bot does not read: " + err.Error()), nil
	}
	// The project comes in _meta, as with every call of gosidian's.
	if req.Params.Meta != nil {
		if pr, ok := req.Params.Meta.AdditionalFields[metaProject].(string); ok && pr != "" {
			b.Project = pr
		}
	}
	if err := b.check(); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	p.mu.Lock()
	_, had := p.bots[b.Name]
	p.bots[b.Name] = &b
	p.mu.Unlock()
	if !had {
		p.log.Info("bot configured", "bot", b.Name, "note", b.Note, "scopes", len(b.Scopes), "users", b.Access.Users,
			"keys", len(b.Access.Keys), "signed", b.Access.SignedSecret != "", "open", b.Access.Open)
	}
	return p.result(map[string]any{"public_url": p.set.PublicURL,
		"embed_url": p.set.PublicURL + "/embed/" + b.Name, "script_url": p.set.PublicURL + "/chat.js"})
}

func (p *Plugin) remove(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	name := req.GetString("bot", "")
	p.mu.Lock()
	_, had := p.bots[name]
	delete(p.bots, name)
	p.mu.Unlock()
	p.sessions.DropBot(name)
	if had {
		p.log.Info("bot removed", "bot", name)
	}
	return p.result(map[string]any{"removed": had})
}

// Handler serves the plugin: MCP at /mcp for gosidian (with its token),
// and on the internet the widget, the bots' pages and their API.
func (p *Plugin) Handler() http.Handler {
	ms := server.NewMCPServer("gosidian-chat", version, server.WithToolCapabilities(false))
	ms.AddTool(mcp.NewTool("gosidian_manifest", mcp.WithDescription("The plugin's manifest, for gosidian")),
		func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) { return p.result(p.Manifest()) })
	ms.AddTool(mcp.NewToolWithRawSchema("chat_configure", "Configures a bot", json.RawMessage(configureSchema)), p.configure)
	ms.AddTool(mcp.NewToolWithRawSchema("chat_remove", "Takes a bot out", json.RawMessage(removeSchema)), p.remove)
	mcpH := server.NewStreamableHTTPServer(ms)
	mux := http.NewServeMux()
	mux.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p.set.Token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+p.set.Token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mcpH.ServeHTTP(w, r)
	}))
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		p.mu.RLock()
		n := len(p.bots)
		p.mu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"status":"ok","version":%q,"bots":%d}`+"\n", version, n)
	})
	mux.HandleFunc("/chat.js", p.serveWidget)
	mux.HandleFunc("/embed/", p.serveEmbed)
	mux.HandleFunc("/api/bots/", p.serveAPI)
	return securityHeaders(mux)
}

// securityHeaders are those of every answer: no sniffing, and no frame
// but for the bots' pages, which gosidian shows in its notes.
func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if !strings.HasPrefix(r.URL.Path, "/embed/") {
			w.Header().Set("X-Frame-Options", "DENY")
		}
		h.ServeHTTP(w, r)
	})
}

package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Plugin is gosidian-storage: the sources of storage.yaml, served to
// gosidian as the source role of its plugins (gosidian docs/plugins.md,
// «Sources»).
type Plugin struct {
	cfg     *Config
	sources map[string]*Source
	tickets *tickets
	// base is the plugin's address as gosidian reaches it, for the URLs
	// of the files.
	base  string
	token string
	log   *slog.Logger
}

// NewPlugin makes the plugin of a configuration.
func NewPlugin(cfg *Config, base, token string, ttl time.Duration, log *slog.Logger) *Plugin {
	p := &Plugin{cfg: cfg, sources: map[string]*Source{}, tickets: newTickets(ttl),
		base: strings.TrimRight(base, "/"), token: token, log: log}
	for _, s := range cfg.Sources {
		p.sources[s.Name] = newSource(s)
	}
	return p
}

// Manifest is what the plugin says of itself.
func (p *Plugin) Manifest() map[string]any {
	sources := make([]any, 0, len(p.cfg.Sources))
	for _, s := range p.cfg.Sources {
		sources = append(sources, map[string]any{"name": s.Name, "kind": s.Kind, "description": s.Description, "move": s.Move})
	}
	network := p.cfg.Hosts()
	if network == nil {
		network = []string{}
	}
	perms := map[string]any{"files": false, "network": network}
	// The presigned URLs of S3 point at S3: its hosts, which gosidian
	// reads from once the owner accepts them.
	if hosts := p.cfg.FileHosts(); len(hosts) > 0 {
		perms["source_hosts"] = hosts
	}
	return map[string]any{
		"name": "storage", "version": version, "gosidian": 1,
		"description": "Remote stores as sources of the IN folders: WebDAV (Nextcloud), S3, Google Drive and local folders, read with rclone",
		"nodes":       []any{}, "sources": sources,
		"permissions": perms,
	}
}

func result(v any) (*mcp.CallToolResult, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultStructured(json.RawMessage(b), string(b)), nil
}

// source finds the source a call names.
func (p *Plugin) source(req mcp.CallToolRequest) (*Source, *mcp.CallToolResult) {
	name := req.GetString("source", "")
	s, ok := p.sources[name]
	if !ok {
		return nil, mcp.NewToolResultError(fmt.Sprintf("no source %q in storage.yaml", name))
	}
	return s, nil
}

func (p *Plugin) failed(tool string, s *Source, err error) *mcp.CallToolResult {
	p.log.Warn(tool, "source", s.cfg.Name, "err", err)
	return mcp.NewToolResultError(err.Error())
}

func (p *Plugin) handleManifest(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return result(p.Manifest())
}

func (p *Plugin) handleList(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	s, bad := p.source(req)
	if bad != nil {
		return bad, nil
	}
	page, err := s.List(ctx, req.GetString("cursor", ""), int(req.GetFloat("limit", 1000)))
	if err != nil {
		return p.failed("list", s, err), nil
	}
	return result(page)
}

func (p *Plugin) handleOpen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	s, bad := p.source(req)
	if bad != nil {
		return bad, nil
	}
	o, err := s.Object(ctx, req.GetString("path", ""))
	if err != nil {
		return p.failed("open", s, err), nil
	}
	f := s.fileOf(ctx, o)
	if s.cfg.Presigned() {
		// The bytes come from S3 itself, at a host the manifest names.
		u, err := s.Presign(ctx, f.Path, p.tickets.ttl)
		if err != nil {
			return p.failed("open", s, err), nil
		}
		return result(map[string]any{"url": u, "size": f.Size, "etag": f.ETag})
	}
	local := ""
	if f.Size < 0 {
		// A native Google document: exported now, so its size is known
		// and its ranges can be served.
		if local, f.Size, err = p.tickets.export(ctx, o); err != nil {
			return p.failed("open", s, fmt.Errorf("exporting %s: %w", f.Path, err)), nil
		}
	}
	id := p.tickets.add(s.cfg.Name, f.Path, local)
	return result(map[string]any{"url": p.base + filesPath + id, "size": f.Size, "etag": f.ETag})
}

func (p *Plugin) handleMove(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	s, bad := p.source(req)
	if bad != nil {
		return bad, nil
	}
	f, err := s.Move(ctx, req.GetString("from", ""), req.GetString("to", ""))
	if err != nil {
		return p.failed("move", s, err), nil
	}
	p.log.Info("moved", "source", s.cfg.Name, "from", req.GetString("from", ""), "to", f.Path)
	return result(f)
}

// Handler serves the plugin: MCP at /mcp (with the token when set), the
// files at /files/, and /health.
func (p *Plugin) Handler() http.Handler {
	ms := server.NewMCPServer("gosidian-storage", version, server.WithToolCapabilities(false))
	ms.AddTool(mcp.NewTool("gosidian_manifest", mcp.WithDescription("The plugin's manifest, for gosidian")), p.handleManifest)
	src := mcp.WithString("source", mcp.Required(), mcp.Description("The source's name"))
	ms.AddTool(mcp.NewTool("gosidian_source_list", mcp.WithDescription("A page of a source's files, by path"), src,
		mcp.WithString("cursor"), mcp.WithNumber("limit")), p.handleList)
	ms.AddTool(mcp.NewTool("gosidian_source_open", mcp.WithDescription("Where to read a file of a source from, ranges too"), src,
		mcp.WithString("path", mcp.Required())), p.handleOpen)
	ms.AddTool(mcp.NewTool("gosidian_source_move", mcp.WithDescription("Move a file, or a folder, inside a source"), src,
		mcp.WithString("from", mcp.Required()), mcp.WithString("to", mcp.Required())), p.handleMove)
	mcpH := server.NewStreamableHTTPServer(ms)
	mux := http.NewServeMux()
	mux.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p.token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+p.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mcpH.ServeHTTP(w, r)
	}))
	mux.HandleFunc(filesPath, p.serveFile)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"status":"ok","version":%q,"sources":%d}`+"\n", version, len(p.sources))
	})
	return mux
}

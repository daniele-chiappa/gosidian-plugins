package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Bridge is the contract of the messages between the page and gosidian's
// window (docs/plugins.md, "The bridge office/1").
const Bridge = "office/1"

// Plugin is gosidian-office: the page of a team's office, which gosidian
// opens in a window of its own for the notes type: team. The page talks to
// that window only (the bridge office/1, over postMessage): the plugin
// serves files and holds no credentials.
type Plugin struct {
	set   Settings
	log   *slog.Logger
	site  *Site
	about *About
}

// NewPlugin is the plugin of its settings, with the page's build and the
// licenses for its references.
func NewPlugin(set Settings, log *slog.Logger) (*Plugin, error) {
	site, err := OpenSite(set.SiteDir, set.FrameAncestors)
	if err != nil {
		return nil, err
	}
	about, err := OpenAbout(set.LicensesDir, set.FrameAncestors)
	if err != nil {
		site.Close()
		return nil, err
	}
	return &Plugin{set: set, log: log, site: site, about: about}, nil
}

// Manifest is what the plugin says of itself: one app, the office, for the
// notes type: team. No nodes, no tools, no files, no network.
func (p *Plugin) Manifest() map[string]any {
	app := map[string]any{"name": "office", "title": "Ufficio", "url": p.set.PublicURL + "/app/",
		"note_type": "team", "bridge": Bridge,
		"description": "Shows a team of agents as an office seen from above: a desk per role, who delegates to whom, each role's state and today's spend, its fields and open tasks"}
	if len(p.set.AltURLs) > 0 {
		alt := make([]string, 0, len(p.set.AltURLs))
		for _, u := range p.set.AltURLs {
			alt = append(alt, u+"/app/")
		}
		app["alt_urls"] = alt
	}
	return map[string]any{
		"name": p.set.Name, "version": version, "gosidian": 1,
		"description": "The office of a team of agents: a map in a window of gosidian, for the notes type: team",
		"apps":        []any{app},
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

// Handler serves the plugin: MCP at /mcp for gosidian (with its token),
// the page at /app/ for gosidian's windows, its references at /app/about,
// and /health.
func (p *Plugin) Handler() http.Handler {
	ms := server.NewMCPServer("gosidian-office", version, server.WithToolCapabilities(false))
	ms.AddTool(mcp.NewTool("gosidian_manifest", mcp.WithDescription("The plugin's manifest, for gosidian")),
		func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) { return p.result(p.Manifest()) })
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
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = fmt.Fprintf(w, `{"status":"ok","version":%q,"bridge":%q}`+"\n", version, Bridge)
	})
	// /app redirects to /app/: the page's addresses are relative.
	mux.Handle("/app/", http.StripPrefix("/app", p.site))
	mux.Handle("/app/about", p.about)
	return securityHeaders(mux)
}

// securityHeaders are those of every answer: no sniffing, no referrer,
// and no frame but for the page and its references, whose CSP names
// gosidian's origins.
func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if !strings.HasPrefix(r.URL.Path, "/app/") {
			w.Header().Set("X-Frame-Options", "DENY")
		}
		h.ServeHTTP(w, r)
	})
}

package main

import (
	"html/template"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// serveWidget serves chat.js, the widget a page loads (built from
// widget/src/chat.ts with the image).
func (p *Plugin) serveWidget(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(filepath.Join(p.set.WidgetDir, "chat.js"))
	if err != nil {
		http.Error(w, "the widget is not there", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(b)
}

var embedPage = template.Must(template.New("embed").Parse(`<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}}</title>
<style>html, body { margin: 0; height: 100%; } #chat { height: 100%; }</style>
</head>
<body>
<div id="chat"></div>
<script src="/chat.js" data-bot="{{.Bot}}" data-container="chat" data-page="1"></script>
</body>
</html>
`))

// serveEmbed serves a bot's page, the chat on its own: what gosidian shows
// in the bot's note, with the reader's token in the fragment (#token=…),
// which the page reads and no log sees.
func (p *Plugin) serveEmbed(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/embed/")
	b, ok := p.bot(name)
	if !ok {
		http.Error(w, "no such bot", http.StatusNotFound)
		return
	}
	title := b.Title
	if title == "" {
		title = b.Name
	}
	// Only gosidian may show the page in a frame: the bot's note, at its
	// public address and at those CHAT_FRAME_ANCESTORS adds.
	ancestors := "'self'"
	if u, err := url.Parse(b.GosidianURL); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && !strings.ContainsAny(u.Host, " ;'\"") {
		ancestors += " " + u.Scheme + "://" + u.Host
	}
	for _, o := range p.set.FrameAncestors {
		ancestors += " " + o
	}
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
		"connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors "+ancestors)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = embedPage.Execute(w, map[string]string{"Title": title, "Bot": b.Name})
}

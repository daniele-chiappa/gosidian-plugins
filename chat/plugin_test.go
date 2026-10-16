package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// fakeGosidian answers the starts of the bot's pipeline as gosidian does:
// the run token, the input, and the answer of a run that waited.
type fakeGosidian struct {
	*httptest.Server
	mu     sync.Mutex
	inputs []map[string]any
	status int // the answer's status; 0: 200
	runOK  bool
}

func newFakeGosidian(t *testing.T) *fakeGosidian {
	t.Helper()
	g := &fakeGosidian{runOK: true}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/pipelines/p/pipelines/bot.md/runs" || r.Header.Get("Authorization") != "Bearer gosidian_run_x" {
			http.Error(w, `{"error":{"message":"invalid run token"}}`, http.StatusUnauthorized)
			return
		}
		var body struct {
			Input map[string]any `json:"input"`
			Wait  int            `json:"wait"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		g.mu.Lock()
		g.inputs = append(g.inputs, body.Input)
		status, ok := g.status, g.runOK
		g.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"run":{"id":"r0","status":"running"}}`))
			return
		}
		run := map[string]any{"id": "r" + string(rune('0'+len(g.inputs))), "status": "done"}
		out := map[string]any{"run": run}
		if !ok {
			run["status"], run["error"] = "failed", "llm: down"
		} else if body.Input["kind"] == "message" {
			out["answer"] = map[string]any{"text": "eco: " + body.Input["message"].(string),
				"sources": []any{map[string]any{"n": 1, "doc": "p/docs/Guida al forno.md"}}}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(g.Close)
	return g
}

func (g *fakeGosidian) last() map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.inputs[len(g.inputs)-1]
}

func sign(secret string, c map[string]any) string {
	h := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	b, _ := json.Marshal(c)
	msg := h + "." + base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(msg))
	return msg + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func testSettings(t *testing.T) Settings {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "chat.js"), []byte("/* widget */"), 0o644); err != nil {
		t.Fatal(err)
	}
	return Settings{Name: "chat", PublicURL: "https://chat.example.com", Token: "tok", Wait: 5 * time.Second, SessionTTL: time.Hour,
		MaxSessions: 100, MaxHistory: 2, PerMinute: 10, PerSession: 100, MaxMessage: 200, IPPerMinute: 100, WidgetDir: dir}
}

func configureArgs(g *fakeGosidian, extra map[string]any) map[string]any {
	a := map[string]any{
		"bot": "docs", "note": "p/bots/docs.md", "title": "Docs <assistant>", "welcome": "Ask me.",
		"scopes": []any{map[string]any{"name": "warehouse", "label": "Warehouse", "filter": map[string]any{"meta": map[string]any{"area": "warehouse"}}},
			map[string]any{"name": "sales", "label": "Sales"}},
		"access": map[string]any{"users": true, "users_secret": "users-secret", "signed_secret": "site-secret", "open": false,
			"keys": []any{map[string]any{"name": "site", "key": "pk-site", "origins": []any{"https://www.example.com"}}}},
		"run":          map[string]any{"url": g.URL + "/api/v1/pipelines/p/pipelines/bot.md/runs", "token": "gosidian_run_x", "pipeline": "p/pipelines/bot.md"},
		"sources":      map[string]any{"base_url": "", "gosidian_url": "https://vault.example.com"},
		"limits":       map[string]any{"per_minute": 5},
		"gosidian_url": "https://vault.example.com",
	}
	for k, v := range extra {
		a[k] = v
	}
	return a
}

func callTool(t *testing.T, fn func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error), args map[string]any) (*mcp.CallToolResult, string) {
	t.Helper()
	var req mcp.CallToolRequest
	req.Params.Arguments = args
	req.Params.Meta = mcp.NewMetaFromMap(map[string]any{metaProject: "p"})
	res, err := fn(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	text := ""
	for _, c := range res.Content {
		if tc, ok := mcp.AsTextContent(c); ok {
			text += tc.Text
		}
	}
	return res, text
}

func newTestPlugin(t *testing.T, extra map[string]any) (*Plugin, *fakeGosidian, http.Handler) {
	t.Helper()
	g := newFakeGosidian(t)
	p := NewPlugin(testSettings(t), slog.New(slog.NewTextHandler(io.Discard, nil)))
	res, text := callTool(t, p.configure, configureArgs(g, extra))
	if res.IsError || !strings.Contains(text, `"embed_url":"https://chat.example.com/embed/docs"`) {
		t.Fatalf("configure: %s", text)
	}
	return p, g, p.Handler()
}

type reply struct {
	code int
	body map[string]any
	hdr  http.Header
}

func do(h http.Handler, method, path, body string, hdr map[string]string) reply {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "192.0.2.10:5000"
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var m map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &m)
	return reply{w.Code, m, w.Header()}
}

func userToken(sub, bot string, exp time.Time) string {
	return sign("users-secret", map[string]any{"iss": "gosidian", "sub": sub, "bot": bot, "exp": exp.Unix(), "iat": time.Now().Unix()})
}

func TestAccess(t *testing.T) {
	_, _, h := newTestPlugin(t, nil)
	msg := `{"message":"ciao"}`
	future, past := time.Now().Add(time.Hour), time.Now().Add(-time.Minute)
	for name, c := range map[string]struct {
		hdr  map[string]string
		want int
		err  string
	}{
		"gosidian's user":     {map[string]string{"Authorization": "Bearer " + userToken("mario", "docs", future)}, 200, ""},
		"expired":             {map[string]string{"Authorization": "Bearer " + userToken("mario", "docs", past)}, 403, "expired"},
		"another bot":         {map[string]string{"Authorization": "Bearer " + userToken("mario", "other", future)}, 403, "another bot"},
		"forged":              {map[string]string{"Authorization": "Bearer " + sign("guess", map[string]any{"iss": "gosidian", "sub": "x", "bot": "docs", "exp": future.Unix()})}, 403, "does not check"},
		"not a JWT":           {map[string]string{"Authorization": "Bearer abc"}, 403, "no JWT"},
		"a site's user":       {map[string]string{"Authorization": "Bearer " + sign("site-secret", map[string]any{"iss": "www.example.com", "sub": "u1", "bot": "docs", "exp": future.Unix()})}, 200, ""},
		"key, its origin":     {map[string]string{"X-Chat-Key": "pk-site", "Origin": "https://www.example.com"}, 200, ""},
		"key, another origin": {map[string]string{"X-Chat-Key": "pk-site", "Origin": "https://evil.example"}, 403, "does not work from"},
		"key, no origin":      {map[string]string{"X-Chat-Key": "pk-site"}, 403, "does not work from"},
		"unknown key":         {map[string]string{"X-Chat-Key": "pk-old", "Origin": "https://www.example.com"}, 403, "no such key"},
		"nothing":             {nil, 403, "wants a token or a key"},
	} {
		r := do(h, http.MethodPost, "/api/bots/docs/messages", msg, c.hdr)
		if r.code != c.want || (c.err != "" && !strings.Contains(r.body["error"].(string), c.err)) {
			t.Errorf("%s: %d %v", name, r.code, r.body)
		}
	}
	// CORS: a key's origin; another origin gets none, but with a token.
	r := do(h, http.MethodOptions, "/api/bots/docs/messages", "", map[string]string{"Origin": "https://www.example.com"})
	if r.code != http.StatusNoContent || r.hdr.Get("Access-Control-Allow-Origin") != "https://www.example.com" {
		t.Errorf("preflight: %d %v", r.code, r.hdr)
	}
	if r := do(h, http.MethodGet, "/api/bots/nobot", "", nil); r.code != 404 {
		t.Errorf("unknown bot: %d", r.code)
	}
	// An open bot takes anyone.
	_, _, open := newTestPlugin(t, map[string]any{"access": map[string]any{"open": true}})
	if r := do(open, http.MethodPost, "/api/bots/docs/messages", msg, nil); r.code != 200 {
		t.Errorf("open: %d %v", r.code, r.body)
	}
	if r := do(open, http.MethodPost, "/api/bots/docs/messages", msg, map[string]string{"Authorization": "Bearer " + userToken("mario", "docs", future)}); r.code != 403 {
		t.Errorf("a gosidian token on a bot without users: %d", r.code)
	}
}

func TestMessagesAndRatings(t *testing.T) {
	p, g, h := newTestPlugin(t, nil)
	auth := map[string]string{"Authorization": "Bearer " + userToken("mario", "docs", time.Now().Add(time.Hour))}
	r := do(h, http.MethodGet, "/api/bots/docs", "", auth)
	if r.code != 200 || r.body["title"] != "Docs <assistant>" || len(r.body["scopes"].([]any)) != 2 {
		t.Fatalf("info: %d %v", r.code, r.body)
	}
	r = do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"come si accende il forno?","scopes":["warehouse"]}`, auth)
	if r.code != 200 {
		t.Fatalf("message: %d %v", r.code, r.body)
	}
	session, turn := r.body["session"].(string), r.body["turn"].(string)
	ans := r.body["answer"].(map[string]any)
	src := ans["sources"].([]any)[0].(map[string]any)
	if ans["text"] != "eco: come si accende il forno?" || turn == "" || src["url"] != "https://vault.example.com/?w=note:p%2Fdocs%2FGuida+al+forno.md" {
		t.Errorf("answer: %v", r.body)
	}
	in := g.last()
	if in["kind"] != "message" || in["user"] != "mario" || in["session"] != session || in["bot"] != "docs" || in["note"] != "p/bots/docs.md" ||
		len(in["scopes"].([]any)) != 1 || in["filters"].([]any)[0].(map[string]any)["meta"] == nil || len(in["history"].([]any)) != 0 {
		t.Errorf("input: %v", in)
	}
	// The next message of the session carries the turns before; no scope
	// chosen is all of them.
	r = do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"e come si pulisce?","session":"`+session+`"}`, auth)
	if r.code != 200 || r.body["session"] != session {
		t.Fatalf("second: %d %v", r.code, r.body)
	}
	in = g.last()
	if h := in["history"].([]any); len(h) != 2 || h[1].(map[string]any)["content"] != "eco: come si accende il forno?" || len(in["scopes"].([]any)) != 2 {
		t.Errorf("history: %v", in)
	}
	// MaxHistory 2: at most two turns, four entries.
	do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"tre","session":"`+session+`"}`, auth)
	do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"quattro","session":"`+session+`"}`, auth)
	if hist := g.last()["history"].([]any); len(hist) != 4 || hist[0].(map[string]any)["content"] != "e come si pulisce?" {
		t.Errorf("history cut: %v", hist)
	}
	// Someone else naming the session gets one of their own.
	other := map[string]string{"Authorization": "Bearer " + userToken("anna", "docs", time.Now().Add(time.Hour))}
	if r := do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"x","session":"`+session+`"}`, other); r.body["session"] == session {
		t.Error("a session taken by another user")
	}
	// Ratings: a turn of the session, by its owner.
	if r := do(h, http.MethodPost, "/api/bots/docs/ratings", `{"session":"`+session+`","turn":"`+turn+`","rating":7,"comment":"ok"}`, auth); r.code != 200 {
		t.Errorf("rating: %d %v", r.code, r.body)
	}
	if in := g.last(); in["kind"] != "rating" || in["turn"] != turn || in["rating"] != float64(7) || in["comment"] != "ok" {
		t.Errorf("rating input: %v", in)
	}
	for body, want := range map[string]int{
		`{"session":"` + session + `","turn":"nope","rating":7}`:           400,
		`{"session":"` + session + `","turn":"` + turn + `","rating":11}`:  400,
		`{"session":"` + session + `","turn":"` + turn + `","rating":2.5}`: 400,
		`{"session":"none","turn":"` + turn + `","rating":1}`:              404,
	} {
		if r := do(h, http.MethodPost, "/api/bots/docs/ratings", body, auth); r.code != want {
			t.Errorf("%s: %d, want %d", body, r.code, want)
		}
	}
	if r := do(h, http.MethodPost, "/api/bots/docs/ratings", `{"session":"`+session+`","turn":"`+turn+`","rating":1}`, other); r.code != 404 {
		t.Errorf("a rating by another user: %d", r.code)
	}
	// Refusals of a message.
	for body, want := range map[string]int{`{"message":"  "}`: 400, `{"message":"` + strings.Repeat("x", 201) + `"}`: 400,
		`{"message":"x","scopes":["hr"]}`: 400, `not json`: 400} {
		if r := do(h, http.MethodPost, "/api/bots/docs/messages", body, auth); r.code != want {
			t.Errorf("%.40s: %d, want %d", body, r.code, want)
		}
	}
	// What gosidian answers.
	g.mu.Lock()
	g.status = http.StatusAccepted
	g.mu.Unlock()
	if r := do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"slow"}`, auth); r.code != http.StatusGatewayTimeout {
		t.Errorf("202: %d", r.code)
	}
	g.mu.Lock()
	g.status, g.runOK = 0, false
	g.mu.Unlock()
	if r := do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"fails"}`, auth); r.code != http.StatusBadGateway {
		t.Errorf("failed run: %d", r.code)
	}
	// Taken out: gone, its conversations with it.
	res, _ := callTool(t, p.remove, map[string]any{"bot": "docs"})
	if res.IsError {
		t.Fatal("remove")
	}
	if r := do(h, http.MethodGet, "/api/bots/docs", "", auth); r.code != 404 {
		t.Errorf("after remove: %d", r.code)
	}
}

func TestLimits(t *testing.T) {
	_, _, h := newTestPlugin(t, map[string]any{"limits": map[string]any{"per_minute": 2, "max_message": 10}})
	auth := map[string]string{"Authorization": "Bearer " + userToken("mario", "docs", time.Now().Add(time.Hour))}
	r := do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"uno"}`, auth)
	s := r.body["session"].(string)
	do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"due","session":"`+s+`"}`, auth)
	if r := do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"tre","session":"`+s+`"}`, auth); r.code != 429 || r.hdr.Get("Retry-After") != "60" {
		t.Errorf("per_minute: %d %v", r.code, r.body)
	}
	if r := do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"undici car."}`, auth); r.code != 400 {
		t.Errorf("max_message: %d", r.code)
	}
}

func TestEmbedAndWidget(t *testing.T) {
	p, _, h := newTestPlugin(t, nil)
	p.set.FrameAncestors = []string{"http://127.0.0.1:8084"}
	req := httptest.NewRequest(http.MethodGet, "/embed/docs", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	body := w.Body.String()
	csp := w.Header().Get("Content-Security-Policy")
	if w.Code != 200 || !strings.Contains(body, "<title>Docs &lt;assistant&gt;</title>") || !strings.Contains(body, `data-bot="docs"`) ||
		!strings.HasSuffix(csp, "frame-ancestors 'self' https://vault.example.com http://127.0.0.1:8084") || w.Header().Get("X-Frame-Options") != "" {
		t.Errorf("embed: %d %s %s", w.Code, csp, body)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/embed/none", nil))
	if w.Code != 404 {
		t.Errorf("unknown bot's page: %d", w.Code)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/chat.js", nil))
	if w.Code != 200 || w.Body.String() != "/* widget */" || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/javascript") || w.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("widget: %d %v", w.Code, w.Header())
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("{}")))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("/mcp without the token: %d", w.Code)
	}
}

func TestConfigureRefusals(t *testing.T) {
	g := newFakeGosidian(t)
	p := NewPlugin(testSettings(t), slog.New(slog.NewTextHandler(io.Discard, nil)))
	for name, extra := range map[string]map[string]any{
		"bad name":         {"bot": "Docs"},
		"no run":           {"run": map[string]any{}},
		"users, no secret": {"access": map[string]any{"users": true}},
		"nobody":           {"access": map[string]any{"users": false}},
		"key, no origins":  {"access": map[string]any{"keys": []any{map[string]any{"name": "s", "key": "k"}}}},
		"scope twice":      {"scopes": []any{map[string]any{"name": "a"}, map[string]any{"name": "a"}}},
	} {
		if res, text := callTool(t, p.configure, configureArgs(g, extra)); !res.IsError {
			t.Errorf("%s: accepted: %s", name, text)
		}
	}
}

func TestSourceLinks(t *testing.T) {
	p := NewPlugin(testSettings(t), slog.New(slog.NewTextHandler(io.Discard, nil)))
	b := &Bot{Name: "docs", Project: "p", GosidianURL: "https://vault.example.com"}
	b.Sources.BaseURL = "https://docs.example.com/manual/"
	ans := map[string]any{"sources": []any{map[string]any{"doc": "p/documents/Guida al forno.md"}, map[string]any{"doc": "x", "url": "kept"}, "text"}}
	p.sourceLinks(b, ans)
	list := ans["sources"].([]any)
	if list[0].(map[string]any)["url"] != "https://docs.example.com/manual/documents/Guida%20al%20forno" || list[1].(map[string]any)["url"] != "kept" {
		t.Errorf("%v", list)
	}
}

func TestSettings(t *testing.T) {
	env := func(kv ...string) func(string) string {
		m := map[string]string{}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return func(k string) string { return m[k] }
	}
	s, err := LoadSettings(env("CHAT_PUBLIC_URL", "https://chat.example.com/", "CHAT_FRAME_ANCESTORS", "http://127.0.0.1:8084/, https://vault2.example.com"))
	if err == nil && strings.Join(s.FrameAncestors, " ") != "http://127.0.0.1:8084 https://vault2.example.com" {
		t.Errorf("frame ancestors: %v", s.FrameAncestors)
	}
	if err != nil || s.Name != "chat" || s.PublicURL != "https://chat.example.com" || s.Wait != time.Minute || s.PerMinute != 10 || s.MaxHistory != 10 {
		t.Fatalf("%+v %v", s, err)
	}
	for _, bad := range [][]string{{}, {"CHAT_PUBLIC_URL", "chat.example.com"}, {"CHAT_PUBLIC_URL", "https://c.example", "CHAT_NAME", "Chat"},
		{"CHAT_PUBLIC_URL", "https://c.example", "CHAT_WAIT", "60"}, {"CHAT_PUBLIC_URL", "https://c.example", "CHAT_PER_MINUTE", "0"},
		{"CHAT_PUBLIC_URL", "https://c.example", "CHAT_TRUST_PROXY", "maybe"},
		{"CHAT_PUBLIC_URL", "https://c.example", "CHAT_FRAME_ANCESTORS", "https://a.example; script-src *"},
		{"CHAT_PUBLIC_URL", "https://c.example", "CHAT_FRAME_ANCESTORS", "https://a.example/path"}} {
		if _, err := LoadSettings(env(bad...)); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
	if clientIP(r, false) != "10.0.0.1" || clientIP(r, true) != "203.0.113.7" {
		t.Errorf("%s %s", clientIP(r, false), clientIP(r, true))
	}
}

func TestManifest(t *testing.T) {
	p := NewPlugin(testSettings(t), slog.New(slog.NewTextHandler(io.Discard, nil)))
	b, _ := json.Marshal(p.Manifest())
	var m struct {
		Name  string `json:"name"`
		Tools []struct {
			Name, Access string
		} `json:"tools"`
	}
	_ = json.Unmarshal(b, &m)
	if m.Name != "chat" || len(m.Tools) != 2 || m.Tools[0].Name != "chat_configure" || m.Tools[0].Access != "write" || m.Tools[1].Name != "chat_remove" {
		t.Errorf("%s", b)
	}
	// gosidian refuses a tool whose input names project: it is in _meta.
	if strings.Contains(string(b), `"project"`) {
		t.Errorf("a tool takes project: %s", b)
	}
}

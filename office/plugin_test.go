package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
)

func testEnv(t *testing.T) map[string]string {
	t.Helper()
	return map[string]string{
		"OFFICE_PUBLIC_URL":      "https://office.example.com/",
		"OFFICE_FRAME_ANCESTORS": "https://vault.example.com, http://127.0.0.1:8084/",
		"OFFICE_SITE_DIR":        testSite(t),
		"OFFICE_LICENSES_DIR":    testLicenses(t),
		"GOSIDIAN_PLUGIN_TOKEN":  "secret",
	}
}

func testSettings(t *testing.T) Settings {
	t.Helper()
	env := testEnv(t)
	s, err := LoadSettings(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// testLicenses writes what the image keeps of the licenses.
func testLicenses(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"assets/ASSETS.tsv": "file\ttitle\tauthor\tpack\tpack_url\tsource\tlicense\n" +
			"character-male-a.glb\tcharacter-male-a\tKenney\tMini Characters 2.0\thttps://kenney.nl/assets/mini-characters\thttps://kenney.nl/assets/mini-characters\tCC0-1.0\n" +
			"chair_A.glb\tchair_A\tKay Lousberg\tKayKit Furniture Bits 1.0\tjavascript:alert(1)\thttps://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0\tCC0-1.0\n",
		"assets/LICENSE-KayKit-Furniture-Bits.txt":  "KayKit <CC0>",
		"assets/LICENSE-Kenney-Mini-Characters.txt": "Mini Characters (2.0), Kenney, CC0",
		"web/INDEX":             "three\t0.187.0\tMIT\tLICENSE\n",
		"web/three/LICENSE":     "The MIT License, three.js authors",
		"go-modules/INDEX":      "go go1.27.0 LICENSE\ngithub.com/mark3labs/mcp-go v1.3.0 LICENSE\n",
		"go-modules/go/LICENSE": "Go",
	}
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func testPlugin(t *testing.T) *Plugin {
	t.Helper()
	p, err := NewPlugin(testSettings(t), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSettings(t *testing.T) {
	s := testSettings(t)
	if s.Name != "office" || s.PublicURL != "https://office.example.com" || s.Token != "secret" {
		t.Errorf("settings %+v", s)
	}
	if strings.Join(s.FrameAncestors, " ") != "https://vault.example.com http://127.0.0.1:8084" {
		t.Errorf("frame ancestors %q", s.FrameAncestors)
	}
	d, err := LoadSettings(func(k string) string {
		return map[string]string{"OFFICE_PUBLIC_URL": "http://x", "OFFICE_FRAME_ANCESTORS": "http://y"}[k]
	})
	if err != nil || d.SiteDir != "/usr/share/gosidian-office/site" || d.LicensesDir != "/licenses" {
		t.Errorf("defaults %+v %v", d, err)
	}
	for name, env := range map[string]map[string]string{
		"no public address":                 {"OFFICE_FRAME_ANCESTORS": "https://vault.example.com"},
		"a query in the address":            {"OFFICE_PUBLIC_URL": "https://x.example.com/?a", "OFFICE_FRAME_ANCESTORS": "https://vault.example.com"},
		"credentials in the address":        {"OFFICE_PUBLIC_URL": "https://u:p@x.example.com", "OFFICE_FRAME_ANCESTORS": "https://vault.example.com"},
		"no frame ancestor":                 {"OFFICE_PUBLIC_URL": "https://x.example.com"},
		"an ancestor with a path":           {"OFFICE_PUBLIC_URL": "https://x.example.com", "OFFICE_FRAME_ANCESTORS": "https://vault.example.com/notes"},
		"an ancestor that adds a directive": {"OFFICE_PUBLIC_URL": "https://x.example.com", "OFFICE_FRAME_ANCESTORS": "https://vault.example.com;script-src *"},
		"a wildcard ancestor":               {"OFFICE_PUBLIC_URL": "https://x.example.com", "OFFICE_FRAME_ANCESTORS": "*"},
		"a bad name":                        {"OFFICE_PUBLIC_URL": "https://x.example.com", "OFFICE_FRAME_ANCESTORS": "https://v.example.com", "OFFICE_NAME": "Office!"},
		"gosidian's own name":               {"OFFICE_PUBLIC_URL": "https://x.example.com", "OFFICE_FRAME_ANCESTORS": "https://v.example.com", "OFFICE_NAME": "memory"},
	} {
		if _, err := LoadSettings(func(k string) string { return env[k] }); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestAltURLs(t *testing.T) {
	env := map[string]string{"OFFICE_PUBLIC_URL": "https://x.example.com", "OFFICE_FRAME_ANCESTORS": "https://v.example.com"}
	getenv := func(k string) string { return env[k] }
	if s, err := LoadSettings(getenv); err != nil || s.AltURLs != nil {
		t.Fatalf("none: %+v %v", s.AltURLs, err)
	}
	env["OFFICE_ALT_URLS"] = "http://127.0.0.1:8099/, http://localhost:8099"
	s, err := LoadSettings(getenv)
	if err != nil || strings.Join(s.AltURLs, " ") != "http://127.0.0.1:8099 http://localhost:8099" {
		t.Fatalf("%+v %v", s.AltURLs, err)
	}
	for _, bad := range []string{"127.0.0.1:8099", "ftp://x.example.com", "https://x.example.com/?a", "a,b,c,d,e"} {
		env["OFFICE_ALT_URLS"] = bad
		if bad == "a,b,c,d,e" {
			env["OFFICE_ALT_URLS"] = "http://a, http://b, http://c, http://d, http://e"
		}
		if _, err := LoadSettings(getenv); err == nil {
			t.Errorf("%s: no error", bad)
		}
	}
	p := testPlugin(t)
	app := func() map[string]any { return p.Manifest()["apps"].([]any)[0].(map[string]any) }
	if _, ok := app()["alt_urls"]; ok {
		t.Error("no other address, and the manifest lists some: the sha of every install would change")
	}
	p.set.AltURLs = []string{"http://127.0.0.1:8099"}
	if got, _ := app()["alt_urls"].([]string); len(got) != 1 || got[0] != "http://127.0.0.1:8099/app/" {
		t.Errorf("alt_urls %v", app()["alt_urls"])
	}
}

type manifest struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Gosidian    int    `json:"gosidian"`
	Description string `json:"description"`
	Apps        []struct {
		Name        string   `json:"name"`
		Title       string   `json:"title"`
		URL         string   `json:"url"`
		AltURLs     []string `json:"alt_urls"`
		NoteType    string   `json:"note_type"`
		Bridge      string   `json:"bridge"`
		Description string   `json:"description"`
	} `json:"apps"`
	Nodes       []any `json:"nodes"`
	Tools       []any `json:"tools"`
	Permissions struct {
		Files   bool     `json:"files"`
		Network []string `json:"network"`
	} `json:"permissions"`
}

func checkManifest(t *testing.T, m manifest, raw string) {
	t.Helper()
	if m.Name != "office" || m.Gosidian != 1 || m.Version == "" || m.Description == "" ||
		len(m.Tools) != 0 || len(m.Nodes) != 0 || m.Permissions.Files || m.Permissions.Network == nil || len(m.Permissions.Network) != 0 {
		t.Errorf("manifest %s", raw)
	}
	if len(m.Apps) != 1 {
		t.Fatalf("apps %s", raw)
	}
	a := m.Apps[0]
	if a.Name != "office" || a.Title != "Ufficio" || a.URL != "https://office.example.com/app/" || a.NoteType != "team" ||
		a.Bridge != "office/1" || a.Description == "" {
		t.Errorf("app %+v", a)
	}
}

func TestManifest(t *testing.T) {
	b, err := json.Marshal(testPlugin(t).Manifest())
	if err != nil {
		t.Fatal(err)
	}
	var m manifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	checkManifest(t, m, string(b))
}

// TestMCP asks for the manifest the way gosidian does: a session on /mcp
// with the token, and nothing without it.
func TestMCP(t *testing.T) {
	ts := httptest.NewServer(testPlugin(t).Handler())
	defer ts.Close()

	for _, auth := range []string{"", "Bearer wrong", "Bearer secret2", "secret"} {
		req, _ := http.NewRequest("POST", ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		req.Header.Set("Content-Type", "application/json")
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("token %q: %d", auth, resp.StatusCode)
		}
		if resp.Header.Get("X-Frame-Options") != "DENY" {
			t.Errorf("/mcp: X-Frame-Options %q", resp.Header.Get("X-Frame-Options"))
		}
	}

	ctx := context.Background()
	c, err := client.NewStreamableHttpClient(ts.URL+"/mcp", transport.WithHTTPHeaders(map[string]string{"Authorization": "Bearer secret"}))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Start(ctx); err != nil {
		t.Fatal(err)
	}
	var init mcp.InitializeRequest
	init.Params.ProtocolVersion = mcp.LATEST_PROTOCOL_VERSION
	init.Params.ClientInfo = mcp.Implementation{Name: "test", Version: "0"}
	if _, err := c.Initialize(ctx, init); err != nil {
		t.Fatal(err)
	}
	tools, err := c.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil || len(tools.Tools) != 1 || tools.Tools[0].Name != "gosidian_manifest" {
		t.Fatalf("tools: %+v %v", tools, err)
	}
	var req mcp.CallToolRequest
	req.Params.Name = "gosidian_manifest"
	res, err := c.CallTool(ctx, req)
	if err != nil || res.IsError {
		t.Fatalf("gosidian_manifest: %+v %v", res, err)
	}
	raw, _ := json.Marshal(res.StructuredContent)
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	checkManifest(t, m, string(raw))
}

func TestRoutes(t *testing.T) {
	h := testPlugin(t).Handler()

	w := get(t, h, "GET", "/app?host=gosidian&origin=https%3A%2F%2Fvault.example.com&lang=it", "")
	if w.Code/100 != 3 || w.Header().Get("Location") != "/app/?host=gosidian&origin=https%3A%2F%2Fvault.example.com&lang=it" {
		t.Errorf("/app: %d %q, the relative addresses of the page want the slash", w.Code, w.Header().Get("Location"))
	}
	w = get(t, h, "GET", "/app/?host=gosidian&lang=it", "")
	if w.Code != http.StatusOK || w.Header().Get("Content-Security-Policy") != PageCSP([]string{"https://vault.example.com", "http://127.0.0.1:8084"}) {
		t.Errorf("/app/: %d %q", w.Code, w.Header().Get("Content-Security-Policy"))
	}
	if w.Header().Get("X-Frame-Options") != "" {
		t.Errorf("/app/: X-Frame-Options %q, the CSP says who frames it", w.Header().Get("X-Frame-Options"))
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("/app/ headers %v", w.Header())
	}
	if w := get(t, h, "GET", "/app/assets/index-D9ioIDZp.js", "br"); w.Code != http.StatusOK || w.Header().Get("Content-Encoding") != "br" {
		t.Errorf("/app/ script: %d %q", w.Code, w.Header().Get("Content-Encoding"))
	}

	w = get(t, h, "GET", "/health", "")
	var health map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &health)
	if w.Code != http.StatusOK || health["status"] != "ok" || health["version"] != version || health["bridge"] != "office/1" {
		t.Errorf("/health: %d %s", w.Code, w.Body)
	}
	if w.Header().Get("X-Frame-Options") != "DENY" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("/health headers %v", w.Header())
	}
	if w := get(t, h, "GET", "/", ""); w.Code != http.StatusNotFound || w.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("/: %d %v", w.Code, w.Header())
	}
}

func TestAbout(t *testing.T) {
	h := testPlugin(t).Handler()
	w := get(t, h, "GET", "/app/about", "")
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("/app/about: %d %q", w.Code, w.Header().Get("Content-Type"))
	}
	body := w.Body.String()
	for _, want := range []string{
		"MIT License", "three.js",
		"<td>character-male-a</td><td>Kenney</td>",
		`href="https://kenney.nl/assets/mini-characters"`, ">kenney.nl</a>",
		"Mini Characters (2.0), Kenney, CC0",
		`href="https://creativecommons.org/publicdomain/zero/1.0/"`,
		"KayKit &lt;CC0&gt;",
		"<td>three</td><td>0.187.0</td><td>MIT</td>", "The MIT License, three.js authors",
		"<td>github.com/mark3labs/mcp-go</td><td>v1.3.0</td>",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/app/about has no %q", want)
		}
	}
	if strings.Contains(body, "javascript:") {
		t.Error("/app/about links an address that is not https")
	}
	csp := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "default-src 'none'") || !strings.Contains(csp, "frame-ancestors https://vault.example.com http://127.0.0.1:8084") ||
		strings.Contains(csp, "script-src") || strings.Contains(csp, "unsafe-inline") {
		t.Errorf("/app/about CSP %q", csp)
	}
	if !strings.Contains(body, "<style>"+aboutStyle+"</style>") {
		t.Error("the style of /app/about is not the one its CSP admits")
	}
	if w.Header().Get("X-Frame-Options") != "" {
		t.Errorf("/app/about: X-Frame-Options %q, the window shows it in a frame", w.Header().Get("X-Frame-Options"))
	}
	if w := get(t, h, "POST", "/app/about", ""); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /app/about: %d", w.Code)
	}
}

func TestPluginNeedsItsFiles(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := testSettings(t)
	s.LicensesDir = t.TempDir()
	if _, err := NewPlugin(s, log); err == nil || !strings.Contains(err.Error(), "licenses") {
		t.Errorf("no licenses: %v", err)
	}
	s = testSettings(t)
	s.SiteDir = t.TempDir()
	if _, err := NewPlugin(s, log); err == nil || !strings.Contains(err.Error(), "index.html") {
		t.Errorf("no build: %v", err)
	}
}

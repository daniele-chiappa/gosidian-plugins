package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testIndex = "<!doctype html>\n<html><head>\n<script type=\"module\" crossorigin src=\"./assets/index-D9ioIDZp.js\"></script>\n" +
	"<link rel=\"stylesheet\" crossorigin href=\"./assets/index-CRBbJqEv.css\">\n</head><body></body></html>\n"

// testSite writes a build as Vite and compress.mjs do: index.html, the
// hashed files of assets/ with their precompressed copies, the models, a
// dotfile, and a link out of the build.
func testSite(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	site := filepath.Join(dir, "site")
	files := map[string]string{
		"secret.txt":                       "outside the build",
		"site/index.html":                  testIndex,
		"site/index.html.br":               "index-br",
		"site/index.html.gz":               "index-gz",
		"site/assets/index-D9ioIDZp.js":    "js",
		"site/assets/index-D9ioIDZp.js.br": "js-br",
		"site/assets/index-D9ioIDZp.js.gz": "js-gz",
		"site/assets/index-CRBbJqEv.css":   "css",
		"site/models/character.glb":        "glTF",
		"site/models/character.glb.br":     "glb-br",
		"site/.hidden":                     "dot",
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
	if err := os.Symlink("../secret.txt", filepath.Join(site, "link.txt")); err != nil {
		t.Fatal(err)
	}
	return site
}

func openTestSite(t *testing.T) *Site {
	t.Helper()
	s, err := OpenSite(testSite(t), []string{"https://vault.example.com", "http://127.0.0.1:8084"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func get(t *testing.T, h http.Handler, method, target, accept string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, nil)
	if accept != "" {
		r.Header.Set("Accept-Encoding", accept)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestSiteIndex(t *testing.T) {
	s := openTestSite(t)
	w := get(t, s, "GET", "/", "")
	body, _ := io.ReadAll(w.Body)
	if w.Code != http.StatusOK || string(body) != testIndex {
		t.Fatalf("index: %d %q", w.Code, body)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("Content-Type %q", ct)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control %q: the page is checked again on every visit", cc)
	}
	csp := w.Header().Get("Content-Security-Policy")
	for _, want := range []string{
		"default-src 'self'",
		"script-src 'self';",
		"style-src 'self';",
		"img-src 'self' data: blob:",
		// The models' textures: three.js reads them back from blob: with fetch.
		"connect-src 'self' blob:;",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors https://vault.example.com http://127.0.0.1:8084",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP %q lacks %q", csp, want)
		}
	}
	for _, never := range []string{"unsafe-inline", "unsafe-eval", "*"} {
		if strings.Contains(csp, never) {
			t.Errorf("CSP %q has %s", csp, never)
		}
	}
}

func TestSiteEncodings(t *testing.T) {
	s := openTestSite(t)
	for _, c := range []struct {
		target, accept, enc, body, ctype string
	}{
		{"/assets/index-D9ioIDZp.js", "gzip, deflate, br", "br", "js-br", "text/javascript; charset=utf-8"},
		{"/assets/index-D9ioIDZp.js", "gzip", "gzip", "js-gz", "text/javascript; charset=utf-8"},
		{"/assets/index-D9ioIDZp.js", "br;q=0, gzip", "gzip", "js-gz", "text/javascript; charset=utf-8"},
		{"/assets/index-D9ioIDZp.js", "*", "br", "js-br", "text/javascript; charset=utf-8"},
		{"/assets/index-D9ioIDZp.js", "", "", "js", "text/javascript; charset=utf-8"},
		{"/assets/index-CRBbJqEv.css", "br", "", "css", "text/css; charset=utf-8"},
		{"/models/character.glb", "br", "br", "glb-br", "model/gltf-binary"},
		{"/models/character.glb", "gzip", "", "glTF", "model/gltf-binary"},
		{"/index.html", "br", "br", "index-br", "text/html; charset=utf-8"},
	} {
		w := get(t, s, "GET", c.target, c.accept)
		body, _ := io.ReadAll(w.Body)
		if w.Code != http.StatusOK || string(body) != c.body || w.Header().Get("Content-Encoding") != c.enc {
			t.Errorf("%s with %q: %d %q %q, want %q %q", c.target, c.accept, w.Code, w.Header().Get("Content-Encoding"), body, c.enc, c.body)
		}
		if ct := w.Header().Get("Content-Type"); ct != c.ctype {
			t.Errorf("%s: Content-Type %q, want %q", c.target, ct, c.ctype)
		}
		if v := w.Header().Get("Vary"); v != "Accept-Encoding" {
			t.Errorf("%s: Vary %q", c.target, v)
		}
	}
}

func TestSiteCache(t *testing.T) {
	s := openTestSite(t)
	for target, want := range map[string]string{
		"/":                          "no-cache",
		"/index.html":                "no-cache",
		"/models/character.glb":      "no-cache",
		"/assets/index-D9ioIDZp.js":  "public, max-age=31536000, immutable",
		"/assets/index-CRBbJqEv.css": "public, max-age=31536000, immutable",
	} {
		w := get(t, s, "GET", target, "")
		if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != want {
			t.Errorf("%s: %d Cache-Control %q, want %q", target, w.Code, w.Header().Get("Cache-Control"), want)
		}
	}
	if w := get(t, s, "HEAD", "/assets/index-D9ioIDZp.js", "br"); w.Code != http.StatusOK || w.Body.Len() != 0 || w.Header().Get("Content-Encoding") != "br" {
		t.Errorf("HEAD: %d %q, %d bytes", w.Code, w.Header().Get("Content-Encoding"), w.Body.Len())
	}
}

func TestSiteRefusals(t *testing.T) {
	s := openTestSite(t)
	for _, target := range []string{
		"/.hidden",                     // a dotfile
		"/assets/index-D9ioIDZp.js.br", // the precompressed copies go by Accept-Encoding only
		"/assets/index-D9ioIDZp.js.gz",
		"/link.txt", // a link out of the build
		"/../secret.txt",
		"/missing.js",
		"/assets/", // a folder
		"/models",
	} {
		if w := get(t, s, "GET", target, ""); w.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", target, w.Code)
		}
	}
	w := get(t, s, "POST", "/", "")
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
		t.Errorf("POST: %d Allow %q", w.Code, w.Header().Get("Allow"))
	}
}

func TestOpenSiteRefusals(t *testing.T) {
	ancestors := []string{"https://vault.example.com"}
	dir := testSite(t)
	if err := os.Remove(filepath.Join(dir, "index.html")); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSite(dir, ancestors); err == nil || !strings.Contains(err.Error(), "index.html") {
		t.Errorf("no index.html: %v", err)
	}
	if _, err := OpenSite(testSite(t), nil); err == nil || !strings.Contains(err.Error(), "frame") {
		t.Errorf("no one may frame the office: %v", err)
	}
	for name, index := range map[string]string{
		"inline script":            "<html><head><script>alert(1)</script></head></html>",
		"script with src and code": "<html><head><script src=\"a.js\">alert(1)</script></head></html>",
		"style element":            "<html><head><style>body{}</style></head></html>",
		"style attribute":          "<html><body style=\"margin:0\"></body></html>",
	} {
		dir := testSite(t)
		if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(index), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenSite(dir, ancestors); err == nil || !strings.Contains(err.Error(), "inline") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// TestSiteServesTheBuild opens the page's real build when there is one
// (web/dist, after npm run build): it has no inline code.
func TestSiteServesTheBuild(t *testing.T) {
	dist := filepath.Join("web", "dist")
	if _, err := os.Stat(filepath.Join(dist, "index.html")); err != nil {
		t.Skip("no web/dist: the page is not built here")
	}
	s, err := OpenSite(dist, []string{"https://vault.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if w := get(t, s, "GET", "/models/character-male-a.glb", ""); w.Code != http.StatusOK || w.Header().Get("Content-Type") != "model/gltf-binary" {
		t.Errorf("character-male-a.glb: %d %q", w.Code, w.Header().Get("Content-Type"))
	}
}

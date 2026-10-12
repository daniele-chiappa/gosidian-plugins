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
	"sync/atomic"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
	"golang.org/x/net/webdav"
)

func write(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// davServer is a WebDAV server on dir, with basic auth u/p, counting its
// requests.
func davServer(t *testing.T, dir string) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	h := &webdav.Handler{FileSystem: webdav.Dir(dir), LockSystem: webdav.NewMemLS()}
	var n atomic.Int64
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		if u, pw, ok := r.BasicAuth(); !ok || u != "u" || pw != "p" {
			w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(ts.Close)
	return ts, &n
}

func credentials(t *testing.T, user, pass string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "cred")
	if err := os.WriteFile(p, []byte(user+"\n"+pass+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func seed(t *testing.T) string {
	dir := t.TempDir()
	write(t, dir, "a.txt", "alpha")
	write(t, dir, "2024/b.pdf", "%PDF-b content")
	write(t, dir, "2024/c.xml", "<c/>")
	write(t, dir, "2024/sub/d.txt", "delta")
	write(t, dir, "e f.txt", "with a space")
	return dir
}

func TestLoadConfig(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.yaml")
	write(t, dir, "good.yaml", `sources:
  - {name: cloud, kind: webdav, url: "http://192.0.2.81/remote.php/dav/files/x/y/", vendor: nextcloud, credentials: /run/secrets/nc, move: true}
  - {name: archive, kind: local, path: /data/archive}
`)
	c, err := LoadConfig(good)
	if err != nil {
		t.Fatal(err)
	}
	if h := c.Hosts(); len(h) != 1 || h[0] != "192.0.2.81" {
		t.Errorf("hosts %v", h)
	}
	for name, body := range map[string]string{
		"empty":       "sources: []\n",
		"name":        "sources: [{name: NC, kind: local, path: /x}]\n",
		"twice":       "sources: [{name: a, kind: local, path: /x}, {name: a, kind: local, path: /y}]\n",
		"kind":        "sources: [{name: a, kind: ftp}]\n",
		"url":         "sources: [{name: a, kind: webdav, url: 'ftp://x', credentials: /c}]\n",
		"userinfo":    "sources: [{name: a, kind: webdav, url: 'http://u:p@x/', credentials: /c}]\n",
		"no cred":     "sources: [{name: a, kind: webdav, url: 'http://x/'}]\n",
		"vendor":      "sources: [{name: a, kind: webdav, url: 'http://x/', vendor: dropbox, credentials: /c}]\n",
		"relative":    "sources: [{name: a, kind: local, path: data}]\n",
		"unknown key": "sources: [{name: a, kind: local, path: /x, password: hunter2}]\n",
	} {
		p := filepath.Join(dir, "bad.yaml")
		write(t, dir, "bad.yaml", body)
		if _, err := LoadConfig(p); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func webdavSource(t *testing.T, url, cred string, move bool) *Source {
	return newSource(SourceConfig{Name: "dav", Kind: KindWebDAV, URL: url, Vendor: "other", Credentials: cred, Move: move})
}

func TestSource_ListPagesOpenAndMove(t *testing.T) {
	for _, kind := range []string{KindWebDAV, KindLocal} {
		t.Run(kind, func(t *testing.T) {
			dir := seed(t)
			var s *Source
			if kind == KindWebDAV {
				ts, _ := davServer(t, dir)
				s = webdavSource(t, ts.URL+"/", credentials(t, "u", "p"), true)
			} else {
				s = newSource(SourceConfig{Name: "loc", Kind: KindLocal, Path: dir, Move: true})
			}
			ctx := context.Background()
			var all []File
			page, err := s.List(ctx, "", 2)
			for {
				if err != nil {
					t.Fatal(err)
				}
				all = append(all, page.Files...)
				if page.Next == "" {
					break
				}
				page, err = s.List(ctx, page.Next, 2)
			}
			var paths []string
			for _, f := range all {
				paths = append(paths, f.Path)
			}
			if strings.Join(paths, ",") != "2024/b.pdf,2024/c.xml,2024/sub/d.txt,a.txt,e f.txt" {
				t.Fatalf("paths %v", paths)
			}
			b := all[0]
			if b.Size != int64(len("%PDF-b content")) || b.ETag == "" || b.Modified.IsZero() {
				t.Errorf("b.pdf %+v", b)
			}
			if _, err := s.List(ctx, "gone:2", 2); err == nil {
				t.Error("a cursor of no list")
			}

			// Read from an offset, as a range is.
			o, err := s.Object(ctx, "2024/b.pdf")
			if err != nil {
				t.Fatal(err)
			}
			r := newObjectReader(ctx, o)
			if _, err := r.Seek(7, io.SeekStart); err != nil {
				t.Fatal(err)
			}
			rest, err := io.ReadAll(r)
			r.Close()
			if err != nil || string(rest) != "content" {
				t.Errorf("from 7: %q %v", rest, err)
			}

			// Moves: a file, then a folder; the etag stays.
			moved, err := s.Move(ctx, "2024/b.pdf", "done/b.pdf")
			if err != nil || moved.Path != "done/b.pdf" || moved.Size != b.Size {
				t.Fatalf("move %+v %v", moved, err)
			}
			if _, err := os.Stat(filepath.Join(dir, "done", "b.pdf")); err != nil {
				t.Error("not moved on the disk")
			}
			if _, err := s.Move(ctx, "a.txt", "done/b.pdf"); err == nil {
				t.Error("moved onto a file there")
			}
			if _, err := s.Move(ctx, "2024/sub", "archive/sub"); err != nil {
				t.Errorf("folder: %v", err)
			}
			if _, err := os.Stat(filepath.Join(dir, "archive", "sub", "d.txt")); err != nil {
				t.Error("the folder is not moved")
			}
			for _, bad := range []string{"../x", "/etc/passwd", "a/../b", "", "./a"} {
				if _, err := s.Object(ctx, bad); err == nil {
					t.Errorf("path %q accepted", bad)
				}
			}
		})
	}
}

func TestSource_NoMoveWithoutMove(t *testing.T) {
	s := newSource(SourceConfig{Name: "loc", Kind: KindLocal, Path: seed(t)})
	if _, err := s.Move(context.Background(), "a.txt", "b.txt"); err == nil || !strings.Contains(err.Error(), "move: false") {
		t.Errorf("move without move: %v", err)
	}
}

// A source that refuses its credentials is not asked again for a while.
func TestSource_RefusedCredentials(t *testing.T) {
	ts, n := davServer(t, seed(t))
	s := webdavSource(t, ts.URL+"/", credentials(t, "u", "wrong"), false)
	now := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	ctx := context.Background()
	if _, err := s.List(ctx, "", 10); err == nil || !strings.Contains(err.Error(), "refused its credentials") {
		t.Fatalf("list: %v", err)
	}
	before := n.Load()
	if _, err := s.List(ctx, "", 10); err == nil || !strings.Contains(err.Error(), "not asked again") {
		t.Errorf("again: %v", err)
	}
	if _, err := s.Object(ctx, "a.txt"); err == nil {
		t.Error("an open while it waits")
	}
	if n.Load() != before {
		t.Errorf("the server was asked again while it waits: %d requests", n.Load()-before)
	}
	now = now.Add(authWait + time.Second)
	if _, err := s.List(ctx, "", 10); err == nil || !strings.Contains(err.Error(), "refused its credentials (401") {
		t.Errorf("after the wait: %v", err)
	}
}

// The plugin as gosidian talks with it: MCP with its token, the manifest,
// the tools, and a file read in ranges from the URL open gives.
func TestPlugin_MCP(t *testing.T) {
	dir := seed(t)
	dav, _ := davServer(t, dir)
	cfg := &Config{Sources: []SourceConfig{
		{Name: "nc", Kind: KindWebDAV, URL: dav.URL + "/", Vendor: "other", Credentials: credentials(t, "u", "p"), Move: true, Description: "A WebDAV"},
		{Name: "loc", Kind: KindLocal, Path: dir},
	}}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	// The address first: the URLs of the files name it.
	ts := httptest.NewUnstartedServer(nil)
	p := NewPlugin(cfg, "http://"+ts.Listener.Addr().String(), "t0k", time.Minute, log)
	ts.Config.Handler = p.Handler()
	ts.Start()
	defer ts.Close()

	// Without the token: refused.
	resp, err := http.Post(ts.URL+"/mcp", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("no token: %d", resp.StatusCode)
	}

	ctx := context.Background()
	c, err := client.NewStreamableHttpClient(ts.URL+"/mcp", transport.WithHTTPHeaders(map[string]string{"Authorization": "Bearer t0k"}))
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
	call := func(tool string, args map[string]any, out any) *mcp.CallToolResult {
		t.Helper()
		var req mcp.CallToolRequest
		req.Params.Name, req.Params.Arguments = tool, args
		res, err := c.CallTool(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		if out != nil && !res.IsError {
			raw, _ := json.Marshal(res.StructuredContent)
			if err := json.Unmarshal(raw, out); err != nil {
				t.Fatalf("%s: %v", tool, err)
			}
		}
		return res
	}
	var m struct {
		Name     string `json:"name"`
		Gosidian int    `json:"gosidian"`
		Sources  []struct {
			Name string `json:"name"`
			Kind string `json:"kind"`
			Move bool   `json:"move"`
		} `json:"sources"`
		Permissions struct {
			Files   bool     `json:"files"`
			Network []string `json:"network"`
		} `json:"permissions"`
	}
	call("gosidian_manifest", nil, &m)
	if m.Name != "storage" || m.Gosidian != 1 || len(m.Sources) != 2 || !m.Sources[0].Move || m.Sources[1].Kind != "local" {
		t.Fatalf("manifest %+v", m)
	}
	if len(m.Permissions.Network) != 1 || !strings.HasPrefix(dav.URL, "http://"+m.Permissions.Network[0]) {
		t.Errorf("network %v", m.Permissions.Network)
	}
	if raw, _ := json.Marshal(p.Manifest()); strings.Contains(string(raw), "cred") {
		t.Errorf("the manifest names a credential: %s", raw)
	}

	var page Page
	call("gosidian_source_list", map[string]any{"source": "nc", "limit": 3}, &page)
	if len(page.Files) != 3 || page.Next == "" {
		t.Fatalf("page %+v", page)
	}
	if res := call("gosidian_source_list", map[string]any{"source": "nope"}, nil); !res.IsError {
		t.Error("a source of nobody")
	}
	var u struct {
		URL  string `json:"url"`
		Size int64  `json:"size"`
		ETag string `json:"etag"`
	}
	call("gosidian_source_open", map[string]any{"source": "nc", "path": "e f.txt"}, &u)
	if !strings.HasPrefix(u.URL, ts.URL+filesPath) || u.Size != 12 || u.ETag == "" {
		t.Fatalf("open %+v", u)
	}
	get := func(rng string) (int, string) {
		req, _ := http.NewRequest(http.MethodGet, u.URL, nil)
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	if code, body := get(""); code != 200 || body != "with a space" {
		t.Errorf("whole: %d %q", code, body)
	}
	if code, body := get("bytes=5-5"); code != 206 || body != "a" {
		t.Errorf("range: %d %q", code, body)
	}
	if code, _ := get("bytes=7-"); code != 206 {
		t.Errorf("open range: %d", code)
	}
	if resp, err := http.Get(ts.URL + filesPath + "nope"); err != nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("no such ticket: %v %v", resp, err)
	}
	var moved File
	call("gosidian_source_move", map[string]any{"source": "nc", "from": "a.txt", "to": "done/a.txt"}, &moved)
	if moved.Path != "done/a.txt" {
		t.Errorf("move %+v", moved)
	}
	if res := call("gosidian_source_move", map[string]any{"source": "loc", "from": "e f.txt", "to": "x.txt"}, nil); !res.IsError {
		t.Error("moved in a source without move")
	}
	// /health answers without the token.
	if resp, err := http.Get(ts.URL + "/health"); err != nil || resp.StatusCode != 200 {
		t.Errorf("health: %v %v", resp, err)
	}
}

// The tickets expire.
func TestTickets(t *testing.T) {
	tk := newTickets(time.Minute)
	now := time.Now()
	tk.now = func() time.Time { return now }
	id := tk.add("nc", "a.txt", "")
	if got, ok := tk.get(id); !ok || got.path != "a.txt" {
		t.Fatalf("get %+v %v", got, ok)
	}
	now = now.Add(2 * time.Minute)
	if _, ok := tk.get(id); ok {
		t.Error("an expired ticket")
	}
}

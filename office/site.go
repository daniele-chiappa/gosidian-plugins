package main

import (
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// Site serves the page's build (web/dist, Vite's): each file in the
// precompressed copy the browser accepts (.br, then .gz), the hashed ones
// of assets/ cached for good and the rest checked again, all with the
// page's CSP.
type Site struct {
	root *os.Root
	csp  string
}

var (
	// Inline code in index.html, which the CSP would refuse: a build that
	// writes some is a mistake to find at start, not in a browser.
	inlineScript = regexp.MustCompile(`(?is)<script\b([^>]*)>(.*?)</script>`)
	inlineStyle  = regexp.MustCompile(`(?is)<style\b|\sstyle\s*=`)
	// A file Vite names with its content's hash.
	hashed = regexp.MustCompile(`^assets/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$`)
)

// PageCSP is the page's policy: its own files only, and gosidian's origins
// as the only frames around it. blob: is for the models' textures: three.js
// cuts each out of its GLB as a blob and reads it back with fetch (so
// connect-src too), and only the page's own script makes a blob: address.
func PageCSP(ancestors []string) string {
	return "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:" +
		"; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors " + strings.Join(ancestors, " ")
}

// OpenSite opens the build at dir for the windows of gosidian at the
// origins ancestors.
func OpenSite(dir string, ancestors []string) (*Site, error) {
	if len(ancestors) == 0 {
		return nil, errors.New("no origin may frame the office: it opens only in gosidian's windows")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("the page's build: %w", err)
	}
	index, err := root.ReadFile("index.html")
	if err != nil {
		root.Close()
		return nil, fmt.Errorf("the page's build has no index.html: %w", err)
	}
	for _, m := range inlineScript.FindAllSubmatch(index, -1) {
		if !strings.Contains(string(m[1]), "src=") || strings.TrimSpace(string(m[2])) != "" {
			root.Close()
			return nil, errors.New("index.html has inline script, which the page's CSP refuses")
		}
	}
	if inlineStyle.Match(index) {
		root.Close()
		return nil, errors.New("index.html has inline style, which the page's CSP refuses")
	}
	return &Site{root: root, csp: PageCSP(ancestors)}, nil
}

// Close lets the build go.
func (s *Site) Close() error { return s.root.Close() }

// ServeHTTP serves a file of the build, its path the request's: / is
// index.html.
func (s *Site) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if !servable(name) {
		http.NotFound(w, r)
		return
	}
	info, err := s.root.Stat(name)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Security-Policy", s.csp)
	h.Set("Content-Type", contentType(name))
	h.Set("Vary", "Accept-Encoding")
	if hashed.MatchString(name) {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	served := name
	for _, enc := range []struct{ name, ext string }{{"br", ".br"}, {"gzip", ".gz"}} {
		if !accepts(r.Header.Get("Accept-Encoding"), enc.name) {
			continue
		}
		if i, err := s.root.Stat(name + enc.ext); err == nil && i.Mode().IsRegular() {
			served, info = name+enc.ext, i
			h.Set("Content-Encoding", enc.name)
			break
		}
	}
	f, err := s.root.Open(served)
	if err != nil {
		http.Error(w, "the file does not open", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// servable says whether a path of the build may be asked for: no dotfile,
// and no precompressed copy, which goes by Accept-Encoding only.
func servable(name string) bool {
	if !fs.ValidPath(name) || strings.HasSuffix(name, ".br") || strings.HasSuffix(name, ".gz") {
		return false
	}
	for _, seg := range strings.Split(name, "/") {
		if strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return true
}

func contentType(name string) string {
	switch path.Ext(name) {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".html":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".glb":
		return "model/gltf-binary"
	case ".json":
		return "application/json"
	case ".svg":
		return "image/svg+xml"
	case "":
		return "text/plain; charset=utf-8"
	}
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}

// accepts says whether an Accept-Encoding takes enc: named, or by *,
// with a q above 0.
func accepts(header, enc string) bool {
	star := false
	for _, part := range strings.Split(header, ",") {
		token, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		token = strings.ToLower(strings.TrimSpace(token))
		ok := !zeroQ(params)
		switch token {
		case enc:
			return ok
		case "*":
			star = ok
		}
	}
	return star
}

func zeroQ(params string) bool {
	for _, p := range strings.Split(params, ";") {
		k, v, _ := strings.Cut(strings.TrimSpace(p), "=")
		if strings.EqualFold(strings.TrimSpace(k), "q") {
			q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
			return err == nil && q == 0
		}
	}
	return false
}

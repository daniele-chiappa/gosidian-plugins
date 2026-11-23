package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// aboutStyle is the page's only style: the CSP admits it by its hash.
const aboutStyle = `body{font:14px/1.5 system-ui,sans-serif;margin:1rem;max-width:60rem}` +
	`table{border-collapse:collapse;margin:.25rem 0 1rem}td,th{padding:.1rem 1rem .1rem 0;text-align:left;vertical-align:top}` +
	`pre{white-space:pre-wrap;font-size:12px}summary{cursor:pointer;margin:.5rem 0}h2{font-size:1.1rem;margin-top:1.5rem}`

var aboutPage = template.Must(template.New("about").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>References</title>
<style>{{.Style}}</style>
</head>
<body>
<h1>References</h1>
<p>The office of gosidian's teams of agents, a plugin of
<a href="https://github.com/daniele-chiappa/gosidian-plugins" target="_blank" rel="noopener">gosidian-plugins</a>,
under the MIT License. It draws with <a href="https://threejs.org" target="_blank" rel="noopener">three.js</a>,
and its characters and furniture are 3D models others released in the public domain (CC0).</p>

<h2>3D models</h2>
<table><tr><th>Model</th><th>Author</th><th>Pack</th><th>Downloaded from</th><th>License</th></tr>
{{range .Assets}}<tr><td>{{.Title}}</td><td>{{.Author}}</td><td><a href="{{.PackURL}}" target="_blank" rel="noopener">{{.Pack}}</a></td><td><a href="{{.Source}}" target="_blank" rel="noopener">{{.Host}}</a></td><td>{{if eq .License "CC0-1.0"}}<a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener">CC0 1.0</a>{{else}}{{.License}}{{end}}</td></tr>
{{end}}</table>
<p>The models are adapted for the office: the furniture packed as GLB with its texture, the characters
with three of their animations only and their shirts drawn in the color of each role.</p>
{{range .AssetLicenses}}<details><summary>{{.Name}}</summary><pre>{{.Text}}</pre></details>
{{end}}
<h2>Libraries in the page ({{len .Web}})</h2>
<table><tr><th>Library</th><th>Version</th><th>License</th></tr>
{{range .Web}}<tr><td>{{.Name}}</td><td>{{.Version}}</td><td>{{.License}}</td></tr>
{{end}}</table>
{{range .Web}}{{range .Texts}}<details><summary>{{.Name}}</summary><pre>{{.Text}}</pre></details>
{{end}}{{end}}
<h2>Go modules in the server ({{len .Modules}})</h2>
<table><tr><th>Module</th><th>Version</th></tr>
{{range .Modules}}<tr><td>{{.Name}}</td><td>{{.Version}}</td></tr>
{{end}}</table>
<p>The image holds every license text under /licenses, and the Alpine packages of its base in
/licenses/PROGRAMS.</p>
</body>
</html>
`))

type aboutText struct{ Name, Text string }

type aboutAsset struct {
	File, Title, Author, Pack, PackURL, Source, Host, License string
}

type aboutPackage struct {
	Name, Version, License string
	Texts                  []aboutText
}

// About serves the references of the plugin: what the page is built with
// and the licenses of what it holds, from the files the image keeps under
// the licenses' folder. The window shows it in a frame that runs no script.
type About struct {
	page []byte
	csp  string
}

func readLines(name string) ([]string, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if line := strings.TrimRight(sc.Text(), "\r"); strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out, sc.Err()
}

// safeURL keeps an https address of the references and nothing else.
func safeURL(u string) string {
	if strings.HasPrefix(u, "https://") {
		return u
	}
	return ""
}

func host(u string) string {
	h := strings.TrimPrefix(u, "https://")
	if i := strings.Index(h, "/"); i >= 0 {
		h = h[:i]
	}
	return h
}

// OpenAbout reads those files once: a build without them is a mistake of
// the build, not something to find out from a reader.
//
//   - assets/ASSETS.tsv: the 3D models, and assets/*.txt the license files
//     of their packs;
//   - web/INDEX: the packages the page bundles (scripts: licenses.mjs), and
//     web/<package>/ their license files;
//   - go-modules/INDEX: Go and the modules in the binary (licenses.sh).
func OpenAbout(dir string, ancestors []string) (*About, error) {
	data := struct {
		Style         template.CSS
		Assets        []aboutAsset
		AssetLicenses []aboutText
		Web           []aboutPackage
		Modules       []aboutPackage
	}{Style: aboutStyle}

	rows, err := readLines(filepath.Join(dir, "assets", "ASSETS.tsv"))
	if err != nil {
		return nil, fmt.Errorf("the licenses of the models: %w", err)
	}
	for i, line := range rows {
		f := strings.Split(line, "\t")
		if i == 0 {
			continue
		}
		if len(f) < 7 {
			return nil, fmt.Errorf("ASSETS.tsv line %d: %d fields, not 7", i+1, len(f))
		}
		data.Assets = append(data.Assets, aboutAsset{File: f[0], Title: f[1], Author: f[2], Pack: f[3],
			PackURL: safeURL(f[4]), Source: safeURL(f[5]), Host: host(f[5]), License: f[6]})
	}
	if len(data.Assets) == 0 {
		return nil, fmt.Errorf("ASSETS.tsv lists no model")
	}
	texts, _ := filepath.Glob(filepath.Join(dir, "assets", "*.txt"))
	sort.Strings(texts)
	for _, name := range texts {
		b, err := os.ReadFile(name)
		if err != nil {
			return nil, err
		}
		data.AssetLicenses = append(data.AssetLicenses, aboutText{Name: filepath.Base(name), Text: string(b)})
	}

	web, err := readLines(filepath.Join(dir, "web", "INDEX"))
	if err != nil {
		return nil, fmt.Errorf("the licenses of the page's libraries: %w", err)
	}
	for _, line := range web {
		f := strings.Split(line, "\t")
		if len(f) < 4 || strings.Contains(f[0], "..") {
			return nil, fmt.Errorf("web/INDEX: %q is not «name version license files»", line)
		}
		pkg := aboutPackage{Name: f[0], Version: f[1], License: f[2]}
		for _, file := range strings.Split(f[3], ",") {
			if file == "" || strings.ContainsAny(file, `/\`) {
				continue
			}
			b, err := os.ReadFile(filepath.Join(dir, "web", f[0], file))
			if err != nil {
				return nil, fmt.Errorf("the license of %s: %w", f[0], err)
			}
			pkg.Texts = append(pkg.Texts, aboutText{Name: f[0] + " " + file, Text: string(b)})
		}
		data.Web = append(data.Web, pkg)
	}

	mods, err := readLines(filepath.Join(dir, "go-modules", "INDEX"))
	if err != nil {
		return nil, fmt.Errorf("the licenses of the Go modules: %w", err)
	}
	for _, line := range mods {
		f := strings.Fields(line)
		if len(f) >= 2 {
			data.Modules = append(data.Modules, aboutPackage{Name: f[0], Version: f[1]})
		}
	}

	var page bytes.Buffer
	if err := aboutPage.Execute(&page, data); err != nil {
		return nil, err
	}
	h := sha256.Sum256([]byte(aboutStyle))
	return &About{page: page.Bytes(), csp: "default-src 'none'; style-src 'sha256-" + base64.StdEncoding.EncodeToString(h[:]) +
		"'; base-uri 'none'; form-action 'none'; frame-ancestors " + strings.Join(ancestors, " ")}, nil
}

func (a *About) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", a.csp)
	w.Header().Set("Cache-Control", "no-cache")
	if r.Method == http.MethodGet {
		_, _ = w.Write(a.page)
	}
}

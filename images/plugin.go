package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Plugin is gosidian-images: the node images.convert for the pipelines,
// and the same conversion as the tool images_convert for the agents. Both
// get their files by reference (gosidian docs/plugins.md, «Files by
// reference») and give back the converted ones, which gosidian stores as
// attachments.
type Plugin struct {
	conv         *Converter
	token        string
	workers      int
	maxBytes     int64 // of one image read
	maxCallBytes int64 // of the files one call gives back
	client       *http.Client
	log          *slog.Logger
}

// maxCallFiles caps the files of one call, as gosidian does.
const maxCallFiles = 100

const convertSchema = `{"type": "object", "required": ["files"], "properties": {
  "files": {"description": "The images: one file, or a list of up to 100 (vault paths, or entries with a path, as in.list gives them)",
    "oneOf": [{"type": "string"}, {"type": "array", "items": {}}]},
  "format": {"type": "string", "enum": ["png", "webp", "keep"], "default": "png",
    "description": "png: PNG optimized without loss; webp: WebP without loss (an image of 16 bits a sample comes back a PNG, which keeps them); keep: the same format, optimized when it can be (TIFF becomes PNG)"},
  "max_side": {"type": "integer", "default": 0, "description": "Scale the longer side down to this many pixels (this loses detail); 0 keeps the size"},
  "strip_metadata": {"type": "boolean", "default": true, "description": "Leave EXIF and other metadata out"},
  "only_if_smaller": {"type": "boolean", "default": true, "description": "Keep the original when the result weighs as much or more (a JPEG stays a JPEG)"}}}`

const convertOutput = `{"type": "object", "properties": {
  "results": {"type": "array", "items": {"type": "object", "properties": {
    "name": {"type": "string"}, "output": {"type": "string", "description": "The file given back, empty when the original is kept"},
    "format": {"type": "string"}, "from_bytes": {"type": "integer"}, "to_bytes": {"type": "integer"},
    "width": {"type": "integer"}, "height": {"type": "integer"}, "kept": {"type": "boolean"},
    "reason": {"type": "string", "description": "Why the original is kept, or why the format is not the one asked"},
    "scaled": {"type": "boolean"}, "error": {"type": "string"}}}},
  "converted": {"type": "integer"}, "kept": {"type": "integer"}, "failed": {"type": "integer"},
  "bytes_before": {"type": "integer"}, "bytes_after": {"type": "integer"}}}`

// Manifest is what the plugin says of itself.
func (p *Plugin) Manifest() map[string]any {
	desc := "Images converted without loss: PNG optimized, or WebP; TIFF to PNG, which the vault takes; scaled down on request"
	return map[string]any{
		"name": "images", "version": version, "gosidian": 1, "description": desc,
		"nodes": []any{map[string]any{
			"name": "convert", "tool": "convert", "files": []string{"files"}, "file_refs": true,
			"description":   "Converts images without loss (PNG optimized, or WebP): they come back as files, the originals that would not get lighter are kept",
			"input_schema":  json.RawMessage(convertSchema),
			"output_schema": json.RawMessage(convertOutput),
		}},
		"tools": []any{map[string]any{
			"name": "convert", "access": "write", "files": []string{"files"}, "file_refs": true,
			"description":   "Converts images of the project without loss (PNG optimized, or WebP), or scales them down: the converted ones become attachments of the project, and the result names them",
			"input_schema":  json.RawMessage(convertSchema),
			"output_schema": json.RawMessage(convertOutput),
		}},
		"permissions": map[string]any{"files": true, "network": []string{}},
	}
}

// fileRef is a file gosidian hands by reference.
type fileRef struct {
	Name   string `json:"name"`
	Mime   string `json:"mime"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	URL    string `json:"url"`
}

// refs reads the files argument: one reference or a list.
func refs(v any) ([]fileRef, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var list []fileRef
	if err := json.Unmarshal(raw, &list); err != nil {
		var one fileRef
		if err := json.Unmarshal(raw, &one); err != nil || one.URL == "" {
			return nil, errors.New("files: one file or a list of files, by reference (gosidian hands them)")
		}
		list = []fileRef{one}
	}
	if len(list) == 0 || len(list) > maxCallFiles {
		return nil, fmt.Errorf("files: from 1 to %d, not %d", maxCallFiles, len(list))
	}
	for i, r := range list {
		if r.URL == "" || r.Name == "" {
			return nil, fmt.Errorf("files[%d] has no url or name: a plugin of gosidian gets its files by reference", i)
		}
	}
	return list, nil
}

// fetch reads a file by reference, checking its size and its SHA-256.
func (p *Plugin) fetch(ctx context.Context, r fileRef) ([]byte, error) {
	if r.Size > p.maxBytes {
		return nil, fmt.Errorf("%s is %d bytes, at most %d MiB (IMAGES_MAX_MIB)", r.Name, r.Size, p.maxBytes>>20)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.URL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetching %s: %s", r.Name, resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, p.maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > p.maxBytes {
		return nil, fmt.Errorf("%s is over %d MiB (IMAGES_MAX_MIB)", r.Name, p.maxBytes>>20)
	}
	if r.Size > 0 && int64(len(data)) != r.Size {
		return nil, fmt.Errorf("%s: %d bytes, %d announced", r.Name, len(data), r.Size)
	}
	if r.SHA256 != "" {
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != strings.ToLower(r.SHA256) {
			return nil, fmt.Errorf("%s: its SHA-256 is not the one announced", r.Name)
		}
	}
	return data, nil
}

// item is one file of a call, converted.
type item struct {
	res  Result
	data []byte
	err  error
}

func (p *Plugin) handleConvert(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	list, err := refs(args["files"])
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	o := Options{
		Format:        req.GetString("format", FormatPNG),
		MaxSide:       req.GetInt("max_side", 0),
		Strip:         req.GetBool("strip_metadata", true),
		OnlyIfSmaller: req.GetBool("only_if_smaller", true),
	}
	if o.Format != FormatPNG && o.Format != FormatWebP && o.Format != FormatKeep {
		return mcp.NewToolResultError(fmt.Sprintf("format %q: png, webp or keep", o.Format)), nil
	}
	items := make([]item, len(list))
	// The files given back stay in memory until the answer is written, and
	// are copied twice more into it (base64, then JSON): IMAGES_MAX_CALL_MIB
	// caps them. One past the cap fails, to be converted in another call.
	var mu sync.Mutex
	left := p.maxCallBytes
	errFull := fmt.Errorf("the files this call gives back would pass %d MiB (IMAGES_MAX_CALL_MIB): convert it in another call", p.maxCallBytes>>20)
	var wg sync.WaitGroup
	sem := make(chan struct{}, p.workers)
	for i, r := range list {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			mu.Lock()
			full := left <= 0
			mu.Unlock()
			if full {
				items[i] = item{res: Result{Name: r.Name, FromBytes: r.Size}, err: errFull}
				return
			}
			data, err := p.fetch(ctx, r)
			if err != nil {
				items[i] = item{res: Result{Name: r.Name}, err: err}
				return
			}
			out, res, err := p.conv.Convert(ctx, r.Name, data, o)
			if out != nil {
				mu.Lock()
				fits := int64(len(out)) <= left
				if fits {
					left -= int64(len(out))
				}
				mu.Unlock()
				if !fits {
					err = errFull
					if int64(len(out)) > p.maxCallBytes { // another call would not take it either
						err = fmt.Errorf("it gives back %d bytes, more than IMAGES_MAX_CALL_MIB (%d MiB) alone", len(out), p.maxCallBytes>>20)
					}
					out = nil
					res = Result{Name: res.Name, FromBytes: res.FromBytes, Width: res.Width, Height: res.Height}
				}
			}
			items[i] = item{res: res, data: out, err: err}
		}()
	}
	wg.Wait()

	results := make([]any, len(items))
	content := []mcp.Content{}
	used := map[string]bool{}
	var converted, kept, failed int
	var before, after int64
	for i := range items {
		it := &items[i]
		m := map[string]any{}
		raw, _ := json.Marshal(it.res)
		_ = json.Unmarshal(raw, &m)
		switch {
		case it.err != nil:
			failed++
			m["error"] = it.err.Error()
			p.log.Warn("convert", "file", it.res.Name, "err", it.err)
		case it.res.Kept:
			kept++
			before += it.res.FromBytes
			after += it.res.FromBytes
		default:
			converted++
			before += it.res.FromBytes
			after += it.res.ToBytes
			// Two inputs of one name would give back two files of one name.
			name := it.res.Output
			for n := 2; used[name]; n++ {
				name = fmt.Sprintf("%s-%d%s", strings.TrimSuffix(it.res.Output, path.Ext(it.res.Output)), n, path.Ext(it.res.Output))
			}
			used[name] = true
			m["output"] = name
			content = append(content, mcp.NewEmbeddedResource(mcp.BlobResourceContents{
				URI: "file:///" + name, MIMEType: mime.TypeByExtension(path.Ext(name)),
				Blob: base64.StdEncoding.EncodeToString(it.data),
			}))
			it.data = nil // its base64 is what goes on
		}
		results[i] = m
	}
	out := map[string]any{"results": results, "converted": converted, "kept": kept, "failed": failed,
		"bytes_before": before, "bytes_after": after}
	if failed == len(items) {
		return mcp.NewToolResultError(fmt.Sprintf("no image converted: %v", items[0].err)), nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	res := mcp.NewToolResultStructured(json.RawMessage(b), string(b))
	res.Content = append(res.Content, content...)
	return res, nil
}

func (p *Plugin) handleManifest(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	b, err := json.Marshal(p.Manifest())
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultStructured(json.RawMessage(b), string(b)), nil
}

// Handler serves the plugin: MCP at /mcp (with the token when set), and
// /health.
func (p *Plugin) Handler() http.Handler {
	ms := server.NewMCPServer("gosidian-images", version, server.WithToolCapabilities(false))
	ms.AddTool(mcp.NewTool("gosidian_manifest", mcp.WithDescription("The plugin's manifest, for gosidian")), p.handleManifest)
	ms.AddTool(mcp.NewToolWithRawSchema("convert", "Converts images without loss, or scales them down", json.RawMessage(convertSchema)), p.handleConvert)
	mcpH := server.NewStreamableHTTPServer(ms)
	mux := http.NewServeMux()
	mux.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p.token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+p.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mcpH.ServeHTTP(w, r)
	}))
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"status":"ok","version":%q,"workers":%d}`+"\n", version, p.workers)
	})
	return mux
}

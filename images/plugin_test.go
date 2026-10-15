package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
)

func testPlugin() *Plugin {
	return &Plugin{conv: testConverter(), workers: 2, maxBytes: 8 << 20, maxCallBytes: 64 << 20, maxFiles: 100, client: http.DefaultClient,
		log: slog.New(slog.NewTextHandler(io.Discard, nil)), token: "secret"}
}

// files serves byte slices as gosidian serves files by reference, and
// gives the references.
func files(t *testing.T, named map[string][]byte) []any {
	t.Helper()
	mux := http.NewServeMux()
	var refs []any
	for name, data := range named {
		mux.HandleFunc("/f/"+name, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(data) })
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	for name, data := range named {
		sum := sha256.Sum256(data)
		refs = append(refs, map[string]any{"name": name, "mime": "image/png", "size": len(data),
			"sha256": hex.EncodeToString(sum[:]), "url": srv.URL + "/f/" + name})
	}
	return refs
}

func convertReq(args map[string]any) mcp.CallToolRequest {
	var req mcp.CallToolRequest
	req.Params.Name = "convert"
	req.Params.Arguments = args
	return req
}

// The tool converts each file of a list, gives the converted ones back as
// embedded resources named in its results, and says which it kept and why.
func TestHandleConvert(t *testing.T) {
	needTools(t)
	p := testPlugin()
	src := encodePNG(t, screenshot(200, 120, false))
	refs := files(t, map[string][]byte{"001.png": src, "notes.txt": []byte("hello"), "logo.svg": []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)})
	res, err := p.handleConvert(context.Background(), convertReq(map[string]any{"files": refs, "format": "webp"}))
	if err != nil || res.IsError {
		t.Fatalf("%v %+v", err, res)
	}
	var out struct {
		Results                 []map[string]any `json:"results"`
		Converted, Kept, Failed int
		BytesBefore             int64 `json:"bytes_before"`
		BytesAfter              int64 `json:"bytes_after"`
	}
	raw, _ := json.Marshal(res.StructuredContent)
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.Converted != 1 || out.Kept != 1 || out.Failed != 1 || out.BytesAfter >= out.BytesBefore {
		t.Fatalf("output %s", raw)
	}
	var blobs []mcp.BlobResourceContents
	for _, c := range res.Content {
		if r, ok := mcp.AsEmbeddedResource(c); ok {
			if b, ok := mcp.AsBlobResourceContents(r.Resource); ok {
				blobs = append(blobs, *b)
			}
		}
	}
	if len(blobs) != 1 || blobs[0].URI != "file:///001.webp" || blobs[0].MIMEType != "image/webp" {
		t.Fatalf("resources %+v", blobs)
	}
	data, _ := base64.StdEncoding.DecodeString(blobs[0].Blob)
	samePixels(t, src, data)
	for _, r := range out.Results {
		switch r["name"] {
		case "001.png":
			if r["output"] != "001.webp" {
				t.Errorf("001: %v", r)
			}
		case "logo.svg":
			if r["kept"] != true {
				t.Errorf("svg: %v", r)
			}
		case "notes.txt":
			if !strings.Contains(r["error"].(string), "not an image") {
				t.Errorf("txt: %v", r)
			}
		}
	}
}

// A file whose bytes are not the ones announced is refused; a call whose
// files all fail is an error; two inputs of one name give back two names.
func TestHandleConvert_Refusals(t *testing.T) {
	needTools(t)
	p := testPlugin()
	src := encodePNG(t, screenshot(60, 40, false))
	refs := files(t, map[string][]byte{"a.png": src})
	bad := refs[0].(map[string]any)
	bad["sha256"] = strings.Repeat("0", 64)
	res, _ := p.handleConvert(context.Background(), convertReq(map[string]any{"files": bad}))
	if !res.IsError || !strings.Contains(textOf(res), "SHA-256") {
		t.Errorf("a wrong SHA-256: %s", textOf(res))
	}
	for _, args := range []map[string]any{{}, {"files": "rag/attachments/x.png"}, {"files": []any{}}, {"files": refs, "format": "avif"}} {
		if res, _ := p.handleConvert(context.Background(), convertReq(args)); !res.IsError {
			t.Errorf("%v: no error", args)
		}
	}

	twice := files(t, map[string][]byte{"a.png": src})
	other := files(t, map[string][]byte{"a.png": encodePNG(t, screenshot(60, 41, false))})
	res, _ = p.handleConvert(context.Background(), convertReq(map[string]any{"files": []any{twice[0], other[0]}}))
	var names []string
	for _, c := range res.Content {
		if r, ok := mcp.AsEmbeddedResource(c); ok {
			b, _ := mcp.AsBlobResourceContents(r.Resource)
			names = append(names, b.URI)
		}
	}
	if len(names) != 2 || names[0] == names[1] {
		t.Errorf("names %v", names)
	}
}

// The files a call gives back stay within IMAGES_MAX_CALL_MIB: of three
// images, two fit, the third fails with the reason and the two come back.
func TestHandleConvert_CallCap(t *testing.T) {
	needTools(t)
	p := testPlugin()
	src := encodePNG(t, screenshot(200, 120, false))
	one, _, err := p.conv.Convert(context.Background(), "a.png", src, Options{Format: FormatWebP, Strip: true})
	if err != nil {
		t.Fatal(err)
	}
	p.maxCallBytes = int64(len(one))*2 + int64(len(one))/2
	refs := files(t, map[string][]byte{"a.png": src, "b.png": src, "c.png": src})
	res, err := p.handleConvert(context.Background(), convertReq(map[string]any{"files": refs, "format": "webp"}))
	if err != nil || res.IsError {
		t.Fatalf("%v %s", err, textOf(res))
	}
	var out struct {
		Results           []map[string]any `json:"results"`
		Converted, Failed int
	}
	raw, _ := json.Marshal(res.StructuredContent)
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.Converted != 2 || out.Failed != 1 {
		t.Fatalf("output %s", raw)
	}
	for _, r := range out.Results {
		if e, ok := r["error"].(string); ok && (!strings.Contains(e, "IMAGES_MAX_CALL_MIB") || r["output"] != nil) {
			t.Errorf("the one past the cap: %v", r)
		}
	}
	blobs := 0
	for _, c := range res.Content {
		if _, ok := mcp.AsEmbeddedResource(c); ok {
			blobs++
		}
	}
	if blobs != 2 {
		t.Errorf("%d files given back, want 2", blobs)
	}

	// One file larger than the cap alone fails, and says another call would
	// not take it either.
	p.maxCallBytes = int64(len(one)) - 1
	res, _ = p.handleConvert(context.Background(), convertReq(map[string]any{"files": refs[0], "format": "webp"}))
	if !res.IsError || !strings.Contains(textOf(res), "IMAGES_MAX_CALL_MIB") || !strings.Contains(textOf(res), "alone") {
		t.Errorf("one file over the cap: %s", textOf(res))
	}
}

func textOf(res *mcp.CallToolResult) string {
	for _, c := range res.Content {
		if t, ok := mcp.AsTextContent(c); ok {
			return t.Text
		}
	}
	return ""
}

// The manifest has the node and the tool, both with files by reference;
// /mcp wants the token, /health answers without it.
func TestManifestAndHandler(t *testing.T) {
	p := testPlugin()
	m := p.Manifest()
	raw, _ := json.Marshal(m)
	for _, want := range []string{`"name":"images"`, `"file_refs":true`, `"access":"write"`, `"files":["files"]`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("manifest lacks %s: %s", want, raw)
		}
	}
	srv := httptest.NewServer(p.Handler())
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/mcp", "application/json", strings.NewReader(`{}`))
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("/mcp without the token: %v %v", resp.StatusCode, err)
	}
	resp, err = http.Get(srv.URL + "/health")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Errorf("/health: %v", err)
	}
}

// IMAGES_MAX_FILES caps the files one call names.
func TestHandleConvert_MaxFiles(t *testing.T) {
	p := testPlugin()
	p.maxFiles = 1
	refs := files(t, map[string][]byte{"a.png": {1}, "b.png": {2}})
	res, err := p.handleConvert(context.Background(), convertReq(map[string]any{"files": refs}))
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsError || !strings.Contains(textOf(res), "IMAGES_MAX_FILES") {
		t.Errorf("two files under a cap of one: %s", textOf(res))
	}
}

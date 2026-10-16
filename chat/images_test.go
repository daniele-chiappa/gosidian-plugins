package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// pngBytes is a small file that reads as a PNG.
var pngBytes = append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), bytes.Repeat([]byte{7}, 200)...)

func TestImages(t *testing.T) {
	p, _, h := newTestPlugin(t, nil)
	files := map[string][]byte{"/f/a.png": pngBytes, "/f/script.svg": []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/f/moved.png" {
			http.Redirect(w, r, "/f/a.png", http.StatusFound)
			return
		}
		_, _ = w.Write(files[r.URL.Path])
	}))
	defer srv.Close()
	ref := func(path string, data []byte) map[string]any {
		sum := sha256.Sum256(data)
		return map[string]any{"name": path[3:], "mime": "image/png", "size": len(data), "sha256": hex.EncodeToString(sum[:]), "url": srv.URL + path}
	}
	bad := ref("/f/a.png", pngBytes)
	bad["sha256"] = strings.Repeat("0", 64)
	_, text := callTool(t, p.publishImages, map[string]any{"bot": "docs", "images": []any{
		ref("/f/a.png", pngBytes), bad, ref("/f/script.svg", files["/f/script.svg"]), ref("/f/moved.png", pngBytes)}})
	var out struct {
		Images  []struct{ URL, Mime string }   `json:"images"`
		Skipped []struct{ Name, Error string } `json:"skipped"`
	}
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatal(text)
	}
	if len(out.Images) != 1 || !strings.HasPrefix(out.Images[0].URL, "https://chat.example.com/api/bots/docs/images/") || out.Images[0].Mime != "image/png" {
		t.Fatalf("images: %s", text)
	}
	if len(out.Skipped) != 3 || !strings.Contains(out.Skipped[0].Error, "SHA-256") || !strings.Contains(out.Skipped[1].Error, "png, jpeg, gif or webp") ||
		!strings.Contains(out.Skipped[2].Error, "redirect") {
		t.Errorf("skipped: %s", text)
	}
	// Served without a key or a token: the address is the key.
	path := strings.TrimPrefix(out.Images[0].URL, "https://chat.example.com")
	req := httptest.NewRequest(http.MethodGet, path, nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || !bytes.Equal(w.Body.Bytes(), pngBytes) ||
		!strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("serve: %d %v", w.Code, w.Header())
	}
	for _, other := range []string{"/api/bots/docs/images/nope", strings.Replace(path, "/docs/", "/other/", 1)} {
		if r := do(h, http.MethodGet, other, "", nil); r.code != 404 {
			t.Errorf("%s: %d", other, r.code)
		}
	}
	// Expired, and the bot gone.
	p.now = func() time.Time { return time.Now().UTC().Add(2 * time.Hour) }
	if r := do(h, http.MethodGet, path, "", nil); r.code != 404 {
		t.Errorf("expired: %d", r.code)
	}
	if _, text := callTool(t, p.publishImages, map[string]any{"bot": "nobot", "images": []any{}}); !strings.Contains(text, "no bot") {
		t.Errorf("a bot unknown: %s", text)
	}
}

func TestImages_Room(t *testing.T) {
	s := NewImages(1000, time.Hour)
	now := time.Now()
	a := s.Put("b", "image/png", make([]byte, 600), now)
	b := s.Put("b", "image/png", make([]byte, 600), now)
	if _, ok := s.Get("b", a, now); ok {
		t.Error("the oldest stays past the room")
	}
	if _, ok := s.Get("b", b, now); !ok {
		t.Error("the newest went")
	}
	s.Bot("b")
	if _, ok := s.Get("b", b, now); ok || s.bytes != 0 {
		t.Errorf("a bot gone keeps its images: %d", s.bytes)
	}
}

func TestHandoffAndDates(t *testing.T) {
	auth := map[string]string{"Authorization": "Bearer " + userToken("mario", "docs", time.Now().Add(time.Hour))}
	_, g, h := newTestPlugin(t, map[string]any{"handoff": map[string]any{"label": "", "contact": true}, "dates": true})
	r := do(h, http.MethodGet, "/api/bots/docs", "", auth)
	if hd, _ := r.body["handoff"].(map[string]any); hd == nil || hd["contact"] != true || r.body["dates"] != true {
		t.Fatalf("info: %v", r.body)
	}
	r = do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"com'era?","as_of":"2026-03-31"}`, auth)
	if r.code != 200 || g.last()["as_of"] != "2026-03-31" {
		t.Errorf("as_of: %d %v", r.code, g.last())
	}
	session := r.body["session"].(string)
	if r := do(h, http.MethodPost, "/api/bots/docs/messages", `{"message":"x","as_of":"31/03/2026"}`, auth); r.code != 400 {
		t.Errorf("a day that is not one: %d", r.code)
	}
	r = do(h, http.MethodPost, "/api/bots/docs/handoff", `{"session":"`+session+`","message":"mi serve aiuto","contact":"mario@example.com"}`, auth)
	in := g.last()
	if r.code != 200 || in["kind"] != "handoff" || in["contact"] != "mario@example.com" || in["message"] != "mi serve aiuto" ||
		len(in["history"].([]any)) != 2 || r.body["answer"].(map[string]any)["text"] == "" {
		t.Errorf("handoff: %d %v %v", r.code, r.body, in)
	}
	if r := do(h, http.MethodPost, "/api/bots/docs/handoff", `{"session":"`+session+`"}`, auth); r.code != 429 {
		t.Errorf("a second request within the minute: %d", r.code)
	}
	// A bot without them.
	_, _, h2 := newTestPlugin(t, nil)
	if r := do(h2, http.MethodPost, "/api/bots/docs/handoff", `{}`, auth); r.code != 404 {
		t.Errorf("no handoff: %d", r.code)
	}
	if r := do(h2, http.MethodPost, "/api/bots/docs/messages", `{"message":"x","as_of":"2026-03-31"}`, auth); r.code != 400 {
		t.Errorf("no dates: %d", r.code)
	}
}

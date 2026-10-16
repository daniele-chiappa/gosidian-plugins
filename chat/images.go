package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// The images of an answer: the bot's pipeline hands the screenshots of the
// sections it cites to the node images, by reference (gosidian's
// file_refs). The plugin fetches them, keeps them in memory for a while
// and serves them at an address of its own, which the widget shows: the
// widget's page cannot read gosidian's files. The address is the key, a
// random id; it serves only the images types, never one that runs.

// imageTypes are the types the plugin serves: no SVG, which may hold a
// script.
var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

type image struct {
	bot     string
	mime    string
	data    []byte
	sum     string
	expires time.Time
}

// Images keeps the images in memory, at most max bytes together, each
// for ttl; the oldest go first. An image a bot hands again is kept once:
// the screenshots of a section come back with each answer that cites it.
type Images struct {
	mu    sync.Mutex
	byID  map[string]*image
	bySum map[string]string
	order []string
	bytes int64
	max   int64
	ttl   time.Duration
}

// NewImages is a store of at most max bytes, each image kept for ttl.
func NewImages(max int64, ttl time.Duration) *Images {
	return &Images{byID: map[string]*image{}, bySum: map[string]string{}, max: max, ttl: ttl}
}

// Put keeps an image of a bot and gives its id: the id it has, when the
// bot handed the same bytes before, kept another ttl.
func (s *Images) Put(bot, mime string, data []byte, now time.Time) string {
	h := sha256.Sum256(data)
	key := bot + "\x00" + hex.EncodeToString(h[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.bySum[key]; ok {
		if im := s.byID[id]; im != nil && !now.After(im.expires) {
			im.expires = now.Add(s.ttl)
			// The newest now: the last to go.
			for i, o := range s.order {
				if o == id {
					s.order = append(append(s.order[:i:i], s.order[i+1:]...), id)
					break
				}
			}
			return id
		}
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	s.drop(now, int64(len(data)))
	s.byID[id] = &image{bot: bot, mime: mime, data: data, sum: key, expires: now.Add(s.ttl)}
	s.bySum[key] = id
	s.order = append(s.order, id)
	s.bytes += int64(len(data))
	return id
}

// drop removes the expired images, then the oldest while room is short of
// need bytes.
func (s *Images) drop(now time.Time, need int64) {
	keep := s.order[:0]
	for _, id := range s.order {
		im := s.byID[id]
		if im == nil {
			continue
		}
		if now.After(im.expires) || s.bytes+need > s.max {
			s.bytes -= int64(len(im.data))
			delete(s.byID, id)
			if s.bySum[im.sum] == id {
				delete(s.bySum, im.sum)
			}
			continue
		}
		keep = append(keep, id)
	}
	s.order = keep
}

// Get gives an image of a bot, while it lasts.
func (s *Images) Get(bot, id string, now time.Time) (*image, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	im, ok := s.byID[id]
	if !ok || im.bot != bot || now.After(im.expires) {
		return nil, false
	}
	return im, true
}

// Bot removes the images of a bot that went.
func (s *Images) Bot(bot string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, im := range s.byID {
		if im.bot == bot {
			s.bytes -= int64(len(im.data))
			delete(s.byID, id)
			delete(s.bySum, im.sum)
		}
	}
}

const imagesSchema = `{"type": "object", "required": ["bot", "images"], "properties": {
  "bot": {"type": "string", "description": "the bot whose answer shows them"},
  "images": {"type": "array", "items": {"type": "string"}, "description": "vault paths of images (png, jpeg, gif, webp), at most CHAT_IMAGES_PER_CALL (40 by default)"}}}`

const imagesOutput = `{"type": "object", "properties": {
  "images": {"type": "array", "items": {"type": "object", "properties": {"url": {"type": "string"}, "name": {"type": "string"}, "mime": {"type": "string"}, "size": {"type": "integer"}}}},
  "skipped": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "error": {"type": "string"}}}}}}`

// fileRef is a file gosidian hands by reference.
type fileRef struct {
	Name   string `json:"name"`
	Mime   string `json:"mime"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	URL    string `json:"url"`
}

// publishImages is the node images: it fetches the images it is handed and
// gives the addresses the widget shows them at, in their order. An image
// that does not come, or is not an image, is skipped with why.
func (p *Plugin) publishImages(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var in struct {
		Bot    string    `json:"bot"`
		Images []fileRef `json:"images"`
	}
	raw, _ := json.Marshal(req.GetArguments())
	if err := json.Unmarshal(raw, &in); err != nil {
		return mcp.NewToolResultError("images: a list of the files gosidian hands by reference: " + err.Error()), nil
	}
	if _, ok := p.bot(in.Bot); !ok {
		return mcp.NewToolResultError(fmt.Sprintf("no bot %q (gosidian configures it from its note)", in.Bot)), nil
	}
	if len(in.Images) > p.set.ImagesPerCall {
		return mcp.NewToolResultError(fmt.Sprintf("images: at most %d (CHAT_IMAGES_PER_CALL)", p.set.ImagesPerCall)), nil
	}
	out := []map[string]any{}
	skipped := []map[string]string{}
	for _, f := range in.Images {
		data, mime, err := p.fetchImage(ctx, f)
		if err != nil {
			skipped = append(skipped, map[string]string{"name": f.Name, "error": err.Error()})
			continue
		}
		id := p.images.Put(in.Bot, mime, data, p.now())
		out = append(out, map[string]any{"url": p.set.PublicURL + "/api/bots/" + in.Bot + "/images/" + id,
			"name": f.Name, "mime": mime, "size": len(data)})
	}
	return p.result(map[string]any{"images": out, "skipped": skipped})
}

// fetchImage fetches a file by its reference and checks it is the image
// gosidian named: its size, its SHA-256, an image type by its bytes.
func (p *Plugin) fetchImage(ctx context.Context, f fileRef) ([]byte, string, error) {
	if !strings.HasPrefix(f.URL, "http://") && !strings.HasPrefix(f.URL, "https://") {
		return nil, "", fmt.Errorf("not a file by reference: no http(s) url")
	}
	if f.Size > p.set.ImageMaxBytes {
		return nil, "", fmt.Errorf("%d bytes: more than CHAT_IMAGE_MAX_BYTES (%d)", f.Size, p.set.ImageMaxBytes)
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(cctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := p.files.Do(r)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("fetching it answered %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, p.set.ImageMaxBytes+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > p.set.ImageMaxBytes {
		return nil, "", fmt.Errorf("more than CHAT_IMAGE_MAX_BYTES (%d)", p.set.ImageMaxBytes)
	}
	if f.Size > 0 && int64(len(data)) != f.Size {
		return nil, "", fmt.Errorf("%d bytes came, gosidian said %d", len(data), f.Size)
	}
	if f.SHA256 != "" {
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != strings.ToLower(f.SHA256) {
			return nil, "", fmt.Errorf("what came is not the file gosidian named (its SHA-256 differs)")
		}
	}
	mime := http.DetectContentType(data)
	if !imageTypes[mime] {
		return nil, "", fmt.Errorf("%s: an image is png, jpeg, gif or webp", mime)
	}
	return data, mime, nil
}

// serveImage serves an image of an answer: its address is its key.
func (p *Plugin) serveImage(w http.ResponseWriter, r *http.Request, bot, id string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "GET an image")
		return
	}
	im, ok := p.images.Get(bot, id, p.now())
	if !ok {
		writeError(w, http.StatusNotFound, "no such image (or it expired)")
		return
	}
	w.Header().Set("Content-Type", im.mime)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	_, _ = w.Write(im.data)
}

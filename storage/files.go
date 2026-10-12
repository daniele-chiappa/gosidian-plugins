package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
)

// A file a source opens is served at /files/<ticket>: the ticket names
// the source and the file, for TTL, for as many requests (ranges,
// retries) as gosidian makes. Without a token: the ticket is the key.

// filesPath is where the files are served, before their ticket.
const filesPath = "/files/"

type ticket struct {
	source, path string
	// local is a file of the plugin's disk the ticket serves: a native
	// Google document, exported.
	local   string
	expires time.Time
}

type tickets struct {
	ttl time.Duration
	now func() time.Time

	mu sync.Mutex
	m  map[string]ticket
}

func newTickets(ttl time.Duration) *tickets {
	return &tickets{ttl: ttl, now: time.Now, m: map[string]ticket{}}
}

func (t *tickets) add(source, p, local string) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	id := hex.EncodeToString(b[:])
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	for k, v := range t.m {
		if now.After(v.expires) {
			if v.local != "" {
				_ = os.Remove(v.local)
			}
			delete(t.m, k)
		}
	}
	t.m[id] = ticket{source: source, path: p, local: local, expires: now.Add(t.ttl)}
	return id
}

// maxExport caps a native Google document exported.
const maxExport = 512 << 20

// export writes an object whose size is unknown (a native Google
// document) to a file of the plugin's temporary folder, and gives its
// path and size. The file goes when its ticket expires.
func (t *tickets) export(ctx context.Context, o fs.Object) (string, int64, error) {
	rc, err := o.Open(ctx)
	if err != nil {
		return "", 0, err
	}
	defer rc.Close()
	f, err := os.CreateTemp("", "storage-export-*")
	if err != nil {
		return "", 0, err
	}
	n, err := io.Copy(f, io.LimitReader(rc, maxExport+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > maxExport {
		err = fmt.Errorf("more than %d MiB", maxExport>>20)
	}
	if err != nil {
		_ = os.Remove(f.Name())
		return "", 0, err
	}
	return f.Name(), n, nil
}

func (t *tickets) get(id string) (ticket, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	tk, ok := t.m[id]
	if ok && t.now().After(tk.expires) {
		delete(t.m, id)
		return ticket{}, false
	}
	return tk, ok
}

// serveFile serves the file of a ticket, ranges and conditional requests
// too (http.ServeContent), reading it from its source as it is read.
func (p *Plugin) serveFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, filesPath)
	tk, ok := p.tickets.get(id)
	if !ok || strings.Contains(id, "/") {
		http.Error(w, "no such file, or its link expired", http.StatusForbidden)
		return
	}
	name := path.Base(tk.path)
	if tk.local != "" {
		f, err := os.Open(tk.local)
		if err != nil {
			http.Error(w, "the exported file is gone", http.StatusNotFound)
			return
		}
		defer f.Close()
		info, _ := f.Stat()
		setFileHeaders(w, name)
		http.ServeContent(w, r, name, info.ModTime(), f)
		return
	}
	src := p.sources[tk.source]
	o, err := src.Object(r.Context(), tk.path)
	if err != nil {
		p.log.Warn("a file of a source", "source", tk.source, "err", err)
		http.Error(w, "the file is not in its source", http.StatusNotFound)
		return
	}
	rs := newObjectReader(r.Context(), o)
	defer rs.Close()
	setFileHeaders(w, name)
	http.ServeContent(w, r, name, o.ModTime(r.Context()), rs)
}

// setFileHeaders sets a served file's type, set so ServeContent reads
// nothing to guess it, and keeps it out of caches.
func setFileHeaders(w http.ResponseWriter, name string) {
	ct := mime.TypeByExtension(strings.ToLower(path.Ext(name)))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

// objectReader reads an object of a source as an io.ReadSeeker: opened
// from the offset reached at the first read after a seek.
type objectReader struct {
	ctx  context.Context
	o    fs.Object
	size int64
	off  int64
	rc   io.ReadCloser
}

func newObjectReader(ctx context.Context, o fs.Object) *objectReader {
	return &objectReader{ctx: ctx, o: o, size: o.Size()}
}

func (r *objectReader) Read(b []byte) (int, error) {
	if r.size >= 0 && r.off >= r.size {
		return 0, io.EOF
	}
	if r.rc == nil {
		var opts []fs.OpenOption
		if r.off > 0 {
			opts = append(opts, &fs.SeekOption{Offset: r.off})
		}
		rc, err := r.o.Open(r.ctx, opts...)
		if err != nil {
			return 0, err
		}
		r.rc = rc
	}
	n, err := r.rc.Read(b)
	r.off += int64(n)
	return n, err
}

func (r *objectReader) Seek(offset int64, whence int) (int64, error) {
	var to int64
	switch whence {
	case io.SeekStart:
		to = offset
	case io.SeekCurrent:
		to = r.off + offset
	case io.SeekEnd:
		to = r.size + offset
	default:
		return 0, errors.New("seek: bad whence")
	}
	if to < 0 {
		return 0, errors.New("seek: before the start")
	}
	if to != r.off && r.rc != nil {
		r.rc.Close()
		r.rc = nil
	}
	r.off = to
	return to, nil
}

func (r *objectReader) Close() error {
	if r.rc != nil {
		err := r.rc.Close()
		r.rc = nil
		return err
	}
	return nil
}

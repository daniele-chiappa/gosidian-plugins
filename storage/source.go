package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/backend/webdav/api"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/obscure"
	"github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/fs/operations"
	"github.com/rclone/rclone/fs/walk"
	"google.golang.org/api/googleapi"

	_ "github.com/rclone/rclone/backend/drive"
	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/s3"
	_ "github.com/rclone/rclone/backend/webdav"
)

// File is a file of a source, as gosidian reads it.
type File struct {
	Path string `json:"path"`
	// Size is -1 for a native Google document: its size is known when it
	// is exported, at open.
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	// ETag tells the file's content apart: a hash of it when the store
	// keeps one (S3, Drive), else its size and time. A move keeps it.
	ETag string `json:"etag"`
	// SHA256, when the store keeps it (Drive).
	SHA256 string `json:"sha256,omitempty"`
}

// Page is a page of a source's list.
type Page struct {
	Files []File `json:"files"`
	Next  string `json:"next"`
}

const (
	// authWait is how long a source that refused its credentials is not
	// asked again: its server slows down an address after failed logins.
	authWait = 5 * time.Minute
	// listKeep is how long a list stays for its next pages.
	listKeep = 10 * time.Minute
	// maxListed caps the files of one list.
	maxListed = 200000
)

// Source is a source of the plugin: an rclone Fs, made at its first use.
type Source struct {
	cfg SourceConfig

	mu       sync.Mutex
	f        fs.Fs
	refused  time.Time // when the source last refused its credentials
	listings map[string]*listing
	now      func() time.Time
}

type listing struct {
	files []File
	made  time.Time
}

func newSource(cfg SourceConfig) *Source {
	return &Source{cfg: cfg, listings: map[string]*listing{}, now: time.Now}
}

// fs makes the source's Fs, once: no network at start.
func (s *Source) fs(ctx context.Context) (fs.Fs, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.refused.IsZero() {
		if until := s.refused.Add(authWait); s.now().Before(until) {
			return nil, fmt.Errorf("source %s refused its credentials at %s: it is not asked again before %s", s.cfg.Name,
				s.refused.UTC().Format(time.RFC3339), until.UTC().Format(time.RFC3339))
		}
	}
	if s.f != nil {
		return s.f, nil
	}
	var (
		ri   *fs.RegInfo
		root string
		m    = configmap.Simple{}
		err  error
	)
	switch s.cfg.Kind {
	case KindWebDAV:
		user, pass, cerr := readCredentials(s.cfg.Credentials)
		if cerr != nil {
			return nil, fmt.Errorf("source %s: %w", s.cfg.Name, cerr)
		}
		m["url"], m["vendor"], m["user"], m["pass"] = s.cfg.URL, s.cfg.Vendor, user, obscure.MustObscure(pass)
		ri, err = fs.Find("webdav")
	case KindLocal:
		root = s.cfg.Path
		ri, err = fs.Find("local")
	case KindS3:
		key, secret, cerr := readCredentials(s.cfg.Credentials)
		if cerr != nil {
			return nil, fmt.Errorf("source %s: %w", s.cfg.Name, cerr)
		}
		m["provider"], m["access_key_id"], m["secret_access_key"] = s.cfg.Provider, key, secret
		m["env_auth"], m["no_check_bucket"] = "false", "true"
		m["force_path_style"] = strconv.FormatBool(s.cfg.PathStyle)
		if s.cfg.Endpoint != "" {
			m["endpoint"] = s.cfg.Endpoint
		}
		if s.cfg.Region != "" {
			m["region"] = s.cfg.Region
		}
		root = path.Join(s.cfg.Bucket, s.cfg.Prefix)
		ri, err = fs.Find("s3")
	case KindDrive:
		m["service_account_file"] = s.cfg.Credentials
		m["scope"] = "drive.readonly"
		if s.cfg.Move {
			m["scope"] = "drive"
		}
		if s.cfg.RootFolderID != "" {
			m["root_folder_id"] = s.cfg.RootFolderID
		}
		if s.cfg.TeamDrive != "" {
			m["team_drive"] = s.cfg.TeamDrive
		}
		// Native Google documents have no bytes: Sheets as xlsx (tables),
		// Docs and Slides as pdf, which docling reads best.
		m["export_formats"] = "xlsx,pdf"
		ri, err = fs.Find("drive")
	}
	if err != nil {
		return nil, err
	}
	f, err := ri.NewFs(ctx, s.cfg.Name, root, fs.ConfigMap(ri.Prefix, ri.Options, "", m))
	if err != nil && !errors.Is(err, fs.ErrorIsFile) {
		if status, ok := refusal(err); ok {
			s.refused = s.now()
			return nil, s.refusedErr(status)
		}
		return nil, fmt.Errorf("source %s: %w", s.cfg.Name, err)
	}
	s.f = f
	return f, nil
}

// refusal says whether err is a server's refusal of the credentials: a
// 401 or 403 of WebDAV or S3, a 401 of Google (whose 403 is also a rate
// limit).
func refusal(err error) (string, bool) {
	var ae *api.Error
	if errors.As(err, &ae) && (ae.StatusCode == 401 || ae.StatusCode == 403) {
		return ae.Status, true
	}
	var hs interface{ HTTPStatusCode() int }
	if errors.As(err, &hs) {
		if c := hs.HTTPStatusCode(); c == 401 || c == 403 {
			return strconv.Itoa(c) + " " + http.StatusText(c), true
		}
	}
	var ge *googleapi.Error
	if errors.As(err, &ge) && ge.Code == 401 {
		return "401 " + http.StatusText(401), true
	}
	return "", false
}

func (s *Source) refusedErr(status string) error {
	return fmt.Errorf("source %s refused its credentials (%s): it is not asked again for %s", s.cfg.Name, status, authWait)
}

// failed notes a source's refusal of its credentials, and passes err on.
func (s *Source) failed(err error) error {
	status, ok := refusal(err)
	if !ok {
		return err
	}
	s.mu.Lock()
	s.refused, s.f = s.now(), nil
	s.mu.Unlock()
	return s.refusedErr(status)
}

// checkPath checks a path of a source: relative to its root, plain.
func checkPath(p string) error {
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "\\") || path.Clean(p) != p {
		return fmt.Errorf("path %q: a plain path inside the source", p)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." || seg == "." {
			return fmt.Errorf("path %q: a plain path inside the source", p)
		}
	}
	return nil
}

func etagOf(size int64, mod time.Time) string {
	return strconv.FormatInt(size, 16) + "-" + strconv.FormatInt(mod.Unix(), 16)
}

// fileOf describes an object. On S3 and Drive the etag is a hash the store
// keeps (an S3 copy, a move there, keeps it where the time changes); on
// the others, hashing would read the file, so size and time.
func (s *Source) fileOf(ctx context.Context, o fs.Object) File {
	mod := o.ModTime(ctx).UTC().Truncate(time.Second)
	f := File{Path: o.Remote(), Size: o.Size(), Modified: mod, ETag: etagOf(o.Size(), mod)}
	if s.cfg.Kind != KindS3 && s.cfg.Kind != KindDrive {
		return f
	}
	if sum, err := o.Hash(ctx, hash.MD5); err == nil && sum != "" {
		f.ETag = "md5-" + sum
	}
	if s.cfg.Kind == KindDrive {
		if sum, err := o.Hash(ctx, hash.SHA256); err == nil && sum != "" {
			f.SHA256 = sum
		}
	}
	return f
}

func newListID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// List gives a page of the source's files, by path. The first page (an
// empty cursor) lists the source in full and keeps the list for the
// pages after it, whose cursor names it.
func (s *Source) List(ctx context.Context, cursor string, limit int) (Page, error) {
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	var (
		l   *listing
		id  string
		off int
	)
	if cursor == "" {
		f, err := s.fs(ctx)
		if err != nil {
			return Page{}, err
		}
		var files []File
		err = walk.ListR(ctx, f, "", true, -1, walk.ListObjects, func(entries fs.DirEntries) error {
			for _, e := range entries {
				if o, ok := e.(fs.Object); ok {
					files = append(files, s.fileOf(ctx, o))
				}
			}
			if len(files) > maxListed {
				return fmt.Errorf("more than %d files", maxListed)
			}
			return nil
		})
		if err != nil {
			return Page{}, s.failed(fmt.Errorf("source %s: %w", s.cfg.Name, err))
		}
		sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
		l, id = &listing{files: files, made: s.now()}, newListID()
		s.keep(id, l)
	} else {
		var err error
		id, off, err = parseCursor(cursor)
		if err != nil {
			return Page{}, err
		}
		s.mu.Lock()
		l = s.listings[id]
		s.mu.Unlock()
		if l == nil {
			return Page{}, errors.New("the list of that cursor is gone (it lasts 10 minutes): start again from an empty cursor")
		}
	}
	end := min(off+limit, len(l.files))
	page := Page{Files: append([]File{}, l.files[off:end]...)}
	if end < len(l.files) {
		page.Next = id + ":" + strconv.Itoa(end)
	}
	return page, nil
}

func parseCursor(c string) (string, int, error) {
	id, n, ok := strings.Cut(c, ":")
	off, err := strconv.Atoi(n)
	if !ok || err != nil || off < 0 || id == "" {
		return "", 0, fmt.Errorf("cursor %q is not one this source gave", c)
	}
	return id, off, nil
}

// keep keeps a list for its next pages, and forgets the old ones.
func (s *Source) keep(id string, l *listing) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.listings {
		if s.now().Sub(v.made) > listKeep {
			delete(s.listings, k)
		}
	}
	s.listings[id] = l
}

// Object finds a file of the source.
func (s *Source) Object(ctx context.Context, p string) (fs.Object, error) {
	if err := checkPath(p); err != nil {
		return nil, err
	}
	f, err := s.fs(ctx)
	if err != nil {
		return nil, err
	}
	o, err := f.NewObject(ctx, p)
	if err != nil {
		return nil, s.failed(fmt.Errorf("source %s: %s: %w", s.cfg.Name, p, err))
	}
	return o, nil
}

// Presign gives a presigned URL of S3 for an object of an S3 source, valid
// for ttl: gosidian reads the bytes from S3, not through the plugin.
func (s *Source) Presign(ctx context.Context, p string, ttl time.Duration) (string, error) {
	f, err := s.fs(ctx)
	if err != nil {
		return "", err
	}
	pl, ok := f.(fs.PublicLinker)
	if !ok {
		return "", fmt.Errorf("source %s gives no presigned URLs", s.cfg.Name)
	}
	link, err := pl.PublicLink(ctx, p, fs.Duration(ttl), false)
	if err != nil {
		return "", s.failed(fmt.Errorf("source %s: a presigned URL of %s: %w", s.cfg.Name, p, err))
	}
	return link, nil
}

// Move moves a file, or a folder, inside the source.
func (s *Source) Move(ctx context.Context, from, to string) (File, error) {
	if !s.cfg.Move {
		return File{}, fmt.Errorf("source %s does not move its files (move: false in storage.yaml)", s.cfg.Name)
	}
	for _, p := range []string{from, to} {
		if err := checkPath(p); err != nil {
			return File{}, err
		}
	}
	f, err := s.fs(ctx)
	if err != nil {
		return File{}, err
	}
	if _, err := f.NewObject(ctx, to); err == nil {
		return File{}, fmt.Errorf("%s is there already", to)
	}
	o, err := f.NewObject(ctx, from)
	if err == nil {
		moved, err := operations.Move(ctx, f, nil, to, o)
		if err != nil {
			return File{}, s.failed(fmt.Errorf("source %s: moving %s: %w", s.cfg.Name, from, err))
		}
		if moved == nil {
			if moved, err = f.NewObject(ctx, to); err != nil {
				return File{}, s.failed(err)
			}
		}
		return s.fileOf(ctx, moved), nil
	}
	if !errors.Is(err, fs.ErrorObjectNotFound) && !errors.Is(err, fs.ErrorIsDir) {
		return File{}, s.failed(fmt.Errorf("source %s: %s: %w", s.cfg.Name, from, err))
	}
	// Not a file: a folder.
	if err := operations.DirMove(ctx, f, from, to); err != nil {
		return File{}, s.failed(fmt.Errorf("source %s: moving the folder %s: %w", s.cfg.Name, from, err))
	}
	return File{Path: to}, nil
}

//go:build nextcloud

package main

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

// TestNextcloud runs the WebDAV source against a real Nextcloud: the
// disposable one of scripts/nextcloud-test.sh, which seeds the folder of
// STORAGE_TEST_URL and writes the credentials in STORAGE_TEST_CRED.
func TestNextcloud(t *testing.T) {
	url, cred := os.Getenv("STORAGE_TEST_URL"), os.Getenv("STORAGE_TEST_CRED")
	if url == "" || cred == "" {
		t.Skip("run through scripts/nextcloud-test.sh")
	}
	s := newSource(SourceConfig{Name: "nc", Kind: KindWebDAV, URL: url, Vendor: "nextcloud", Credentials: cred, Move: true})
	ctx := context.Background()
	page, err := s.List(ctx, "", 1000)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]File{}
	for _, f := range page.Files {
		got[f.Path] = f
	}
	for _, p := range []string{"2024/fattura_T1.pdf", "2024/fattura_T2.pdf", "leggimi.txt", "archivio/2023/nota.txt", "con spazio è.txt"} {
		if _, ok := got[p]; !ok {
			t.Errorf("no %s in %v", p, page.Files)
		}
	}
	// The time the client gave (X-OC-Mtime) is the file's.
	want := time.Date(2024, 3, 1, 10, 0, 0, 0, time.UTC)
	if f := got["2024/fattura_T1.pdf"]; !f.Modified.Equal(want) || f.Size != 20 {
		t.Errorf("fattura_T1.pdf %+v, modified %s", f, want)
	}

	o, err := s.Object(ctx, "2024/fattura_T1.pdf")
	if err != nil {
		t.Fatal(err)
	}
	r := newObjectReader(ctx, o)
	if _, err := r.Seek(9, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	rest, err := io.ReadAll(r)
	r.Close()
	if err != nil || string(rest) != "fattura T1\n" {
		t.Errorf("from 9: %q %v", rest, err)
	}

	before := got["2024/fattura_T2.pdf"]
	moved, err := s.Move(ctx, "2024/fattura_T2.pdf", "done/fattura_T2.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if moved.ETag != before.ETag {
		t.Errorf("the move changed the etag: %s, then %s", before.ETag, moved.ETag)
	}
	if _, err := s.Move(ctx, "archivio", "done/archivio"); err != nil {
		t.Errorf("a folder: %v", err)
	}
	page, err = s.List(ctx, "", 1000)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range page.Files {
		paths = append(paths, f.Path)
	}
	all := strings.Join(paths, ",")
	if !strings.Contains(all, "done/fattura_T2.pdf") || !strings.Contains(all, "done/archivio/2023/nota.txt") || strings.Contains(all, "2024/fattura_T2.pdf") {
		t.Errorf("after the moves: %v", paths)
	}

	// Wrong credentials: refused, and not asked again at once.
	bad := t.TempDir() + "/bad"
	if err := os.WriteFile(bad, []byte("storage\nwrong\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := newSource(SourceConfig{Name: "bad", Kind: KindWebDAV, URL: url, Vendor: "nextcloud", Credentials: bad})
	if _, err := b.List(ctx, "", 10); err == nil || !strings.Contains(err.Error(), "refused its credentials") {
		t.Errorf("wrong credentials: %v", err)
	}
	if _, err := b.List(ctx, "", 10); err == nil || !strings.Contains(err.Error(), "not asked again") {
		t.Errorf("again: %v", err)
	}
}

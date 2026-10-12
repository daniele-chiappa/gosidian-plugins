//go:build garage

package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/operations"
)

// TestGarage runs the S3 source against a real S3, the disposable Garage
// of scripts/s3-test.sh: STORAGE_S3_ENDPOINT, and the key in
// STORAGE_S3_CRED.
func TestGarage(t *testing.T) {
	endpoint, cred := os.Getenv("STORAGE_S3_ENDPOINT"), os.Getenv("STORAGE_S3_CRED")
	if endpoint == "" || cred == "" {
		t.Skip("run through scripts/s3-test.sh")
	}
	cfg := &Config{Sources: []SourceConfig{{Name: "garage", Kind: KindS3, Endpoint: endpoint, Region: "garage",
		Bucket: "lab", Prefix: "docs", PathStyle: true, Credentials: cred, Move: true}}}
	if err := cfg.check(); err != nil {
		t.Fatal(err)
	}
	s := newSource(cfg.Sources[0])
	ctx := context.Background()
	f, err := s.fs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	when := time.Date(2024, 3, 1, 10, 0, 0, 0, time.UTC)
	for p, body := range map[string]string{"2024/fattura_T1.pdf": "%PDF-1.4 fattura T1\n", "leggimi.txt": "S3 di prova\n"} {
		if _, err := operations.Rcat(ctx, f, p, io.NopCloser(strings.NewReader(body)), when, nil); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.List(ctx, "", 100)
	if err != nil || len(page.Files) != 2 {
		t.Fatalf("list %+v %v", page, err)
	}
	b := page.Files[0]
	if b.Path != "2024/fattura_T1.pdf" || !strings.HasPrefix(b.ETag, "md5-") || !b.Modified.Equal(when) {
		t.Errorf("fattura %+v", b)
	}
	link, err := s.Presign(ctx, b.Path, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, link, nil)
	req.Header.Set("Range", "bytes=9-")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent || string(body) != "fattura T1\n" {
		t.Errorf("range of the presigned URL: %d %q", resp.StatusCode, body)
	}
	moved, err := s.Move(ctx, b.Path, "done/fattura_T1.pdf")
	if err != nil || moved.ETag != b.ETag {
		t.Errorf("move %+v %v (etag was %s)", moved, err, b.ETag)
	}
	bad := t.TempDir() + "/bad"
	_ = os.WriteFile(bad, []byte("GKbad\nwrong\n"), 0o600)
	cfg.Sources[0].Credentials = bad
	w := newSource(cfg.Sources[0])
	if _, err := w.List(ctx, "", 10); err == nil || !strings.Contains(err.Error(), "refused its credentials") {
		t.Errorf("wrong key: %v", err)
	}
}

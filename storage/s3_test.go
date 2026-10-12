package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/rclone/gofakes3"
	"github.com/rclone/gofakes3/s3mem"
)

// s3Server is an S3 in memory that wants the key AKID/SECRET, with a
// bucket lab holding files under docs/.
func s3Server(t *testing.T) *httptest.Server {
	t.Helper()
	be := s3mem.New()
	ctx := context.Background()
	if err := be.CreateBucket(ctx, "lab"); err != nil {
		t.Fatal(err)
	}
	for key, body := range map[string]string{
		"docs/a.txt": "alpha", "docs/2024/b.pdf": "%PDF-b content", "docs/2024/c.xml": "<c/>", "other/z.txt": "z",
	} {
		if _, err := be.PutObject(ctx, "lab", key, map[string]string{}, strings.NewReader(body), int64(len(body))); err != nil {
			t.Fatal(err)
		}
	}
	ts := httptest.NewServer(gofakes3.New(be, gofakes3.WithV4Auth(map[string]string{"AKID": "SECRET"})).Server())
	t.Cleanup(ts.Close)
	return ts
}

func s3Source(t *testing.T, endpoint, key, secret string, move bool) *Source {
	cfg := &Config{Sources: []SourceConfig{{Name: "s3", Kind: KindS3, Endpoint: endpoint, Region: "us-east-1",
		Bucket: "lab", Prefix: "/docs/", PathStyle: true, Credentials: credentials(t, key, secret), Move: move}}}
	if err := cfg.check(); err != nil {
		t.Fatal(err)
	}
	return newSource(cfg.Sources[0])
}

func TestS3_ListPresignMove(t *testing.T) {
	ts := s3Server(t)
	s := s3Source(t, ts.URL, "AKID", "SECRET", true)
	ctx := context.Background()
	var all []File
	page, err := s.List(ctx, "", 2)
	for {
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, page.Files...)
		if page.Next == "" {
			break
		}
		page, err = s.List(ctx, page.Next, 2)
	}
	var paths []string
	for _, f := range all {
		paths = append(paths, f.Path)
	}
	if strings.Join(paths, ",") != "2024/b.pdf,2024/c.xml,a.txt" {
		t.Fatalf("paths %v: the prefix is the root", paths)
	}
	b := all[0]
	if !strings.HasPrefix(b.ETag, "md5-") || b.Size != 14 {
		t.Errorf("b.pdf %+v: the etag is S3's MD5", b)
	}

	// A presigned URL of S3: ranges, from S3 itself.
	link, err := s.Presign(ctx, "2024/b.pdf", 10*60*1e9)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(link)
	if !strings.HasPrefix(ts.URL, "http://"+u.Host) || u.Query().Get("X-Amz-Signature") == "" {
		t.Fatalf("presigned %s", link)
	}
	req, _ := http.NewRequest(http.MethodGet, link, nil)
	req.Header.Set("Range", "bytes=7-")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	// gofakes3 answers a range with 200; S3 and Garage with 206
	// (scripts/s3-test.sh).
	if (resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK) || string(body) != "content" {
		t.Errorf("range of the presigned URL: %d %q", resp.StatusCode, body)
	}

	// A move on S3 is a copy: the etag, a hash of the content, stays.
	moved, err := s.Move(ctx, "2024/b.pdf", "done/b.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if moved.ETag != b.ETag || moved.Path != "done/b.pdf" {
		t.Errorf("moved %+v, was %+v", moved, b)
	}
	if _, err := s.Object(ctx, "2024/b.pdf"); err == nil {
		t.Error("the file is still where it was")
	}
}

func TestS3_RefusedCredentials(t *testing.T) {
	ts := s3Server(t)
	s := s3Source(t, ts.URL, "AKID", "WRONG", false)
	if _, err := s.List(context.Background(), "", 10); err == nil || !strings.Contains(err.Error(), "refused its credentials") {
		t.Fatalf("list: %v", err)
	}
	if _, err := s.List(context.Background(), "", 10); err == nil || !strings.Contains(err.Error(), "not asked again") {
		t.Errorf("again: %v", err)
	}
}

func TestS3_ConfigHosts(t *testing.T) {
	cfg := &Config{Sources: []SourceConfig{
		{Name: "aws", Kind: KindS3, Region: "eu-south-1", Bucket: "fatture", Credentials: "/c"},
		{Name: "garage", Kind: KindS3, Endpoint: "http://garage:3900", Region: "garage", Bucket: "lab", PathStyle: true, Credentials: "/c"},
		{Name: "r2", Kind: KindS3, Endpoint: "https://acct.r2.cloudflarestorage.com", Bucket: "b", Credentials: "/c", Presign: new(bool)},
	}}
	if err := cfg.check(); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(cfg.FileHosts(), ","); got != "fatture.s3.eu-south-1.amazonaws.com,garage:3900" {
		t.Errorf("file hosts %s", got)
	}
	if got := strings.Join(cfg.Hosts(), ","); got != "s3.eu-south-1.amazonaws.com,garage:3900,acct.r2.cloudflarestorage.com" {
		t.Errorf("hosts %s", got)
	}
	if cfg.Sources[0].Provider != "AWS" || cfg.Sources[1].Provider != "Other" {
		t.Errorf("providers %s %s", cfg.Sources[0].Provider, cfg.Sources[1].Provider)
	}
	for name, bad := range map[string]SourceConfig{
		"no bucket":    {Name: "a", Kind: KindS3, Region: "x", Credentials: "/c"},
		"no region":    {Name: "a", Kind: KindS3, Bucket: "b", Credentials: "/c"},
		"bad endpoint": {Name: "a", Kind: KindS3, Endpoint: "ftp://x", Bucket: "b", Credentials: "/c"},
		"no cred":      {Name: "a", Kind: KindS3, Region: "x", Bucket: "b"},
		"drive both":   {Name: "a", Kind: KindDrive, Credentials: "/c", RootFolderID: "x", TeamDrive: "y"},
		"drive none":   {Name: "a", Kind: KindDrive, Credentials: "/c"},
	} {
		c := &Config{Sources: []SourceConfig{bad}}
		if err := c.check(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

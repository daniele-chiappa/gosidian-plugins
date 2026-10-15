package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

// A bench on real images: IMAGES_SAMPLE_DIR names a folder of them,
// IMAGES_SAMPLE_FORMAT the format (png, the default, or webp), and
// IMAGES_PNG_LEVEL oxipng's level as for the plugin. Every image
// is converted, its pixels checked against the original's, and the weights
// and the time logged (go test -run TestSample -v).
func TestSample(t *testing.T) {
	dir := os.Getenv("IMAGES_SAMPLE_DIR")
	if dir == "" {
		t.Skip("IMAGES_SAMPLE_DIR names no folder")
	}
	needTools(t)
	format := os.Getenv("IMAGES_SAMPLE_FORMAT")
	if format == "" {
		format = FormatPNG
	}
	c := testConverter()
	level, err := envInt("IMAGES_PNG_LEVEL", defaultPNGLevel)
	if err != nil {
		t.Fatal(err)
	}
	c.PNGLevel = level
	names, _ := filepath.Glob(filepath.Join(dir, "*"))
	var mu sync.Mutex
	var before, after int64
	var kept, converted int
	sem := make(chan struct{}, runtime.NumCPU())
	var wg sync.WaitGroup
	start := time.Now()
	for _, n := range names {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			src, err := os.ReadFile(n)
			if err != nil {
				t.Error(err)
				return
			}
			out, res, err := c.Convert(context.Background(), filepath.Base(n), src, Options{Format: format, Strip: true, OnlyIfSmaller: true})
			if err != nil {
				t.Errorf("%s: %v", n, err)
				return
			}
			if out != nil {
				samePixels(t, src, out)
			}
			mu.Lock()
			before += res.FromBytes
			after += res.ToBytes
			if res.Kept {
				kept++
			} else {
				converted++
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	t.Logf("%s: %d images, %d converted, %d kept; %d → %d bytes (%.1f%%) in %s on %d CPUs",
		format, len(names), converted, kept, before, after, 100*float64(after)/float64(before), time.Since(start).Round(time.Second), runtime.NumCPU())
}

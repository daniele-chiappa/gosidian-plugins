// Command gosidian-images is a gosidian plugin that converts images
// without loss: a PNG optimized with oxipng, or WebP with cwebp, and TIFF
// to PNG, as gosidian keeps no TIFF attachment, read with libvips;
// scaled down on request. A node for the pipelines and the same tool for the
// agents, its files by reference (gosidian docs/plugins.md).
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"
)

// version is set at build time (-ldflags "-X main.version=…").
var version = "dev"

// defaultPNGLevel is oxipng's -o: on 300 screenshots exported from Word, 2
// made them 66.9% of their weight in 19 s, 4 made them 65.7% in 96 s.
const defaultPNGLevel = 2

// defaultMaxPixels is the largest image decoded, width × height: 100
// megapixels, a scan of 10000×10000. On one of them cwebp held 2.8 GB and
// oxipng 1.3 GB, for each worker that converts one.
const defaultMaxPixels = 100_000_000

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envInt(name string, def int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s=%q: a positive number", name, v)
	}
	return n, nil
}

func main() {
	port := env("PORT", "8000")
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(port))
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(port, log); err != nil {
		log.Error("gosidian-images", "err", err)
		os.Exit(1)
	}
}

// config reads the plugin's settings from the environment.
func config(log *slog.Logger) (*Plugin, error) {
	workers, err := envInt("IMAGES_WORKERS", min(runtime.NumCPU(), 8))
	if err != nil {
		return nil, err
	}
	maxMiB, err := envInt("IMAGES_MAX_MIB", 64)
	if err != nil {
		return nil, err
	}
	maxPixels, err := envInt("IMAGES_MAX_PIXELS", defaultMaxPixels)
	if err != nil {
		return nil, err
	}
	// gosidian stores at most 100 MiB of the files of one result.
	callMiB, err := envInt("IMAGES_MAX_CALL_MIB", 64)
	if err != nil {
		return nil, err
	}
	level, err := envInt("IMAGES_PNG_LEVEL", defaultPNGLevel)
	if err != nil || level > 6 {
		return nil, fmt.Errorf("IMAGES_PNG_LEVEL: from 1 to 6 (oxipng -o)")
	}
	z, err := envInt("IMAGES_WEBP_Z", 6)
	if err != nil || z > 9 {
		return nil, fmt.Errorf("IMAGES_WEBP_Z: from 1 to 9 (cwebp -z)")
	}
	secs, err := envInt("IMAGES_TIMEOUT", 120)
	if err != nil {
		return nil, err
	}
	for _, tool := range []string{"vips", "vipsheader", "oxipng", "cwebp"} {
		if _, err := exec.LookPath(tool); err != nil {
			return nil, fmt.Errorf("%s is not installed: %w", tool, err)
		}
	}
	return &Plugin{
		conv:    &Converter{PNGLevel: level, WebPZ: z, MaxPixels: int64(maxPixels), Timeout: time.Duration(secs) * time.Second},
		token:   os.Getenv("GOSIDIAN_PLUGIN_TOKEN"),
		workers: workers, maxBytes: int64(maxMiB) << 20, maxCallBytes: int64(callMiB) << 20,
		client: &http.Client{Timeout: 5 * time.Minute},
		log:    log,
	}, nil
}

func run(port string, log *slog.Logger) error {
	p, err := config(log)
	if err != nil {
		return err
	}
	if p.token == "" {
		log.Warn("GOSIDIAN_PLUGIN_TOKEN is empty: /mcp answers anyone who reaches it")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{Addr: ":" + port, Handler: p.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("gosidian-images", "version", version, "port", port, "workers", p.workers,
		"max_mib", p.maxBytes>>20, "max_pixels", p.conv.MaxPixels, "max_call_mib", p.maxCallBytes>>20,
		"png_level", p.conv.PNGLevel, "webp_z", p.conv.WebPZ)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// healthcheck asks the running plugin for /health: 0 when it answers.
func healthcheck(port string) int {
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

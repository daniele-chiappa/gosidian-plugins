package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The conversion runs the programs of the image: libvips (vips,
// vipsheader) reads every format and scales down, oxipng optimizes a PNG,
// cwebp writes WebP without loss. Each image gets a folder of its own under
// the temporary folder, removed when it is done.

// Formats of the output.
const (
	FormatPNG  = "png"  // PNG, optimized with oxipng
	FormatWebP = "webp" // WebP without loss
	FormatKeep = "keep" // the same format, optimized when it can be
)

// Options say how to convert.
type Options struct {
	Format        string
	MaxSide       int  // scale the longer side down to it; 0: never
	Strip         bool // leave the metadata out (EXIF, text chunks)
	OnlyIfSmaller bool // keep the original when the result weighs as much or more
}

// Result is what happened to one image.
type Result struct {
	Name      string `json:"name"`             // the input's name
	Output    string `json:"output,omitempty"` // the file given back; empty when kept
	Format    string `json:"format"`           // the format of what the vault gets
	FromBytes int64  `json:"from_bytes"`
	ToBytes   int64  `json:"to_bytes"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	Kept      bool   `json:"kept"`
	Reason    string `json:"reason,omitempty"` // why it was kept, or why its format is not the one asked
	Scaled    bool   `json:"scaled,omitempty"`
}

// Converter runs the programs.
type Converter struct {
	PNGLevel  int           // oxipng -o
	WebPZ     int           // cwebp -z
	MaxPixels int64         // width × height of the largest image it decodes
	Timeout   time.Duration // for one image
	TempDir   string        // "" for the system's
}

// kind is a format as the bytes say it.
func kind(data []byte) string {
	head := data
	if len(head) > 64 {
		head = head[:64]
	}
	switch {
	case bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
		return "png"
	case bytes.HasPrefix(head, []byte{0xff, 0xd8, 0xff}):
		return "jpeg"
	case bytes.HasPrefix(head, []byte("GIF87a")), bytes.HasPrefix(head, []byte("GIF89a")):
		return "gif"
	case len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return "webp"
	case bytes.HasPrefix(head, []byte("II*\x00")), bytes.HasPrefix(head, []byte("MM\x00*")):
		return "tiff"
	case len(head) >= 12 && string(head[4:8]) == "ftyp":
		// Known only to say it is not read: Alpine's HEIF loader brings
		// HEVC codecs, left out of the image.
		switch string(head[8:12]) {
		case "heic", "heix", "hevc", "heim", "heis", "mif1", "msf1", "avif", "avis":
			return "heif"
		}
	}
	t := strings.TrimSpace(strings.ToLower(string(head)))
	if strings.HasPrefix(t, "<svg") || strings.HasPrefix(t, "<?xml") && bytes.Contains(bytes.ToLower(data[:min(len(data), 1024)]), []byte("<svg")) {
		return "svg"
	}
	return ""
}

// vaultTakes says whether gosidian keeps a format as an attachment.
func vaultTakes(k string) bool {
	switch k {
	case "png", "jpeg", "gif", "webp", "svg":
		return true
	}
	return false
}

var extOf = map[string]string{"png": ".png", "jpeg": ".jpg", "gif": ".gif", "webp": ".webp", "tiff": ".tif", "svg": ".svg"}

// Convert converts one image. It returns the bytes of the output, nil when
// the original is kept (Result.Kept, with the reason), or an error for an
// image it cannot read.
func (c *Converter) Convert(ctx context.Context, name string, data []byte, o Options) ([]byte, Result, error) {
	res := Result{Name: name, FromBytes: int64(len(data))}
	in := kind(data)
	keep := func(why string) ([]byte, Result, error) {
		res.Kept, res.Reason, res.Format, res.ToBytes = true, why, in, int64(len(data))
		return nil, res, nil
	}
	switch in {
	case "":
		return nil, res, errors.New("not an image this plugin reads (PNG, JPEG, GIF, WebP, TIFF)")
	case "heif":
		return nil, res, errors.New("HEIF and AVIF are not read here: PNG, JPEG, GIF, WebP, TIFF")
	case "svg":
		return keep("svg: not an image of pixels")
	}
	if c.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.Timeout)
		defer cancel()
	}
	dir, err := os.MkdirTemp(c.TempDir, "img-")
	if err != nil {
		return nil, res, err
	}
	defer os.RemoveAll(dir)
	src := filepath.Join(dir, "in"+extOf[in])
	if err := os.WriteFile(src, data, 0o600); err != nil {
		return nil, res, err
	}
	hd, err := c.header(ctx, src)
	if err != nil {
		return nil, res, fmt.Errorf("reading the image: %w", err)
	}
	w, h := hd.width, hd.height
	res.Width, res.Height = w, h
	if hd.pages > 1 && vaultTakes(in) {
		return keep("an animation: its frames are kept as they are")
	}
	// A few kilobytes can say 30000×30000: oxipng and cwebp would hold
	// gigabytes for it, once for each worker. The header says the size
	// before any program decodes a pixel.
	if px := int64(w) * int64(h); px > c.MaxPixels {
		return nil, res, fmt.Errorf("%dx%d is %d pixels, more than %d (IMAGES_MAX_PIXELS)", w, h, px, c.MaxPixels)
	}
	// vips reads the first page alone, and a PNG holds one: the others
	// would be lost without a word.
	if hd.pages > 1 {
		return nil, res, fmt.Errorf("a %s of %d pages: a PNG holds one, the others would be lost", strings.ToUpper(in), hd.pages)
	}
	// PNG holds 8 or 16 bits a sample: vips would cut a float or a 32-bit
	// one (a TIFF's) to them.
	if hd.format != "uchar" && hd.format != "ushort" {
		return nil, res, fmt.Errorf("samples of type %s: a PNG holds 8 or 16 bits, they would be cut", hd.format)
	}

	format := o.Format
	switch format {
	case "", FormatPNG:
		format = FormatPNG
	case FormatWebP:
	case FormatKeep:
		switch in {
		case "png":
			format = FormatPNG
		case "jpeg", "gif", "webp":
			if o.MaxSide <= 0 || max(w, h) <= o.MaxSide {
				return keep("format keep: nothing to optimize without loss")
			}
			format = FormatPNG
		default:
			format = FormatPNG // the vault takes no TIFF
		}
	default:
		return nil, res, fmt.Errorf("format %q: png, webp or keep", o.Format)
	}

	// Scaled down first, to a PNG: the output's encoder reads it. vips
	// thumbnail turns the image by its EXIF orientation as it scales.
	sample := hd.format
	if o.MaxSide > 0 && max(w, h) > o.MaxSide {
		scaled := filepath.Join(dir, "scaled.png")
		if err := c.run(ctx, "vips", "thumbnail", src, scaled, strconv.Itoa(o.MaxSide), "--size", "down"); err != nil {
			return nil, res, err
		}
		src, res.Scaled = scaled, true
		sd, err := c.header(ctx, src)
		if err != nil {
			return nil, res, err
		}
		res.Width, res.Height, sample = sd.width, sd.height, sd.format
	} else if hd.orientation != 1 {
		// A photo stands as its EXIF orientation says: oxipng's --strip
		// safe and cwebp's -metadata none leave that out, and few viewers
		// read it in a PNG. Turned for good, it looks the same everywhere;
		// turning moves pixels, it loses none, and vips writes orientation
		// 1 in the metadata it keeps.
		turned := filepath.Join(dir, "turned.png")
		if err := c.run(ctx, "vips", "autorot", src, turned); err != nil {
			return nil, res, err
		}
		src = turned
		if hd.orientation >= 5 { // 5 to 8 swap the sides
			res.Width, res.Height = h, w
		}
	}
	// cwebp cuts 16 bits a sample to 8: a PNG keeps them.
	if format == FormatWebP && sample == "ushort" {
		format, res.Reason = FormatPNG, "16 bits a sample: WebP holds 8, a PNG keeps them"
	}

	out := filepath.Join(dir, "out."+format)
	switch format {
	case FormatPNG:
		png := src
		if !strings.HasSuffix(src, ".png") {
			png = filepath.Join(dir, "decoded.png")
			if err := c.run(ctx, "vips", "copy", src, png); err != nil {
				return nil, res, err
			}
		}
		args := []string{"-q", "-o", strconv.Itoa(c.PNGLevel), "--out", out}
		if o.Strip {
			args = append(args, "--strip", "safe")
		}
		if err := c.run(ctx, "oxipng", append(args, png)...); err != nil {
			return nil, res, err
		}
	case FormatWebP:
		// cwebp reads PNG, JPEG and WebP: a GIF, or a TIFF (Alpine's cwebp
		// is built without libtiff), is decoded to a PNG first.
		webpIn := src
		if ext := filepath.Ext(src); ext == ".gif" || ext == ".tif" {
			webpIn = filepath.Join(dir, "decoded.png")
			if err := c.run(ctx, "vips", "copy", src, webpIn); err != nil {
				return nil, res, err
			}
		}
		meta := "all"
		if o.Strip {
			meta = "none"
		}
		if err := c.run(ctx, "cwebp", "-quiet", "-lossless", "-z", strconv.Itoa(c.WebPZ), "-metadata", meta, webpIn, "-o", out); err != nil {
			return nil, res, err
		}
	}
	b, err := os.ReadFile(out)
	if err != nil {
		return nil, res, err
	}
	if o.OnlyIfSmaller && !res.Scaled && vaultTakes(in) && len(b) >= len(data) {
		return keep(fmt.Sprintf("%s weighed %d bytes, no less than the original", format, len(b)))
	}
	res.Format, res.ToBytes = format, int64(len(b))
	res.Output = strings.TrimSuffix(name, filepath.Ext(name)) + "." + format
	return b, res, nil
}

// info is what vipsheader says of an image, without decoding it.
type info struct {
	width, height int
	format        string // of the samples: uchar (8 bits), ushort (16), float…
	pages         int    // pages or frames, 1 for most
	orientation   int    // EXIF's, 1 (as it stands) to 8
}

// header reads an image's size, samples, pages (frames) and orientation
// with vipsheader.
func (c *Converter) header(ctx context.Context, file string) (info, error) {
	// The summary, "in.png: 1133x717 uchar, 3 bands, srgb, pngload": the
	// size and the samples in one run.
	out, err := exec.CommandContext(ctx, "vipsheader", file).Output()
	if err != nil {
		return info{}, toolError("vipsheader", err)
	}
	var hd info
	line := strings.TrimPrefix(strings.TrimSpace(string(out)), file+": ")
	if _, err := fmt.Sscanf(line, "%dx%d %s", &hd.width, &hd.height, &hd.format); err != nil || hd.width <= 0 || hd.height <= 0 {
		return info{}, fmt.Errorf("vipsheader read no size: %q", line)
	}
	hd.format = strings.TrimSuffix(hd.format, ",")
	hd.pages, hd.orientation = 1, 1
	if n := c.field(ctx, file, "n-pages"); n > 0 {
		hd.pages = n
	}
	if n := c.field(ctx, file, "orientation"); n >= 1 && n <= 8 {
		hd.orientation = n
	}
	return hd, nil
}

// field reads a number of an image's header, 0 when it has none.
func (c *Converter) field(ctx context.Context, file, name string) int {
	out, err := exec.CommandContext(ctx, "vipsheader", "-f", name, file).Output()
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

func (c *Converter) run(ctx context.Context, name string, args ...string) error {
	if out, err := exec.CommandContext(ctx, name, args...).CombinedOutput(); err != nil {
		if len(out) > 0 {
			err = fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
		}
		return toolError(name, err)
	}
	return nil
}

func toolError(name string, err error) error {
	var ee *exec.ExitError
	if errors.As(err, &ee) && len(ee.Stderr) > 0 {
		err = fmt.Errorf("%w: %s", err, strings.TrimSpace(string(ee.Stderr)))
	}
	return fmt.Errorf("%s: %w", name, err)
}

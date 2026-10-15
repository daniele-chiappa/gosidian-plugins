package main

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/color/palette"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "golang.org/x/image/webp" // decodes the WebP the plugin writes
)

// needTools skips a test without the programs of the image, or fails it
// when IMAGES_REQUIRE_TOOLS is set (scripts/test.sh).
func needTools(t *testing.T) {
	t.Helper()
	for _, tool := range []string{"vips", "vipsheader", "oxipng", "cwebp"} {
		if _, err := exec.LookPath(tool); err != nil {
			if os.Getenv("IMAGES_REQUIRE_TOOLS") != "" {
				t.Fatalf("%s is not installed", tool)
			}
			t.Skipf("%s is not installed: run scripts/test.sh", tool)
		}
	}
}

func testConverter() *Converter {
	return &Converter{PNGLevel: 2, WebPZ: 6, MaxPixels: defaultMaxPixels, Timeout: time.Minute}
}

// screenshot is an image like a screenshot: flat areas, lines and some
// noise, in the given model.
func screenshot(w, h int, alpha bool) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			c := color.NRGBA{240, 240, 240, 255}
			switch {
			case y%20 == 0 || x%50 == 0:
				c = color.NRGBA{60, 90, 140, 255}
			case (x*7+y*13)%97 == 0:
				c = color.NRGBA{uint8(x), uint8(y), uint8(x ^ y), 255}
			}
			if alpha && x < w/4 {
				c.A = uint8(255 * x / (w / 4))
			}
			img.Set(x, y, c)
		}
	}
	return img
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.NoCompression}).Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// samePixels decodes two images and compares them pixel by pixel, as
// non-premultiplied RGBA.
func samePixels(t *testing.T, a, b []byte) {
	t.Helper()
	ia, _, err := image.Decode(bytes.NewReader(a))
	if err != nil {
		t.Fatalf("decoding the original: %v", err)
	}
	ib, format, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("decoding the output: %v", err)
	}
	if ia.Bounds().Size() != ib.Bounds().Size() {
		t.Fatalf("size %v, the original's %v", ib.Bounds().Size(), ia.Bounds().Size())
	}
	na, nb := image.NewNRGBA(ia.Bounds()), image.NewNRGBA(ib.Bounds())
	draw.Draw(na, na.Bounds(), ia, ia.Bounds().Min, draw.Src)
	draw.Draw(nb, nb.Bounds(), ib, ib.Bounds().Min, draw.Src)
	for i := 0; i < len(na.Pix); i += 4 {
		pa, pb := na.Pix[i:i+4], nb.Pix[i:i+4]
		// A fully transparent pixel has no colour to keep.
		if pa[3] == 0 && pb[3] == 0 {
			continue
		}
		if !bytes.Equal(pa, pb) {
			x, y := (i/4)%na.Bounds().Dx(), (i/4)/na.Bounds().Dx()
			t.Fatalf("%s: pixel (%d,%d) is %v, the original's %v", format, x, y, pb, pa)
		}
	}
}

// Without loss: every pixel of the output is the original's, in PNG and
// in WebP, for colour, transparency, grey and a palette; and the output
// weighs less than a PNG written without compression.
func TestConvert_Lossless(t *testing.T) {
	needTools(t)
	gray := image.NewGray(image.Rect(0, 0, 120, 80))
	pal := image.NewPaletted(image.Rect(0, 0, 120, 80), palette.WebSafe)
	for y := range 80 {
		for x := range 120 {
			gray.SetGray(x, y, color.Gray{uint8(x + y)})
			pal.SetColorIndex(x, y, uint8((x/10+y/10)%len(palette.WebSafe)))
		}
	}
	cases := map[string]image.Image{
		"rgb": screenshot(300, 200, false), "rgba": screenshot(300, 200, true),
		"gray": gray, "palette": pal,
	}
	c := testConverter()
	for name, img := range cases {
		src := encodePNG(t, img)
		for _, format := range []string{FormatPNG, FormatWebP} {
			out, res, err := c.Convert(context.Background(), name+".png", src, Options{Format: format, Strip: true, OnlyIfSmaller: true})
			if err != nil {
				t.Fatalf("%s to %s: %v", name, format, err)
			}
			if res.Kept || out == nil {
				t.Fatalf("%s to %s kept: %s", name, format, res.Reason)
			}
			if res.Format != format || res.Output != name+"."+format || res.ToBytes != int64(len(out)) || res.ToBytes >= res.FromBytes {
				t.Errorf("%s to %s: %+v", name, format, res)
			}
			if res.Width != img.Bounds().Dx() || res.Height != img.Bounds().Dy() {
				t.Errorf("%s to %s: size %dx%d", name, format, res.Width, res.Height)
			}
			samePixels(t, src, out)
		}
	}
}

// A JPEG gets no lighter without loss: only_if_smaller keeps it. An SVG,
// an animated GIF and format keep on a JPEG are kept too; bytes that are no
// image are an error.
func TestConvert_Kept(t *testing.T) {
	needTools(t)
	c := testConverter()
	var jb bytes.Buffer
	if err := jpeg.Encode(&jb, screenshot(300, 200, false), &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	pal := []*image.Paletted{image.NewPaletted(image.Rect(0, 0, 20, 20), palette.Plan9), image.NewPaletted(image.Rect(0, 0, 20, 20), palette.Plan9)}
	pal[1].SetColorIndex(3, 3, 7)
	var gb bytes.Buffer
	if err := gif.EncodeAll(&gb, &gif.GIF{Image: pal, Delay: []int{10, 10}}); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		data []byte
		o    Options
	}{
		"jpeg to png":  {jb.Bytes(), Options{Format: FormatPNG, OnlyIfSmaller: true}},
		"jpeg keep":    {jb.Bytes(), Options{Format: FormatKeep, OnlyIfSmaller: true}},
		"svg":          {[]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`), Options{Format: FormatPNG}},
		"animated gif": {gb.Bytes(), Options{Format: FormatWebP}},
	} {
		out, res, err := c.Convert(context.Background(), "x", tc.data, tc.o)
		if err != nil || out != nil || !res.Kept || res.Reason == "" || res.ToBytes != res.FromBytes {
			t.Errorf("%s: %v %+v %v", name, out != nil, res, err)
		}
	}
	if _, _, err := c.Convert(context.Background(), "x.png", []byte("not an image"), Options{}); err == nil {
		t.Error("no error for bytes that are no image")
	}
	if _, _, err := c.Convert(context.Background(), "x.png", []byte("\x89PNG\r\n\x1a\nbroken"), Options{}); err == nil {
		t.Error("no error for a broken PNG")
	}
}

// A TIFF, which the vault takes not, always comes out as a PNG with its
// pixels; max_side scales the longer side down.
func TestConvert_TIFFAndMaxSide(t *testing.T) {
	needTools(t)
	c := testConverter()
	src := encodePNG(t, screenshot(400, 100, false))
	dir := t.TempDir()
	p, tif := filepath.Join(dir, "a.png"), filepath.Join(dir, "a.tif")
	if err := os.WriteFile(p, src, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := exec.Command("vips", "copy", p, tif+"[compression=lzw]").Run(); err != nil {
		t.Fatal(err)
	}
	tb, _ := os.ReadFile(tif)
	out, res, err := c.Convert(context.Background(), "scan.tif", tb, Options{Format: FormatKeep, OnlyIfSmaller: true})
	if err != nil || out == nil || res.Format != FormatPNG || res.Output != "scan.png" {
		t.Fatalf("tiff: %+v %v", res, err)
	}
	samePixels(t, src, out)
	// Alpine's cwebp reads no TIFF: it gets a PNG of it.
	out, res, err = c.Convert(context.Background(), "scan.tif", tb, Options{Format: FormatWebP, OnlyIfSmaller: true})
	if err != nil || out == nil || res.Format != FormatWebP || res.Output != "scan.webp" {
		t.Fatalf("tiff to webp: %+v %v", res, err)
	}
	samePixels(t, src, out)

	out, res, err = c.Convert(context.Background(), "big.png", src, Options{Format: FormatPNG, MaxSide: 100, OnlyIfSmaller: true})
	if err != nil || out == nil || !res.Scaled || res.Width != 100 || res.Height != 25 {
		t.Fatalf("max_side: %+v %v", res, err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil || cfg.Width != 100 || cfg.Height != 25 {
		t.Errorf("scaled to %dx%d: %v", cfg.Width, cfg.Height, err)
	}
}

func TestKind(t *testing.T) {
	for want, data := range map[string]string{
		"png": "\x89PNG\r\n\x1a\n....", "jpeg": "\xff\xd8\xff\xe0", "gif": "GIF89a..", "webp": "RIFF\x00\x00\x00\x00WEBPVP8L",
		"tiff": "II*\x00....", "heif": "\x00\x00\x00\x18ftypheic....", "svg": "  <svg width='1'/>", "": "hello",
	} {
		if got := kind([]byte(data)); got != want {
			t.Errorf("%q: %q, want %q", data[:4], got, want)
		}
	}
	if kind([]byte(`<?xml version="1.0"?><svg/>`)) != "svg" || kind([]byte(`<?xml version="1.0"?><note/>`)) != "" {
		t.Error("an XML file is an svg only with <svg")
	}
	// A HEIF or an AVIF is known, to say it is not read.
	for _, brand := range []string{"heic", "avif"} {
		_, _, err := testConverter().Convert(context.Background(), "x", []byte("\x00\x00\x00\x18ftyp"+brand+"...."), Options{})
		if err == nil || !strings.Contains(err.Error(), "HEIF and AVIF are not read") {
			t.Errorf("%s: %v", brand, err)
		}
	}
}

// vipsFile writes a PNG to a file of the test, makes another of it with
// "vips op in out args…" (out may have options in brackets) and returns
// that one's bytes.
func vipsFile(t *testing.T, png []byte, op, out string, args ...string) []byte {
	t.Helper()
	dir := t.TempDir()
	in := filepath.Join(dir, "in.png")
	if err := os.WriteFile(in, png, 0o600); err != nil {
		t.Fatal(err)
	}
	out = filepath.Join(dir, out)
	if b, err := exec.Command("vips", append([]string{op, in, out}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("vips %s %v: %v %s", op, args, err, b)
	}
	b, err := os.ReadFile(strings.Split(out, "[")[0])
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// pngChunk is a chunk of a PNG: length, type, data and CRC.
func pngChunk(typ string, data []byte) []byte {
	b := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
	b = append(append(b, typ...), data...)
	return binary.BigEndian.AppendUint32(b, crc32.ChecksumIEEE(b[4:]))
}

// A PNG of a few hundred bytes whose header says 30000×30000, 900
// megapixels, is refused before a program decodes it; under
// IMAGES_MAX_PIXELS, an image is converted, and a pixel over, refused.
func TestConvert_MaxPixels(t *testing.T) {
	needTools(t)
	c := testConverter()
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr, 30000)
	binary.BigEndian.PutUint32(ihdr[4:], 30000)
	ihdr[8] = 8 // 8 bits of grey
	var z bytes.Buffer
	zw := zlib.NewWriter(&z)
	_, _ = zw.Write(make([]byte, 1+30000)) // one row of the 30000
	_ = zw.Close()
	bomb := append([]byte("\x89PNG\r\n\x1a\n"), pngChunk("IHDR", ihdr)...)
	bomb = append(append(bomb, pngChunk("IDAT", z.Bytes())...), pngChunk("IEND", nil)...)
	for _, format := range []string{FormatPNG, FormatWebP, FormatKeep} {
		start := time.Now()
		out, res, err := c.Convert(context.Background(), "bomb.png", bomb, Options{Format: format, Strip: true, OnlyIfSmaller: true})
		if err == nil || out != nil || !strings.Contains(err.Error(), "30000x30000") || !strings.Contains(err.Error(), "IMAGES_MAX_PIXELS") {
			t.Fatalf("%s: %d bytes, %+v %v", format, len(out), res, err)
		}
		if d := time.Since(start); d > 10*time.Second {
			t.Errorf("%s: refused in %s, as if decoded", format, d)
		}
	}

	src := encodePNG(t, screenshot(300, 200, false))
	c.MaxPixels = 300 * 200
	if _, _, err := c.Convert(context.Background(), "a.png", src, Options{Format: FormatPNG}); err != nil {
		t.Errorf("at the cap: %v", err)
	}
	c.MaxPixels--
	if _, _, err := c.Convert(context.Background(), "a.png", src, Options{Format: FormatPNG}); err == nil || !strings.Contains(err.Error(), "IMAGES_MAX_PIXELS") {
		t.Errorf("a pixel over the cap: %v", err)
	}
}

// A TIFF of three pages fails, in every format: vips would read the
// first, and the PNG would lose the others. A TIFF of float samples fails
// too, as a PNG would cut them.
func TestConvert_TIFFRefused(t *testing.T) {
	needTools(t)
	c := testConverter()
	pages := image.NewNRGBA(image.Rect(0, 0, 60, 120))
	for y := range 120 {
		for x := range 60 {
			pages.Set(x, y, color.NRGBA{uint8(x * 4), uint8(y / 40 * 100), uint8(y), 255})
		}
	}
	multi := vipsFile(t, encodePNG(t, pages), "copy", "pages.tif[page-height=40]")
	for _, format := range []string{FormatPNG, FormatWebP, FormatKeep} {
		out, res, err := c.Convert(context.Background(), "pages.tif", multi, Options{Format: format, OnlyIfSmaller: true})
		if err == nil || out != nil || res.Kept || !strings.Contains(err.Error(), "TIFF of 3 pages") {
			t.Errorf("%s: %d bytes, %+v %v", format, len(out), res, err)
		}
	}
	float := vipsFile(t, encodePNG(t, screenshot(60, 40, false)), "cast", "float.tif", "float")
	if out, _, err := c.Convert(context.Background(), "float.tif", float, Options{Format: FormatPNG}); err == nil || out != nil || !strings.Contains(err.Error(), "float") {
		t.Errorf("float samples: %v", err)
	}
}

// samePixels16 compares two images of 16 bits a sample, opaque, pixel by
// pixel: samePixels' 8 bits would not see them cut.
func samePixels16(t *testing.T, a, b []byte) {
	t.Helper()
	ia, _, err := image.Decode(bytes.NewReader(a))
	if err != nil {
		t.Fatalf("decoding the original: %v", err)
	}
	ib, format, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("decoding the output: %v", err)
	}
	if ia.Bounds().Size() != ib.Bounds().Size() {
		t.Fatalf("size %v, the original's %v", ib.Bounds().Size(), ia.Bounds().Size())
	}
	for y := range ia.Bounds().Dy() {
		for x := range ia.Bounds().Dx() {
			pa := color.NRGBA64Model.Convert(ia.At(ia.Bounds().Min.X+x, ia.Bounds().Min.Y+y))
			pb := color.NRGBA64Model.Convert(ib.At(ib.Bounds().Min.X+x, ib.Bounds().Min.Y+y))
			if pa != pb {
				t.Fatalf("%s: pixel (%d,%d) is %v, the original's %v", format, x, y, pb, pa)
			}
		}
	}
}

// An image of 16 bits a sample keeps them: a PNG, also when WebP is asked,
// as cwebp would cut them to 8; the reason says why. Scaled down, it has 8
// bits, and WebP is given.
func TestConvert_16Bit(t *testing.T) {
	needTools(t)
	c := testConverter()
	img := image.NewNRGBA64(image.Rect(0, 0, 200, 120))
	for y := range 120 {
		for x := range 200 {
			// Low bytes that 8 bits would lose.
			img.SetNRGBA64(x, y, color.NRGBA64{uint16(x*300 + 1), uint16(y*500 + 3), uint16((x ^ y) * 211), 0xffff})
		}
	}
	src := encodePNG(t, img)
	for _, format := range []string{FormatPNG, FormatWebP} {
		out, res, err := c.Convert(context.Background(), "deep.png", src, Options{Format: format, Strip: true, OnlyIfSmaller: true})
		if err != nil || out == nil || res.Format != FormatPNG || res.Output != "deep.png" {
			t.Fatalf("%s: %+v %v", format, res, err)
		}
		if format == FormatWebP && !strings.Contains(res.Reason, "16 bits") {
			t.Errorf("webp asked, png given without a reason: %+v", res)
		}
		samePixels16(t, src, out)
	}
	out, res, err := c.Convert(context.Background(), "deep.png", src, Options{Format: FormatWebP, MaxSide: 100})
	if err != nil || out == nil || res.Format != FormatWebP || !res.Scaled {
		t.Errorf("scaled: %+v %v", res, err)
	}
}

// exifOrientation is an eXIf chunk's data, a TIFF header and one entry:
// Orientation (0x0112), a SHORT, the given value.
func exifOrientation(o uint16) []byte {
	b := []byte("MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01")
	b = binary.BigEndian.AppendUint16(b, o)
	return append(b, 0, 0, 0, 0, 0, 0) // the value's padding, no next IFD
}

// A photo whose EXIF orientation says to turn it (6: 90° clockwise) comes
// back turned, its pixels moved and none lost, with no orientation left to
// turn it twice: stripped or kept, it looks as the original did.
func TestConvert_Orientation(t *testing.T) {
	needTools(t)
	c := testConverter()
	const w, h = 90, 60
	img := screenshot(w, h, false)
	img.Set(0, 0, color.NRGBA{255, 0, 0, 255}) // the top left, to see where it goes
	plain := encodePNG(t, img)
	// The eXIf chunk right after IHDR (8 bytes of signature, 25 of IHDR).
	src := append(append(append([]byte{}, plain[:33]...), pngChunk("eXIf", exifOrientation(6))...), plain[33:]...)
	// Turned 90° clockwise: the original's (x, y) goes to (h-1-y, x).
	turned := image.NewNRGBA(image.Rect(0, 0, h, w))
	for y := range h {
		for x := range w {
			turned.Set(h-1-y, x, img.At(x, y))
		}
	}
	want := encodePNG(t, turned)
	for _, format := range []string{FormatPNG, FormatWebP} {
		for _, strip := range []bool{true, false} {
			out, res, err := c.Convert(context.Background(), "photo.png", src, Options{Format: format, Strip: strip, OnlyIfSmaller: true})
			if err != nil || out == nil {
				t.Fatalf("%s strip %v: %+v %v", format, strip, res, err)
			}
			if res.Width != h || res.Height != w {
				t.Errorf("%s strip %v: %dx%d, want %dx%d", format, strip, res.Width, res.Height, h, w)
			}
			samePixels(t, want, out)
			f := filepath.Join(t.TempDir(), "out."+format)
			if err := os.WriteFile(f, out, 0o600); err != nil {
				t.Fatal(err)
			}
			// vipsheader fails for a field the image has not: no orientation.
			if o, err := exec.Command("vipsheader", "-f", "orientation", f).Output(); err == nil && strings.TrimSpace(string(o)) != "1" {
				t.Errorf("%s strip %v: orientation %q, want 1 or none", format, strip, o)
			}
		}
	}
	// Scaled down, vips thumbnail turns it.
	out, res, err := c.Convert(context.Background(), "photo.png", src, Options{Format: FormatPNG, MaxSide: 45})
	if err != nil || res.Width != 30 || res.Height != 45 {
		t.Fatalf("scaled: %+v %v", res, err)
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(out)); err != nil || cfg.Width != 30 || cfg.Height != 45 {
		t.Errorf("scaled to %dx%d: %v", cfg.Width, cfg.Height, err)
	}
}

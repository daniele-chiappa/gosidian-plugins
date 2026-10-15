# gosidian-images

A [gosidian](https://github.com/daniele-chiappa/gosidian) plugin that
converts images **without loss**, for the pipelines and the agents:

- **PNG optimized** with [oxipng](https://github.com/shssoichiro/oxipng)
  (`format: png`, the default): the same pixels in fewer bytes, a PNG any
  program reads;
- **WebP without loss** with cwebp (`format: webp`): about half of a PNG
  exported by a word processor;
- **TIFF** to PNG, as gosidian keeps no TIFF attachment;
- scaled down on request (`max_side`), with [libvips](https://www.libvips.org/);
- a photo turned as its EXIF orientation says, for good.

On 300 screenshots of a software manual, exported from Word as PNG (23.6
MB), WebP without loss weighed 49.2% (10 s on 8 CPUs) and the optimized
PNG 66.9% (19 s), every pixel the original's (`TestSample`, below).

## The node and the tool

`images.convert` (pipelines) and `images_convert` (agents) take the same
settings:

| Setting | |
|---|---|
| `files` | one image, or a list of up to 100: vault paths, or entries with a `path` as `in.list` gives them. gosidian hands them by reference |
| `format` | `png` (default), `webp`, or `keep`: optimized in its own format, a PNG with oxipng, the others as they are. An image of 16 bits a sample comes back a PNG also when WebP is asked: WebP holds 8 |
| `max_side` | scale the longer side down to this many pixels (this loses detail); 0, the default, keeps the size |
| `strip_metadata` | leave EXIF and other metadata out (default true) |
| `only_if_smaller` | keep the original when the result weighs as much or more (default true): a JPEG stays a JPEG |

The converted images come back as files, which gosidian stores as
attachments of the project. The output:

```json
{"results": [{"name": "001.png", "output": "001.png", "format": "png", "from_bytes": 86644, "to_bytes": 55012, "width": 1133, "height": 717, "kept": false}],
 "converted": 1, "kept": 0, "failed": 0, "bytes_before": 86644, "bytes_after": 55012}
```

An input it keeps has `kept: true` and a `reason` (an SVG, an animated
GIF, a JPEG that would weigh more), no file; one it cannot read, or will
not, has an `error`, and the others go on. A call whose files all fail is
an error. It will not convert, and the original stays as it is:

- an image larger than `IMAGES_MAX_PIXELS` (below), which the header says
  before any program decodes it: a PNG of a few kilobytes can say
  30000×30000, gigabytes once decoded;
- a TIFF of several pages: a PNG holds one, the others would be lost;
- samples of more than 16 bits (a TIFF of floats): a PNG holds 8 or 16;
- the files past `IMAGES_MAX_CALL_MIB` of a call: they fail, the others
  come back, and a call of their own converts them;
- HEIF, HEIC and AVIF (below, Not here).

**Nothing lost.** An image of 16 bits a sample (a scan, a PNG of a
scientific program) comes back a PNG, also for `format: webp`, as cwebp
would cut it to 8: its `reason` says so. A photo turned by its EXIF
orientation comes back turned for good, with no orientation left: the
pixels move and none is lost, and stripped of its metadata or not it
looks as it did, also where a PNG's orientation is not read. Scaled down
(`max_side`), an image loses detail, and has 8 bits a sample.

gosidian's `in.import` uses the node as each document's images arrive
(`convert: images.convert`), so the vault never keeps the heavier
original: see gosidian's `docs/pipelines.md`.

## Running it

```yaml
services:
  gosidian-images:
    image: ghcr.io/daniele-chiappa/gosidian-images:0.2.0
    read_only: true
    tmpfs: [/tmp]
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${IMAGES_TOKEN}
    mem_limit: 8g
```

`mem_limit` keeps a burst of large images inside the container: on an
image of 100 megapixels, the default `IMAGES_MAX_PIXELS`, cwebp held
about 2.8 GB and oxipng 1.3 GB, for each of `IMAGES_WORKERS` at once
(`/tmp` is memory too). Past the limit the kernel stops the largest
program of the container, and that image fails, rather than the host's
other services. On a small host lower `IMAGES_MAX_PIXELS` or
`IMAGES_WORKERS` with it.

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | — | the bearer gosidian sends; empty: anyone who reaches `/mcp` |
| `PORT` | 8000 | |
| `IMAGES_WORKERS` | the CPUs, at most 8 | images converted at once |
| `IMAGES_MAX_MIB` | 64 | the largest file it reads, in MiB |
| `IMAGES_MAX_PIXELS` | 100000000 | the largest image it decodes, width × height (100 megapixels): a larger one fails before any program reads its pixels |
| `IMAGES_MAX_CALL_MIB` | 64 | the files one call gives back, together, in MiB: they stay in memory, and twice more in the answer, until it is written. Those past it fail. gosidian stores at most its `[pipelines] max_plugin_files_bytes` (100 MiB by default) of the files of one answer |
| `IMAGES_MAX_FILES` | 100 | the files one call names; gosidian hands at most its `[pipelines] max_plugin_files` (100 by default): raise the two together |
| `IMAGES_PNG_LEVEL` | 2 | oxipng's `-o`, 1 to 6: on 300 screenshots, 2 made 66.9% of the weight in 19 s, 4 made 65.7% in 96 s |
| `IMAGES_WEBP_Z` | 6 | cwebp's `-z`, 1 to 9: 9 saved 2% more than 6 in thirteen times the time |
| `IMAGES_TIMEOUT` | 120 | seconds for one image |

Then register it in gosidian and accept its manifest, as for any plugin
(the repository's README), and for the agents expose it in a project:
`gosidian plugin expose images <project>`.

The images go through `/tmp` while they are converted, one folder each,
removed at once: the container runs read-only with a tmpfs there. The
image sets `VIPS_BLOCK_UNTRUSTED=1`: libvips refuses the loaders it marks
as not fuzzed for files from anyone (SVG, PPM, FITS, OpenEXR, JPEG 2000…),
none of which the plugin needs.

## Tests

```bash
sh scripts/test.sh
```

They run in `golang:1.27-alpine` with Alpine's libvips, oxipng and cwebp,
as the image has them, and check that a PNG or WebP it writes has every
pixel of the original: colour, transparency, grey, a palette and 16 bits,
and a photo turned by its orientation. A PNG that says 30000×30000 in a
few hundred bytes, a TIFF of three pages and a call past its
`IMAGES_MAX_CALL_MIB` fail as above.

A bench on a folder of real images, every pixel checked:

```bash
docker run --rm -v "$PWD:/src" -v /path/to/images:/sample:ro -w /src \
  -e IMAGES_SAMPLE_DIR=/sample -e IMAGES_SAMPLE_FORMAT=webp golang:1.27-alpine \
  sh -c 'apk add -q vips-tools libwebp-tools oxipng && go test -run TestSample -v .'
```

## Not here

- HEIF, HEIC and AVIF: Alpine's HEIF loader brings HEVC codecs, left out
  of the image. Such a file fails, and says so.
- Lossy formats (JPEG, lossy WebP, AVIF): this plugin never loses a pixel,
  but with `max_side`.

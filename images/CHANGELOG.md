# Changelog: gosidian-images

The changes of the `images` plugin, newest first. A tag
`images/vX.Y.Z` publishes `ghcr.io/daniele-chiappa/gosidian-images:X.Y.Z`,
and its release notes are its section here.

## [0.2.1] — 2026-10-29

Dependency updates; nothing changes for gosidian. The manifest is the
same but for the version.

### Changed
- mcp-go 1.2.1, golang.org/x/image 0.47.0.

## [0.2.0] — 2026-10-15

### Added
- `IMAGES_MAX_FILES` (100): the files one call names, which was a
  constant. gosidian hands at most its `[pipelines] max_plugin_files`:
  raise the two together.

## [0.1.0] — 2026-10-15

The first release. Needs gosidian 2.89 or later: its tool takes files of
the vault, which gosidian hands to a plugin's tools from 2.89 on.

### Added
- **`images.convert`**, a node of the pipelines, and the same conversion
  as the tool **`images_convert`** for the agents: one image or a list of
  up to 100, by reference, converted without loss to a **PNG optimized**
  with oxipng (`format: png`, the default) or to **WebP** with cwebp
  (`format: webp`), or optimized in their own format (`keep`). TIFF, which
  gosidian keeps not as an attachment, always becomes a PNG.
  `max_side` scales the longer side down, with libvips. An image that
  would not get lighter, a JPEG for one, is kept (`only_if_smaller`), and
  so are an SVG and an animated GIF; the result says which and why.
  Metadata are left out by default (`strip_metadata`).
- The converted images come back as files, which gosidian stores as
  attachments; `results` gives each input's output, size before and
  after, and width and height.
- **Nothing lost**: an image of 16 bits a sample comes back a PNG also
  when WebP is asked (cwebp would cut it to 8), and `reason` says so; a
  photo turned by its EXIF orientation comes back turned for good, with no
  orientation left, so it looks as it did with its metadata stripped or
  not. A TIFF of several pages (a PNG would keep the first), samples of
  more than 16 bits, and HEIF, HEIC and AVIF fail with the reason, and
  the original stays as it is.
- **Limits**, settings of the installer: `IMAGES_MAX_PIXELS` (100
  megapixels) refuses an image larger than it from its header, before any
  program decodes it, so a PNG of a few kilobytes that says 30000×30000
  cannot take gigabytes; `IMAGES_MAX_CALL_MIB` (64) caps the files one
  call gives back, and those past it fail, to be converted in another
  call; `IMAGES_MAX_MIB` (64) the file it reads. The README's compose has
  a `mem_limit`, and the image sets `VIPS_BLOCK_UNTRUSTED=1`, so libvips
  refuses the loaders it has not fuzzed.

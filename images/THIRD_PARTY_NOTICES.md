# Third-party notices: gosidian-images

gosidian-images is MIT-licensed (the `LICENSE` at the root of this
repository). Its image holds one binary, compiled from this folder with
the Go modules it links, and the programs it runs, from Alpine Linux's
packages, on an Alpine Linux base.

## In the binary

- **Go**, its standard library: BSD-3-Clause.
- **[mcp-go](https://github.com/mark3labs/mcp-go)**: MIT; and the few
  modules it brings (`google/uuid`, `spf13/cast`, `yosida95/uritemplate`,
  the JSON Schema libraries): BSD-3-Clause, MIT, Apache-2.0.

The image carries the license file of each module, as the build found it,
under `/licenses/go-modules/<module path>/`, and
`/licenses/go-modules/INDEX` lists them with their versions.
`scripts/licenses.sh` makes them at each build, and stops the build if a
module has no license file.

## The programs it runs

The binary runs these as separate programs; it links none of them. They
are Alpine's packages, unmodified, at the versions `/licenses/PROGRAMS`
names; their sources are in Alpine's
[aports](https://gitlab.alpinelinux.org/alpine/aports), and each package's
license is in its files under `/usr/share/licenses/` when the package
ships one.

- **[libvips](https://www.libvips.org/)** (`vips`, `vipsheader`), which
  reads the formats and scales down: LGPL-2.1-or-later. It loads, among
  others, **libimagequant** (GPL-3.0-or-later), libtiff, libpng,
  libjpeg-turbo, giflib, cgif, libwebp, librsvg, cairo, pango, glib
  (LGPL-2.1-or-later), and fftw (GPL-2.0-or-later).
- **[oxipng](https://github.com/shssoichiro/oxipng)**, which optimizes a
  PNG: MIT.
- **[cwebp](https://developers.google.com/speed/webp)** (libwebp-tools),
  which writes WebP: BSD-3-Clause.
- The Alpine base: musl (MIT), busybox (GPL-2.0-only), apk-tools
  (GPL-2.0-only), OpenSSL (Apache-2.0) and the libraries above.

HEIF and HEIC are not read: Alpine's HEIF loader brings HEVC codecs, left
out of this image.

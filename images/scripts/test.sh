#!/bin/sh
# test.sh [go test flags]: the plugin's tests with the programs of its image
# (libvips, oxipng, cwebp) from Alpine, set as the image sets them
# (VIPS_BLOCK_UNTRUSTED). GOCACHE_DIR and GOPATH_DIR keep Go's caches
# between runs; the files are handed back to the caller's uid.
set -eu
cd "$(dirname "$0")/.."
# The CPUs of the tests: the host's, at most 8 (a runner of GitHub has 4).
CPUS=$(nproc)
[ "$CPUS" -gt 8 ] && CPUS=8
CACHE=${GOCACHE_DIR:-}
GPATH=${GOPATH_DIR:-}
docker run --rm --cpus="$CPUS" -v "$PWD:/src" -w /src \
  ${CACHE:+-v "$CACHE:/cache" -e GOCACHE=/cache} ${GPATH:+-v "$GPATH:/gopath" -e GOPATH=/gopath} \
  -e IMAGES_REQUIRE_TOOLS=1 -e VIPS_BLOCK_UNTRUSTED=1 -e CGO_ENABLED=1 -e OWNER="$(id -u):$(id -g)" \
  golang:1.27-alpine sh -c "apk add -q gcc musl-dev vips-tools libwebp-tools oxipng >/dev/null &&
    go vet . && test -z \"\$(gofmt -l .)\" && go test -race -count=1 $* .; rc=\$?; chown -R \$OWNER /src ${CACHE:+/cache} ${GPATH:+/gopath}; exit \$rc"

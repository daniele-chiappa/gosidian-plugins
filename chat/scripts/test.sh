#!/bin/sh
# test.sh [go test flags]: the server's tests (vet, gofmt, race) and the
# widget's (tsc, node --test). GOCACHE_DIR and GOPATH_DIR keep Go's caches
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
  -e CGO_ENABLED=1 -e OWNER="$(id -u):$(id -g)" \
  golang:1.27-alpine sh -c "apk add -q gcc musl-dev >/dev/null &&
    go vet . && test -z \"\$(gofmt -l .)\" && go test -race -count=1 $* .; rc=\$?; chown -R \$OWNER /src ${CACHE:+/cache} ${GPATH:+/gopath}; exit \$rc"
docker run --rm --cpus="$CPUS" -v "$PWD/widget:/w" -w /w -e OWNER="$(id -u):$(id -g)" node:24-alpine sh -c \
  "npm ci --no-audit --no-fund >/dev/null && npm test; rc=\$?; chown -R \$OWNER /w; exit \$rc"

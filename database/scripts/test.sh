#!/bin/sh
# test.sh [go test flags]: the plugin's tests against the three stores in
# containers: pgvector 0.8.6 on PostgreSQL 18, Qdrant 1.19.1, and SQLite
# with sqlite-vec built for the run. GOCACHE_DIR and GOPATH_DIR keep Go's
# caches between runs; the files are handed back to the caller's uid.
set -eu
cd "$(dirname "$0")/.."
NET=gosidian-db-test-$$
docker network create "$NET" >/dev/null
docker run -d --rm --name "$NET-pg" --network "$NET" --cpus=1 -e POSTGRES_PASSWORD=test pgvector/pgvector:0.8.6-pg18-trixie >/dev/null
docker run -d --rm --name "$NET-qdrant" --network "$NET" --cpus=1 qdrant/qdrant:v1.19.1-unprivileged >/dev/null
trap 'docker stop "$NET-pg" "$NET-qdrant" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1' EXIT
timeout 60 sh -c "until docker exec $NET-pg pg_isready -q -U postgres; do sleep 1; done"
# The CPUs of the tests: the host's, at most 8 (a runner of GitHub has 4).
CPUS=$(nproc)
[ "$CPUS" -gt 8 ] && CPUS=8
CACHE=${GOCACHE_DIR:-}
GPATH=${GOPATH_DIR:-}
docker run --rm --network "$NET" --cpus="$CPUS" -v "$PWD:/src" -w /src \
  ${CACHE:+-v "$CACHE:/cache" -e GOCACHE=/cache} ${GPATH:+-v "$GPATH:/gopath" -e GOPATH=/gopath} \
  -e PG_URL="postgres://postgres:test@$NET-pg:5432/postgres" -e QDRANT_URL="http://$NET-qdrant:6333" \
  -e SQLITE_VEC=/tmp/vec/vec0 -e CGO_ENABLED=1 -e OWNER="$(id -u):$(id -g)" \
  golang:1.27-alpine sh -c "apk add -q gcc musl-dev sqlite-dev >/dev/null && sh scripts/sqlite-vec.sh /tmp/vec >/dev/null &&
    until wget -qO- http://$NET-qdrant:6333/healthz >/dev/null 2>&1; do sleep 1; done;
    go test -race -count=1 $* .; rc=\$?; chown -R \$OWNER /src ${CACHE:+/cache} ${GPATH:+/gopath}; exit \$rc"

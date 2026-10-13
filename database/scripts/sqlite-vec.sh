#!/bin/sh
# sqlite-vec.sh <dir>: sqlite-vec from its release's amalgamation, checked
# against its SHA-256 and built as a loadable extension, <dir>/vec0.so.
# Needs a C compiler and SQLite's headers (alpine: gcc musl-dev
# sqlite-dev; Debian and Ubuntu: gcc libsqlite3-dev).
set -eu
OUT=${1:?the folder of vec0.so}
VERSION=0.1.9
SHA256=3acd67cb4aff080c7050926fd3cf8227905fe5b7ee3829d8ee5024ab1283cf61
TMP=$(mktemp -d)
trap 'rm -r "$TMP"' EXIT
wget -qO "$TMP/sqlite-vec.tar.gz" "https://github.com/asg017/sqlite-vec/releases/download/v$VERSION/sqlite-vec-$VERSION-amalgamation.tar.gz"
echo "$SHA256  $TMP/sqlite-vec.tar.gz" | sha256sum -c -
tar xzf "$TMP/sqlite-vec.tar.gz" -C "$TMP"
mkdir -p "$OUT"
# sqlite-vec names u_int8_t and the like, which musl declares only for
# _GNU_SOURCE (glibc's sys/types.h has them anyway).
cc -O2 -fPIC -shared -D_GNU_SOURCE -include sys/types.h "$TMP/sqlite-vec.c" -o "$OUT/vec0.so" -lm
echo "sqlite-vec $VERSION: $OUT/vec0.so"

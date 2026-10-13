# Third-party notices: gosidian-database

gosidian-database is MIT-licensed (the `LICENSE` at the root of this
repository). Its image holds one binary, compiled from this folder with
the Go modules it links, sqlite-vec built as a loadable extension, on an
Alpine Linux base.

## In the binary

- **Go**, its standard library: BSD-3-Clause.
- **[pgx](https://github.com/jackc/pgx)** v5.11.0, PostgreSQL's driver:
  MIT.
- **[go-sqlite3](https://github.com/mattn/go-sqlite3)** v1.14.52: MIT. It
  compiles in **[SQLite](https://sqlite.org)**, which is in the public
  domain.
- **[mcp-go](https://github.com/mark3labs/mcp-go)** v1.1.1: MIT.
- **[go-yaml](https://github.com/yaml/go-yaml)** v3.0.5: MIT and
  Apache-2.0.
- A few more modules of these (puddle, the JSON Schema libraries, x/sync,
  x/text…), under MIT, Apache-2.0, BSD-2-Clause and BSD-3-Clause.

The image carries the license file of each module, as the build found it
in the module, under `/licenses/<module path>/`, and `/licenses/INDEX`
lists the modules with their versions. `scripts/licenses.sh` makes them
at each build, from the modules the binary links, and stops the build if
one has no license file.

## sqlite-vec

**[sqlite-vec](https://github.com/asg017/sqlite-vec)** 0.1.9, by Alex
Garcia: MIT or Apache-2.0, at the user's choice. The build takes the
amalgamation of its release, checks its SHA-256
(`scripts/sqlite-vec.sh`) and compiles it, unmodified, into
`/usr/local/lib/sqlite-vec/vec0.so`. Its two licenses are in
`/licenses/sqlite-vec/`.

## The base image

[Alpine Linux](https://alpinelinux.org) 3.24, unmodified: busybox,
apk-tools and alpine-baselayout (GPL-2.0), musl (MIT), OpenSSL
(Apache-2.0), zlib, and the CA certificates (MPL-2.0). `apk list -I` in
the image names each package with its license; their sources are
Alpine's ([aports](https://gitlab.alpinelinux.org/alpine/aports), the
3.24 branch).

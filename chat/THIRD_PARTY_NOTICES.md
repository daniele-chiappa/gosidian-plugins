# Third-party notices: gosidian-chat

gosidian-chat is MIT-licensed (the `LICENSE` at the root of this
repository). Its image holds one binary, compiled from this folder with
the Go modules it links, the widget `chat.js`, compiled from
`widget/src/chat.ts`, and an Alpine Linux base.

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

## The widget

`chat.js` is this repository's own code. TypeScript (Apache-2.0) compiles
it at build time and is not in the image.

## The base

The Alpine base: musl (MIT), busybox (GPL-2.0-only), apk-tools
(GPL-2.0-only), OpenSSL (Apache-2.0), at the versions `/licenses/PROGRAMS`
names; their sources are in Alpine's
[aports](https://gitlab.alpinelinux.org/alpine/aports).

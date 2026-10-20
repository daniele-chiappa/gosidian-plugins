# Third-party notices: gosidian-exec

The plugin's own code (`src/`, the Dockerfile) is MIT-licensed (the
`LICENSE` at the root of this repository). Its image holds the works of
others, unmodified, under their own licenses. The steps run them as
separate programs: the plugin starts them, and links none of them.

## Node packages

The [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
(MIT), ajv (MIT), yaml (ISC), zod (MIT), and the packages they need: 93
in all, as `package-lock.json` pins them.
- MIT: 82;
- ISC: 8;
- BSD-3-Clause: 2;
- BSD-2-Clause: 1.

Each package's license, as it ships it, is in its folder under
`/app/node_modules`.

## Go

The [Go](https://go.dev) toolchain and standard library, copied as they are
from the official image `golang:1.27-alpine` into `/usr/local/go`:
BSD-3-Clause, with the patent grant of its `PATENTS`. Both texts are in
`/usr/local/go`.

## The base image

[`node:24-alpine`](https://hub.docker.com/_/node): Node.js (MIT, with the
licenses of what it bundles in `/usr/local/include/node` and its `LICENSE`),
and npm (Artistic-2.0), on Alpine Linux. The plugin adds these Alpine
packages, unmodified, with what they need:

| Package | What for | License |
|---|---|---|
| python3, py3-pip | Python and pip for the steps | PSF-2.0; pip MIT |
| git | the repositories, the server's and the steps' | GPL-2.0-only |
| build-base: gcc, g++, binutils, make, musl-dev, fortify-headers | a C and C++ compiler for the steps | GPL-2.0-or-later and LGPL-2.1-or-later (gcc, binutils), GPL-3.0-or-later (make), MIT (musl, build-base), 0BSD (fortify-headers) |
| bash | the steps' shell | GPL-3.0-or-later |
| openssh-client | ssh to the hosts of the preset | BSD |
| tar (GNU tar) | a step's files to and from a host | GPL-3.0-or-later |
| tini | PID 1 | MIT |

git, GNU tar, bash, make and gcc are separate programs the plugin runs; it
links none of them. `apk list -I` in the image names each package with its
license; their sources are Alpine's
([aports](https://gitlab.alpinelinux.org/alpine/aports)), and Alpine's
packages of the GPL'd programs name the sources they are built from.

## What the steps fetch

The image ships no dependencies of the projects it builds. What a step's
script downloads (npm, Go modules, pip) comes from the registries the
preset's network reaches, under each package's own license, on behalf of
whoever writes the pipeline.

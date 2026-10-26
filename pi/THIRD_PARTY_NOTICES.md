# Third-party notices: gosidian-pi

The plugin's own code (`src/`, the Dockerfile) is MIT-licensed (the
`LICENSE` at the root of this repository). Its image holds the works of
others, unmodified, under their own licenses.

## Node packages

[pi](https://pi.dev) (`@earendil-works/pi-coding-agent` 1.1.0, MIT, by
Earendil Inc. and contributors), the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
(MIT), ajv (MIT), yaml (ISC), zod (MIT), and the packages they need: 234
in all, as `package-lock.json` pins them.
- MIT: 165;
- Apache-2.0: 36;
- BSD-3-Clause: 15;
- ISC: 13;
- BlueOak-1.0.0: 2;
- BSD-2-Clause: 1;
- 0BSD: 1;
- Unlicense: 1 (`fast-sha256`).

Each package's license, as it ships it, is in its folder under
`/app/node_modules`.

## The base image

[`node:24-alpine`](https://hub.docker.com/_/node): Node.js (MIT, with the
licenses of what it bundles in `/usr/local/include/node` and its `LICENSE`),
on Alpine Linux. The plugin adds the Alpine packages ripgrep (MIT or
Unlicense), fd (MIT or Apache-2.0) and bash (GPL-3.0), unmodified.
`apk list -I` in the image names each package with its license; their
sources are Alpine's ([aports](https://gitlab.alpinelinux.org/alpine/aports)).

## What the agent talks to

The models are not in the image: the preset names an endpoint (a local
server, OpenRouter, …), and whoever configures it chooses the models and
their terms.

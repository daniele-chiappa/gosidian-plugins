# Third-party notices: gosidian-preview

The plugin's own code (`src/`, the Dockerfile) is MIT-licensed (the
`LICENSE` at the root of this repository). Its image holds the works of
others, unmodified, under their own licenses.

## Node packages

The [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
(MIT), ajv (MIT), yaml (ISC), zod (MIT), [yauzl](https://github.com/thejoshwolfe/yauzl)
(MIT), [playwright-core](https://github.com/microsoft/playwright)
(Apache-2.0), and the packages they need: 98 in all, as
`package-lock.json` pins them.
- MIT: 86;
- ISC: 8;
- BSD-3-Clause: 2;
- BSD-2-Clause: 1;
- Apache-2.0: 1 (playwright-core, with its `NOTICE` and the notices of
  what it bundles, `ThirdPartyNotices.txt`).

Each package's license, as it ships it, is in its folder under
`/app/node_modules`. playwright-core is the client only: the image holds
no browser, and the plugin drives a Playwright server run apart.

## The base image

[`node:24-alpine`](https://hub.docker.com/_/node): Node.js (MIT, with the
licenses of what it bundles in `/usr/local/include/node` and its `LICENSE`),
and npm (Artistic-2.0), on Alpine Linux. The plugin adds one Alpine
package, unmodified:

| Package | What for | License |
|---|---|---|
| tini | PID 1 | MIT |

`apk list -I` in the image names each package with its license; their
sources are Alpine's ([aports](https://gitlab.alpinelinux.org/alpine/aports)).

## What it serves

The previews are the zips a pipeline hands the plugin: their files, under
their own licenses, served on behalf of whoever runs the pipeline.

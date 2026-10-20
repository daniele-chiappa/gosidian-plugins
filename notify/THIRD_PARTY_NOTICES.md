# Third-party notices: gosidian-notify

The plugin's own code (`src/`, the Dockerfile) is MIT-licensed (the
`LICENSE` at the root of this repository). Its image holds the works of
others, unmodified, under their own licenses.

## Node packages

The [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
(MIT), ajv (MIT), yaml (ISC), zod (MIT),
[nodemailer](https://nodemailer.com) (MIT-0), and the packages they need:
96 in all, as `package-lock.json` pins them.
- MIT: 84;
- ISC: 8;
- BSD-3-Clause: 2;
- BSD-2-Clause: 1;
- MIT-0: 1 (nodemailer).

Each package's license, as it ships it, is in its folder under
`/app/node_modules`. The Telegram Bot API and ntfy are called over plain
HTTP(S) with Node's own `fetch`: no SDK of theirs is in the image.

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

## What it sends

The messages are the texts a pipeline hands the plugin, sent on behalf of
whoever runs the pipeline, to the people and rooms of its preset.

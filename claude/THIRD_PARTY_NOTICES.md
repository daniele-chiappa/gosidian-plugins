# Third-party notices: gosidian-claude

The plugin's own code (`src/`, the Dockerfile) is MIT-licensed (the
`LICENSE` at the root of this repository). Its image holds the works of
others, unmodified, under their own licenses.

## Claude Code is not in the image

[Claude Code](https://github.com/anthropics/claude-code)
(`@anthropic-ai/claude-code`) is Anthropic's, under its own terms: "© Anthropic
PBC. All rights reserved. Use is subject to the Legal Agreements outlined
here: https://code.claude.com/docs/en/legal-and-compliance". The image does
not ship it. The plugin installs it at runtime from the npm registry into its
volume (`/var/lib/gosidian-claude`), on behalf of whoever runs the
container, who accepts those terms by using it. Each installed version keeps
its `LICENSE.md` and `README.md` in
`/var/lib/gosidian-claude/versions/<version>/node_modules/@anthropic-ai/`.

## Node packages

The [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
(MIT), ajv (MIT), yaml (ISC), zod (MIT), and the packages they need: 95
in all, as `package-lock.json` pins them.
- MIT: 84;
- ISC: 8;
- BSD-3-Clause: 2;
- BSD-2-Clause: 1.

Each package's license, as it ships it, is in its folder under
`/app/node_modules`.

## The base image

[`node:24-alpine`](https://hub.docker.com/_/node): Node.js (MIT, with the
licenses of what it bundles in `/usr/local/include/node` and its `LICENSE`),
and npm (Artistic-2.0), which the plugin uses to install Claude Code, on
Alpine Linux. The plugin adds the Alpine packages bash (GPL-3.0) and tini
(MIT), unmodified. `apk list -I` in the image names each package with its
license; their sources are Alpine's
([aports](https://gitlab.alpinelinux.org/alpine/aports)).

## What the agent talks to

The models are not in the image: Claude Code calls Anthropic's API through
the plugin's proxy, with the credentials of whoever configures the preset
(a subscription's token or an API key), under Anthropic's terms for them.

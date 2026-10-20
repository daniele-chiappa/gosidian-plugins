# Changelog: gosidian-pi

The changes of the `pi` plugin, newest first. A tag `pi/vX.Y.Z` publishes
`ghcr.io/daniele-chiappa/gosidian-pi:X.Y.Z`, and its release notes are its
section here.

## [0.2.1] — 2026-10-20

A fix: a step's limits and the call's cancellation stop pi at once.
Nothing else changes for gosidian; the manifest is the same but for the
version.

### Fixed
- **A step's limits and the call's cancellation stop pi**: `max_seconds`,
  `max_turns`, `max_tokens`, `max_cost` and a canceled call sent their
  signal from the server, root without `CAP_KILL`, which may not signal
  the slot's user: the signal failed, and pi ran on until it ended by
  itself; only the end of the step stopped what was left. The server now
  sends it as the slot's user (agent-kit's `signal.ts`), so pi stops at
  the limit. A call canceled between two runs of pi (a retry for the
  JSON) stops the second at once. The separation test runs a step whose
  bash sleeps past its `max_seconds`.

## [0.2.0] — 2026-10-20

The run node keeps gosidian's common contract of the agents, `agent-run/1`:
the settings and output of [claude](../claude) too, so a pipeline picks an
executor without learning it. A step may work on a repository of the
preset, and use gosidian's MCP with a token of the call. A preset of 0.1
works as it is; the run's output changes in one field (below).

### Added
- **The contract `agent-run/1`** (the node `run` declares it): the setting
  `effort`, pi's thinking level by the contract's name, and `access`
  (`read`: read, grep, find, ls; `edit`: also edit, write; `exec`: also
  bash; the tools of the level the preset allows, which `tools` narrows; a
  level whose own tools the preset allows none of fails the node, naming
  them); the output's `cost` (pi's sum at the preset's prices) and
  `cost_source` (`agent`, or `none` for a model without prices), and
  `executor` (the plugin and pi, with their versions). A preset names its
  default level `effort` too.
- **Repositories**: a preset's `repos`, the closed list a step may work
  on (URL, deploy key and pinned host keys over SSH, base branch, the
  prefix of the steps' branches, the protected ones, the author, the
  limits, pull requests on Gitea), and the node's `repo` (`name`, `base`,
  `branch`, `push`, `pr`). The server clones the repository into `repo/`
  on a branch of the step's own (`agent/<run>-<step>`), the agent edits its
  files, and when the step ends well the server commits what changed (the
  preset and the task's first line, the answer, gosidian's project and
  run), pushes the branch and opens the pull request; the output's `repo`
  says what. The agent reads neither the deploy key nor anything it could
  push with, and cannot write the git folder, move `repo/`, commit or
  push; a hard link, a file that is not a plain one, or more files or bytes
  than the preset allows commit nothing, and a step that fails commits
  nothing. The manifest lists the repositories' hosts in
  `permissions.network`. The image has git and openssh-client.
- **gosidian's MCP**: a preset's `mcp` (`read`, `write`) makes the node
  `mcp: true` and asks for `permissions.mcp`; the node's `mcp` (`none`,
  `read`, `write`) has pi reach gosidian's MCP over streamable HTTP with
  the token gosidian hands for the call (`gosidian/mcp_url`,
  `gosidian/mcp_token` in its `_meta`). pi loads its built-in MCP
  extension alone, with gosidian's tools declared as its own
  (`mcp__gosidian__<tool>`) and no codemode. The token is only in pi's
  environment, which `mcp.json` names, never in its arguments or a file;
  the plugin checks that gosidian takes it before pi starts. The output's
  `mcp` gives the level and the endpoint.
- `scripts/test.sh`: the type check and the tests in a throwaway
  node:24-alpine, with git. The separation test also runs a step with
  gosidian's MCP and two on a repository, on a git server over SSH.

### Changed
- **The run's `model` is an object**, `{name, id, endpoint}`: it was the
  model's name, a string, which is now `model.name`; `endpoint` is the
  host of the preset's endpoint.
- pi's folder for a step is sticky, and its files (the model, the
  settings, gosidian's MCP) are the server's: the agent cannot change
  them, which a JSON retry would read again. The working folder is sticky
  too.

### Deprecated
- `thinking`, in the node's settings and in the preset: it is `effort`
  now, and still read in 0.2.
- `usage.cost` in the run's output: it is `cost` now, and still given in
  0.2.

## [0.1.2] — 2026-10-17

Dependency updates; nothing changes for gosidian. The manifest is the same
but for the version.

### Changed
- @modelcontextprotocol/sdk 1.32.0.
- @types/node 24.19.1: Node's types stay on the image's Node, 24, and
  Dependabot leaves their majors alone.

## [0.1.1] — 2026-10-12

The first public release: 0.1.0 with the MCP SDK's fix. Needs gosidian
2.81 or later, and 2.85 for a list of files and the run's token budget.

### Security
- **@modelcontextprotocol/sdk** to 1.31.0
  ([GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h):
  the SDK's OAuth client could send credentials to an authorization server
  an MCP server chose). The plugin uses the SDK as a server, without OAuth,
  and runs pi without MCP; it should not ship it anyway.

## [0.1.0] — 2026-10-12

A pi agent (pi.dev 1.0.4) as a node of gosidian's pipelines; not
published.

### Added
- **The run node**: a prompt, a system prompt (added or in place of pi's),
  a model of the preset, the thinking level, the temperature, the files of
  the project (by reference, a list too), the tools within the preset's;
  the answer as text or JSON, the files the agent writes in `out/` given
  back as attachments, the usage and cost.
- **One container, one agent**: a preset names the endpoint (any
  OpenAI-compatible API) and its key, the models with their prices,
  sampling and request body, the tools it may use, and the limits of a
  step. Two examples: `pi-locale` (llama.cpp, Qwen3.8-27B at 3 bits) and
  `pi-openrouter`.
- **Limits**: turns, seconds, tokens (and the run's `max_llm_tokens`),
  dollars; pi is stopped at the first one reached.
- **JSON answers**: checked against a JSON Schema, with turns that ask the
  agent to fix them.
- **`inline_files`**: the text files in the prompt too, for a model that
  does not read them with its tools.
- **Security**: the endpoint's key stays in a proxy of the plugin; pi runs
  as another user, who reads neither the key nor the server's
  environment; the processes a step leaves are stopped; only regular files
  come back. `scripts/separation-test.sh` checks it on the image.

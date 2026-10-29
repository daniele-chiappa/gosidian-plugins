# Changelog: gosidian-pi

The changes of the `pi` plugin, newest first. A tag `pi/vX.Y.Z` publishes
`ghcr.io/daniele-chiappa/gosidian-pi:X.Y.Z`, and its release notes are its
section here.

## [0.3.4] — 2026-10-29

undici 8.12.2 for three advisories; nothing changes for gosidian. The
manifest is the same but for the version.

### Security
- **undici** 8.10.2 → 8.12.2, which pi installs as the process's `fetch`:
  its calls to the model endpoint go through it.
  [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)
  (high: an answer with too many content encodings stopped the process),
  [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685)
  (medium: the EventSource parser's memory) and
  [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472)
  (medium: Subresource Integrity). pi 1.1.0 pins undici 8.10.2, so the
  plugin's `package.json` overrides it.

## [0.3.3] — 2026-10-26

pi 1.1.0, and dependency updates for an advisory; nothing changes for
gosidian. The manifest is the same but for the version.

### Security
- **zod** 4.6.5 → 4.6.6 ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
  high), through which the MCP SDK checks the tools' arguments.

### Changed
- **pi** (`@earendil-works/pi-coding-agent`) 1.0.4 → 1.1.0, alone: none
  of the packages it needs changes. In gosidian's lab a step with files
  and a JSON answer on a local model, and a step that reads and writes
  notes through gosidian's MCP, work as with 1.0.4; the image passes the
  separation test.
- @modelcontextprotocol/sdk 1.32.1, @types/node 24.19.2.

## [0.3.2] — 2026-10-25

From gosidian's fitness pilot, second run (2026-10-25).

### Changed
- **The workspace says where the vault's notes go**: a step that writes
  no file but has gosidian's MCP in writing is told that the notes the
  task asks for go into the vault with its tools (`memory_create`,
  `memory_update`, `memory_edit`), in a section `## gosidian`; with the
  MCP in reading, that it cannot change them. Before, nothing said so.

### Fixed
- **A step that fails after the agent ran says what it spent**: the
  error's structured content holds its `usage` (with `total_tokens`) and,
  when known, its `cost`, so gosidian (2.117.0 and later) counts it in the
  task and in the team's budget. A step stopped at `max_tokens` used to
  cost nothing there; in the pilot two such steps spent 6.2 M tokens.

## [0.3.1] — 2026-10-25

The step's tokens: `max_tokens` counts the four kinds together, cache reads
included, and an agent that reads long notes for 40 turns spends a few
millions. In gosidian's fitness pilot the agents that read the WHO
guidelines stopped at 300,000 in seven turns.

### Changed
- **The limits' token defaults**: 3,000,000 a step (was 300,000) and at
  most 6,000,000 (was 2,000,000). A preset that sets them keeps its own;
  `max_cost` stays the step's real bound.

## [0.3.0] — 2026-10-24

For gosidian's teams of agents: the run says which files a step changed,
and a new node, `pr`, merges or closes the pull request a step opened. A
preset of 0.2 works as it is; the manifest gains `pr` for a preset whose
repositories have pull requests, and the run's `repo` the field `files`.

### Added
- **The node `pr`** (a preset with a repository that has `pr`): merges
  (`action: merge`; `style` `merge`, `rebase` or `squash`, Gitea's `Do`;
  `title` and `message` of the merge commit) or closes (`action: close`)
  a pull request of a repository of the preset, named by its `number` or
  its `url` (the run's `repo.pr_url`), with the preset's token, then
  deletes its branch (`delete_branch`, true by default). Only a pull
  request a step opened: of the repository itself (the URL of another
  fails) and from a branch under the preset's prefix, checked before
  anything changes; a protected branch is never deleted. A merge or a
  close done already is no error, so a retry finds the pull request as it
  is. Gitea's refusals (405, not mergeable; 409, a conflict) fail the node
  with their status. Output: `repo`, `number`, `url`, `action`, `branch`,
  `merged`, `closed`, `sha` (the merge commit), `branch_deleted`, `note`.
  The node needs no files and no MCP, and the manifest's
  `permissions.network` already lists the pull requests' API.
- **The files a step changed**: the run's `repo.files`, the paths in the
  repository of the files the commit added, modified or deleted (a
  renamed file as its old path and its new one), sorted; empty when
  nothing changed. `changed` stays their count.

### Changed
- A pull request that cannot reach Gitea (the network, the time limit)
  fails the step with that reason, after the repository's name, instead
  of an internal error.

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

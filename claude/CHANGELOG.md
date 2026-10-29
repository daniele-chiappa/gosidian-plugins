# Changelog: gosidian-claude

The changes of the `claude` plugin, newest first. A tag `claude/vX.Y.Z`
publishes `ghcr.io/daniele-chiappa/gosidian-claude:X.Y.Z`, and its release
notes are its section here.

## [0.3.3] — 2026-10-29

Dependency updates for two advisories; nothing changes for gosidian. The
manifest is the same but for the version.

### Security
- **zod** 4.6.5 → 4.6.6 ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
  high), through which the MCP SDK checks the tools' arguments.
- **ip-address** 10.7.3 → 10.7.4 ([GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)),
  which the MCP SDK's express brings; the plugin's server, on `node:http`,
  does not use it.

### Changed
- @modelcontextprotocol/sdk 1.32.1, @types/node 24.19.2.

## [0.3.2] — 2026-10-25

From gosidian's fitness pilot, second run (2026-10-25).

### Changed
- **The workspace says where the vault's notes go**: a step that writes
  no file but has gosidian's MCP in writing is told that the notes the
  task asks for go into the vault with its tools (`memory_create`,
  `memory_update`, `memory_edit`), in a section `## gosidian`; with the
  MCP in reading, that it cannot change them. Before, the plugin said
  only «You cannot write files in this task: answer with text.», and an
  agent put its notes in its answer instead of the vault.

### Fixed
- **A step that fails after the agent ran says what it spent**: the
  error's structured content holds its `usage` (with `total_tokens`) and,
  when known, its `cost`, so gosidian (2.117.0 and later) counts it in the
  task and in the team's budget. A step stopped at `max_tokens` used to
  cost nothing there; in the pilot two such steps spent 6.2 M tokens. On
  Anthropic's endpoints a step stopped before Claude Code gave its result
  has no cost: its tokens count.

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

A fix: a step's limits and the call's cancellation stop Claude Code at
once. Nothing else changes for gosidian; the manifest is the same but for
the version.

### Fixed
- **A step's limits and the call's cancellation stop Claude Code**:
  `max_seconds`, `max_turns`, `max_tokens`, `max_cost` and a canceled call
  sent their signal from the server, root without `CAP_KILL`, which may
  not signal the slot's user: the signal failed, and Claude Code ran on
  until it ended by itself; only the end of the step stopped what was
  left. The server now sends it as the slot's user (agent-kit's
  `signal.ts`), so Claude Code stops at the limit. The check of a new
  version, run as nobody, is stopped at its time limit the same way. The
  separation test runs a step past its `max_seconds`.

## [0.2.0] — 2026-10-20

The run node keeps gosidian's common contract of the agents, `agent-run/1`,
and Claude Code runs on other endpoints than Anthropic's: OpenRouter,
Ollama, vLLM, any that speaks the Messages API, with no gateway in
between. A step may work on a repository of the preset, which the plugin
clones and commits, and use gosidian's MCP. A preset of 0.1 works as it
is; the run's output changes in two fields (below).

### Added
- **Endpoints**: a preset's `endpoints`, by name, each with its `url`, its
  `auth` (`oauth`, `api_key`, `bearer` or `none`), its key (`key_file` or
  `key_env`) and `headers` of its own (OpenRouter's `HTTP-Referer` and
  `X-Title`). The proxy sends a step's requests to the endpoint of its
  model, with that endpoint's credential; to an endpoint other than
  Anthropic's it sends the step's model in every message (a background
  task's too), drops the effort of a model that takes none, and answers
  the token count (404: Claude Code estimates) and the list of models
  itself. The manifest's `permissions.network` lists every endpoint's
  host.
- **Models of their own**: a model of the preset may be an object, `name`,
  `endpoint`, `id` (the endpoint's), `context`, `max_output`, `cost`
  (dollars per million tokens) and `effort`. On a compatible endpoint
  Claude Code runs on the model's name, with `ANTHROPIC_DEFAULT_OPUS_MODEL`,
  `…_SONNET_MODEL` and `…_HAIKU_MODEL` pinned to it,
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, and
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from
  the model; without `--max-budget-usd`, since Claude Code knows no price
  of the endpoint's models: the plugin keeps `max_cost` at the preset's
  prices. Example presets for OpenRouter and Ollama.
- **The contract `agent-run/1`** (the node `run` declares it): the settings
  `system_mode` (`append`, or `replace`: `--system-prompt-file`), `access`
  (`read`, `edit`, `exec`: the tools of each level the preset allows; a
  level the preset cannot give fails the node, naming the tools),
  `max_tokens` (the step's, under the run's tokens left; 300,000 by
  default, 2,000,000 at most) and `max_cost`; the output's `stop` (`done`,
  or `length` when the answer was cut), `cost_source` (`agent`, `prices`
  or `none`), `executor` (the plugin and Claude Code, with their versions)
  and `allowed_tools`.
- The steps that `usage` gives name their `endpoint`; `version` says
  `probe_skipped` for a preset without an Anthropic endpoint, which has no
  alias to probe.
- **Repositories**: a preset's `repos`, the closed list a step may work on
  (URL, deploy key and pinned host keys for SSH, base branch, the prefix of
  the steps' branches, the protected ones, the author, the limits, pull
  requests on Gitea), and the run's `repo` (`name`, `base`, `branch`,
  `push`, `pr`). The server clones the repository into the step's `repo/`
  on a branch of its own (`<prefix><run>-<step>`), Claude Code edits the
  files, and after a step that succeeded the server commits what changed,
  pushes the branch and opens the pull request; the output's `repo` says
  the branch, the commit and what changed, and so do the steps of `usage`.
  The agent never holds the credentials: the git folder lies outside
  `repo/`, readable and not writable, `work/` is sticky, git runs without
  hooks or configuration of anyone's, and a hard link, a file that is not
  a plain one or more than the preset's limits commit nothing. The system
  prompt says where the repository is, and that the agent does not commit.
  The manifest's `permissions.network` gains the repositories' hosts.
- **gosidian's MCP**: a preset's `mcp`, the levels a step may ask for
  (`read`, `write`), and the run's `mcp`. The manifest's run node says
  `"mcp": true` and `permissions.mcp` lists the levels; a step with `read`
  or `write` gives Claude Code gosidian's MCP server at the endpoint of the
  call's `_meta`, with its token, and approves its tools
  (`mcp__gosidian__*`). The token is in Claude Code's environment only
  (`GOSIDIAN_MCP_TOKEN`, which `--mcp-config` names), never in its
  arguments; the output's `mcp` gives the level, the endpoint and the
  server's state. A call without the token fails, with why.
- The image has `git` and `openssh-client`, for the repositories.

### Changed
- **The run's `model` is an object**, `{name, id, endpoint}`: it was the
  resolved model's id, a string, which is now `model.id`.
- **The run's `tools` counts the calls of each tool** (`{"Read": 3}`), as
  the contract has it: the list of the tools Claude Code had is now
  `allowed_tools`.
- `cost` on a compatible endpoint is the tokens the proxy counted at the
  model's prices (0 without them), not Claude Code's estimate.
- `subscription` is in a step's output only when its model is on the
  subscription's endpoint, and `limits.min_left_percent` holds only those
  steps; a preset needs an `oauth` endpoint for it (at most one).
- A preset's `credentials` and `upstream` are the endpoint `anthropic`;
  `endpoints` replaces them (a preset has one or the other).

### Deprecated
- `max_budget_usd`, in the preset's limits and in the run's settings: it is
  `max_cost` now, and still read in 0.2.

## [0.1.1] — 2026-10-17

Dependency updates; nothing changes for gosidian. The manifest is the same
but for the version.

### Changed
- @modelcontextprotocol/sdk 1.32.0.
- @types/node 24.19.1: Node's types stay on the image's Node, 24, and
  Dependabot leaves their majors alone.

## [0.1.0] — 2026-10-17

The first version: Claude Code as a node of gosidian's pipelines. Needs
gosidian 2.85 or later (a list of files, the run's token budget), 2.89 for
the nodes as tools of the agents with files, and 2.94 for a node whose
files are optional and for a dashboard's pipeline every hour.

### Added
- **The run node**: Claude Code headless (`claude -p`, checked on 2.1.301)
  on a prompt, a system prompt added to its own, a model of the preset (an
  alias, which the installed version resolves, or a model's id), an effort
  level, the files of the project (by reference, a list too) and the tools
  within the preset's; the answer as text, as JSON or as the structured
  output of a JSON Schema (`--json-schema`); the files the agent writes in
  `out/` given back as attachments; the model the alias resolved to, the
  effort the requests carried (and a note when the model takes none), the
  turns, the usage, the cost, the denied tool calls, and the
  subscription's limits after the step.
- **Claude Code installed at runtime, not shipped**: the image holds no
  Claude Code (its license is not open). The plugin installs it from the npm
  registry into its volume at the first start (the newest, or the preset's
  version), runs the platform's native binary without npm's install
  scripts, and keeps the auto-updater off.
- **The version and update nodes**, for an update that someone approves:
  `version` says the version in use, the newest on npm, the models its
  aliases resolve to and the API's models with their effort levels;
  `update` installs a version aside, probes each alias with a prompt of
  two words, and with `switch` puts it in use once the running steps end
  (a version that fails its probe is not). With `switch: false` a pipeline
  prepares the update, puts it in use when the aliases keep their models,
  and otherwise writes a request with the new aliases. A version in use
  whose probe failed is probed again at the start, and before an update
  compares its aliases with the new ones.
- **The usage node**: the subscription's session (5 hours) and week, used
  and left in percent, and when each resets, from the API's
  `anthropic-ratelimit-unified-*` headers. `limits.min_left_percent` keeps
  a step from starting when less is left. It gives the last steps too
  (`steps`, `since`), each with its project and run, model, effort, turns,
  tokens, cost and error, kept in the volume across restarts
  (`CLAUDE_KEEP_STEPS`): a dashboard's pipeline reads them.
- **Limits**: turns and dollars (Claude Code's own), seconds, the run's
  `max_llm_tokens`, and a cancel by gosidian; Claude Code is stopped, with
  every process of its user.
- **Security**: the subscription's token or the API key stays in a proxy
  of the plugin, which forwards only messages and the list of models;
  Claude Code runs as another user, with an environment of ten variables,
  its file tools confined to the step's folder, no settings, hooks, skills
  or MCP servers of any file, no session kept; only regular files come
  back. `scripts/separation-test.sh` checks it on the image, and
  `scripts/smoke-test.sh` tries the real Claude Code and API.
- **Each node a tool of the agents**, with its access: `run` and `update`
  write, `version` and `usage` read.

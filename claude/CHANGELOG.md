# Changelog: gosidian-claude

The changes of the `claude` plugin, newest first. A tag `claude/vX.Y.Z`
publishes `ghcr.io/daniele-chiappa/gosidian-claude:X.Y.Z`, and its release
notes are its section here.

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

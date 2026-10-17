# Changelog: gosidian-claude

The changes of the `claude` plugin, newest first. A tag `claude/vX.Y.Z`
publishes `ghcr.io/daniele-chiappa/gosidian-claude:X.Y.Z`, and its release
notes are its section here.

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

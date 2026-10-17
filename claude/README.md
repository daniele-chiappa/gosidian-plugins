# gosidian-claude

A gosidian plugin whose node runs [Claude Code](https://code.claude.com)
headless: an agent that works in several turns with its tools (Read, Grep,
Glob; Write, Edit or Bash when its preset allows them) on the files a
pipeline hands it, and answers with text or JSON, giving back the files it
writes. Two more nodes keep its version: `version` says whether a newer one
is out and what its aliases resolve to, `update` installs one aside, tries
it and puts it in use. A fourth, `usage`, says how much of the
subscription's session and week is left.

**Claude Code is not in the image**: its license is not open ("© Anthropic
PBC. All rights reserved"). At the first start the plugin installs it from
the npm registry into its volume, the newest version unless the preset
names one, and from then on only when the `update` node asks. The
auto-updater is off (`DISABLE_AUTOUPDATER=1`).

**One container is one agent.** Its preset names the credentials (a
subscription's token or an API key), the models and effort levels a node
may pick, the tools the agent may use and the limits of a step. The node
decides the rest: the prompt, the system prompt, the model, the effort, the
files, the tools within the preset's, the limits within the preset's, and
the JSON the answer must be.

## A step

1. gosidian calls `run` with the node's settings. Each file the node names
   comes by reference (`file_refs`), a list of them too. The tokens the run
   may still spend come in the call's `_meta`.
2. With `limits.min_left_percent`, the plugin first checks the
   subscription: a session or week with less left fails the node, with the
   time it resets.
3. The plugin makes a folder for the step: the files are fetched into
   `in/`, checked against their size and SHA-256; `out/` is empty.
4. It runs `claude -p` there, the prompt on its standard input, as the
   user of the step's slot, with an environment of its own (below), and
   follows its events (`--output-format stream-json`). It stops it at
   `max_seconds`, when the run's tokens are spent, or when gosidian cancels
   the call; Claude Code itself stops at `max_turns` and `max_budget_usd`.
5. The result decides: anything but `success` fails the node with the
   reason (`error_max_turns`, `error_max_budget_usd`, an error of the
   API…). With `schema`, the answer is Claude Code's structured output,
   checked again against the schema; with `json`, the text read as JSON.
6. The files the agent wrote in `out/` go back to gosidian, which stores
   them as attachments; the folder is removed, and every process of the
   slot's user is stopped.

What Claude Code runs with (checked on 2.1.301):

```
claude -p --output-format stream-json --verbose
  --model <model> [--effort <effort>] --max-turns <n> --max-budget-usd <usd>
  --tools <tools> --allowedTools <tools>
  --permission-mode dontAsk --permission-prompts none --restricted
  --setting-sources "" --settings '{"disableAllHooks":true}'
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --disable-slash-commands --no-session-persistence
  --append-system-prompt-file <step>/system.md [--json-schema <schema>]
```

- Only the node's tools exist (`--tools`), and only they are approved
  (`--allowedTools`): anything else that would ask is denied
  (`dontAsk`), and the denials come back in the output.
- `--restricted` confines the file tools to the step's folder, removes the
  tools that run code unless `--tools` names them, and ignores the
  settings files; `--setting-sources ""`, the empty MCP configuration and
  `--disable-slash-commands` leave no hooks, MCP servers or skills of any
  file.
- Its environment is only `PATH`, `HOME` and `TMPDIR` (the step's folder),
  `LANG`, `ANTHROPIC_BASE_URL` (the proxy), `ANTHROPIC_API_KEY` (the step's
  key), `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
  `DISABLE_TELEMETRY` and `DISABLE_ERROR_REPORTING`.

## Security

Claude Code runs its allowed tools without asking, and a document it reads
can try to steer it (prompt injection). The plugin keeps what matters out
of its reach:

- **The credential never reaches Claude Code.** Claude Code talks to a
  proxy of the plugin on 127.0.0.1 with a key valid for its step only. The
  proxy puts the subscription's token (`Authorization: Bearer`, with the
  `oauth-2025-04-20` beta) or the API key (`x-api-key`) in its place,
  forwards only the messages and the list of models (the account's
  endpoints are refused), keeps each step within the run's tokens, and
  counts them. It logs methods, paths and statuses, never a header.
- **Claude Code runs as another user.** The server runs as root with only
  the `SETUID` and `SETGID` capabilities. It runs Claude Code as the user
  of its slot (`agent1` to `agent8`, uid 10001 up), who reads neither the
  server's environment (the credential, the plugin's token) nor the files
  only root reads. At the end of a step that user's processes are stopped,
  those a tool left behind included.
- **The files given back are files.** A link in `out/` (made with Bash) is
  skipped: the server reads only regular files of one link.
- **The network is the container's.** Claude Code needs only the proxy;
  the server needs the API (`api.anthropic.com`), the npm registry and
  gosidian. With Bash or WebFetch allowed, the container's network should
  reach nothing else.

`scripts/separation-test.sh` checks this on the image, with a fake Claude
Code that tries: the user it runs as, the environment of root's processes,
the token in any process, a link to `/etc/passwd`, a process left behind.

```yaml
services:
  claude:
    image: ghcr.io/daniele-chiappa/gosidian-claude:0.1.1
    restart: unless-stopped
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${CLAUDE_PLUGIN_TOKEN:?}
    volumes:
      - ./claude.yaml:/etc/gosidian-claude/preset.yaml:ro
      - ./secrets/claude-oauth-token:/run/secrets/claude-oauth-token:ro
      - claude-versions:/var/lib/gosidian-claude   # the versions of Claude Code
    read_only: true
    tmpfs: ["/tmp:size=1g"]        # the steps' folders and files
    cap_drop: [ALL]
    cap_add: [SETUID, SETGID]      # to run Claude Code as the slot's user
    security_opt: ["no-new-privileges:true"]
    mem_limit: 2g
volumes:
  claude-versions:
```

Root without capabilities reads only the files it may: a token file owned
by another user and mode 0600 needs `cap_add: [DAC_READ_SEARCH]` too (the
slot's users never get it), or a file owned by root.

Without root, the plugin still works, and says so at startup: Claude Code
then runs as the server's user and its tools could read the credential.

## Anthropic's terms

The plugin takes a subscription's token or an API key; which one is the
choice of whoever installs it, under Anthropic's terms
([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)):

- **A subscription's token** (`claude setup-token`, Pro or Max) is for the
  ordinary use of Claude Code by the subscriber. Use it in this plugin for
  your own pipelines, on your own work.
- **A product or service that serves others**, or that lets other people's
  requests run on Claude, uses an **API key** (Claude Console) under the
  Commercial Terms: it must not route them through the credentials of a
  subscription.

The steps of a subscription count against its limits, shared with the
subscriber's own sessions: `limits.min_left_percent` keeps the pipelines
from using what is left of a session or a week.

## The preset

`/etc/gosidian-claude/preset.yaml` (`CLAUDE_PRESET`). An example is in
[presets/](presets/).

```yaml
name: claude                     # the plugin's name in gosidian
description: Claude Code on the subscription
credentials:                     # one of the four
  oauth_token_file: /run/secrets/claude-oauth-token   # claude setup-token
  # oauth_token_env: CLAUDE_OAUTH_TOKEN
  # api_key_file: /run/secrets/anthropic-api-key
  # api_key_env: ANTHROPIC_KEY
upstream: https://api.anthropic.com
version: latest                  # latest, stable, next, or a version (2.1.301)
models: [haiku, sonnet, opus]    # aliases, or models' ids; the first is the default
effort:
  allowed: [low, medium, high, xhigh, max]
  default: medium                # none: Claude Code's own
tools:
  allowed: [Read, Grep, Glob]    # Write, Edit, Bash, WebFetch… on purpose
  default: [Read, Grep, Glob]
limits:
  default: {max_turns: 20, max_seconds: 10m, max_budget_usd: 1}
  max: {max_turns: 60, max_seconds: 14m, max_budget_usd: 5}
  min_left_percent: {session: 0, week: 0}   # a subscription only; 0: off
system: |                        # added to Claude Code's system prompt
  Answer in the language of the task.
```

`version` matters only when no version is installed: from then on the
version changes only with the `update` node. An **alias** (`haiku`,
`sonnet`, `opus`) is resolved by the installed version of Claude Code, and
each version may resolve it to a newer model: `version` and `update` say
to which. A model's full id stays the same model.

`max_budget_usd` counts dollars at the API's list prices (Claude Code's
`total_cost_usd`): with a subscription they measure the work, they are not
billed. A change of the preset changes the manifest: `gosidian plugin show`,
then `gosidian plugin accept`.

## The nodes

Each node is also a tool for the agents, with the access a token needs
(`run` and `update` write, `version` and `usage` read), in the projects the
owner exposes the plugin in.

### `<agent>.run`

| Setting | Default | |
|---|---|---|
| `prompt` | required | the task |
| `system` | | instructions added to the system prompt |
| `model` | the preset's first | one of the preset's models |
| `effort` | the preset's (or Claude Code's) | one of the preset's levels, that the installed version takes |
| `files` | | a vault path or a list of them (`{{ trigger.files }}`), in `in/` |
| `tools` | the preset's default | a subset of the preset's allowed |
| `max_turns`, `max_seconds`, `max_budget_usd` | the preset's | at most the preset's max |
| `json` | false | the answer is a JSON value |
| `schema` | | a JSON Schema the answer must follow (`--json-schema`) |

Output:

- `text`, and `json` with `json` or `schema`;
- `model`: the model the step ran on, as the alias resolved
  (`claude-haiku-5-5`);
- `effort`: `requested` and `applied`, the effort of the requests the
  proxy saw. A model without effort levels (the 4.5 generation) gets none
  from Claude Code, silently: `note` says so;
- `subtype` (`success`), `turns`, `tools` (those Claude Code had);
- `usage`: `input`, `output`, `cache_read`, `cache_write` and
  `total_tokens`, all four together, which counts in the run's
  `max_llm_tokens`;
- `cost`: `total_cost_usd`;
- `denials`: the tool calls refused, each `tool` and its `input`;
- `claude_code`: the version that ran;
- `subscription`: the subscription's limits after the step (below);
- from gosidian, `files`, and `skipped`.

The node's `timeout` (5 minutes by default) must cover `max_seconds`:

```yaml
- id: judge
  use: claude.run
  with:
    prompt: "Valuta le risposte in in/ secondo i criteri del bando."
    files: "{{ trigger.files }}"
    model: sonnet
    effort: high
    schema:
      type: object
      required: [score, reasons]
      properties: {score: {type: integer, minimum: 0, maximum: 10}, reasons: {type: array, items: {type: string}}}
    max_budget_usd: 0.5
  timeout: 14m
```

### `<agent>.version`

No settings. Output: `installed`, `channel` (the preset's `version`),
`latest` (the npm registry's tag), `update_available`, `aliases` (alias →
model, from the probe of the installed version), `probed_at`,
`effort_levels` (those its `--effort` takes), `models` (the API's list,
each with the effort levels it supports), `installed_versions`, `state`,
`release_notes`.

### `<agent>.update`

| Setting | Default | |
|---|---|---|
| `version` | the preset's (`latest`) | a tag of the registry or a version |
| `switch` | true | put it in use once its probe passes |

It installs the version aside (`npm install --ignore-scripts`, the
platform's native binary), checks `--version`, reads the effort levels of
its `--help`, and **probes** each alias of the preset: one run with a
prompt of two words, no tools and one turn, whose result names the model.
A version that fails its probe is not put in use. With `switch` the plugin
waits for the running steps, puts the new version in use, and the steps
that come meanwhile wait for it. It keeps the version in use, the one
before and the newest of the others (`CLAUDE_KEEP_VERSIONS`, 3).

Output: `old_version`, `new_version`, `current`, `switched`,
`old_aliases`, `new_aliases`, `changed` (the aliases that now resolve to
another model), `release_notes` (Claude Code's changelog),
`installed_versions`.

### The update request

Claude Code is meant to run at its newest version, and a version brings
the models its aliases resolve to. A pipeline of the owner's checks each
day and decides with the probe's result:

- the new version is installed and probed aside (`switch: false`);
- when every alias resolves to the **same model** as before, a second
  `update` puts it in use: it is installed already, so only the probe runs
  again, after the running steps end;
- when **an alias moves to another model**, the pipeline writes a request
  with the aliases before and after, and the switch waits for whoever
  approves it: a second pipeline, started by the commit of the request
  note, runs `update` with that `version` once its status says so.

```yaml
trigger: {on: schedule, every: "day 07:00"}
nodes:
  - id: check
    use: claude.version
  - id: prepare
    use: claude.update
    when: "{{ check.update_available }}"
    with: {version: "{{ check.latest }}", switch: false}
    timeout: 14m
  - id: decide
    use: starlark
    when: "{{ check.update_available }}"
    with:
      input: {p: "{{ prepare }}"}
      code: |
        same = len(input["p"]["changed"]) == 0
        output = {"apply": same, "ask": not same, "version": input["p"]["new_version"]}
  - id: apply
    use: claude.update
    when: "{{ decide.apply }}"
    with: {version: "{{ decide.version }}"}
    timeout: 14m
  - id: request
    use: note.write
    when: "{{ decide.ask }}"
    with:
      path: "requests/claude-code-{{ decide.version }}.md"
      frontmatter: {status: pending, version: "{{ decide.version }}"}
      body: |
        Aliases before: {{ prepare.old_aliases }}
        Aliases after: {{ prepare.new_aliases }}
        Release notes: {{ prepare.release_notes }}
```

A version that fails its probe is never put in use: the step fails and
says why.

### `<agent>.usage`

| Setting | Default | |
|---|---|---|
| `max_age` | 300 | seconds: older values are read again |
| `steps` | 20 | how many of the last steps to give (at most 1000) |
| `since` | | only the steps that ended after this time (RFC 3339) |

Output, the same block as a step's `subscription`:
`applicable`, `source`, `read_at`, `status`, `session` and `week` (each
`used_percent`, `left_percent`, `resets_at`, `status`), `week_models`
(when the API gives a model's weekly window), `representative_claim` (the
window that limits first). With an API key: `applicable: false`. And:

- `min_left_percent`: the preset's share of the session and of the week
  the steps leave free;
- `steps`: the last steps, newest first, each `at` (when it ended),
  `seconds`, `project` and `run` (gosidian's), `model`, `effort`,
  `subtype`, `turns`, `tokens` (and `input`, `output`, `cache_read`,
  `cache_write`), `cost`, `claude_code`; a step that failed has `error`
  and the model it asked for. The plugin keeps the last
  `CLAUDE_KEEP_STEPS` in its volume (`steps.json`), across restarts.

A dashboard is a pipeline that reads `usage` each hour (`every: "hour
:05"`, after gosidian 2.93) and writes a note.

The values come from the `anthropic-ratelimit-unified-*` headers of the
API's answers (`5h` and `7d`: utilization, reset, status), which the proxy
keeps. Claude Code's `/usage` reads `GET /api/oauth/usage` instead, which
needs a token with the `user:profile` scope: one from `claude setup-token`
has only `user:inference` and gets 403, so the plugin tries it once and
then keeps to the headers. Values older than `max_age` are read again with
a request of one token to the cheapest model.

## Environment

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | empty | the bearer token gosidian sends; empty: none |
| `CLAUDE_PRESET` | `/etc/gosidian-claude/preset.yaml` | the preset |
| `CLAUDE_VERSIONS_DIR` | `/var/lib/gosidian-claude` | the versions of Claude Code (a volume) |
| `CLAUDE_KEEP_VERSIONS` | 3 | versions kept installed |
| `CLAUDE_KEEP_STEPS` | 200 | the last steps `usage` can give, kept in the volume |
| `CLAUDE_NPM_REGISTRY` | `https://registry.npmjs.org` | where Claude Code comes from |
| `CLAUDE_WORKERS` | 1 | steps at once (at most 8 as root, a user each); the others wait |
| `CLAUDE_RUNS_DIR` | `/tmp/gosidian-claude` | the steps' folders |
| `CLAUDE_MAX_FILES_BYTES` | 256 MiB | the files of one step together |
| `CLAUDE_MAX_OUT_FILES`, `CLAUDE_MAX_OUT_BYTES` | 50, 50 MiB | the files given back |
| `CLAUDE_UID`, `CLAUDE_GID` | 10001 | the first slot's user, as root |
| `PORT` | 8000 | MCP at `/mcp`, `GET /health` without a token |

`/health` says the version in use (`claude_code`) and what the store is
doing (`state`). An install that fails at the start (no network, a registry
down) is tried again a minute later, then less often; a step that comes
meanwhile waits for an install in progress, and fails with its reason.

## Building and testing

```bash
docker build --build-arg VERSION=0.1.1 -t gosidian-claude:0.1.1 claude/
claude/scripts/test.sh               # types and tests, in node:24-alpine
claude/scripts/separation-test.sh    # the image as in production: users, secrets, links, leftovers
TOKEN_FILE=… claude/scripts/smoke-test.sh   # the real Claude Code and API: install, probe, run, version, usage
```

The tests need neither Claude Code nor a credential: a fake Claude Code
(`test/fake-claude.ts`) and a fake API (`test/mock-api.ts`) stand in, and
the events of a session recorded from Claude Code 2.1.301 are in
`test/fixtures/`. The smoke test spends a few requests of the subscription,
and never prints the token. The image is built for amd64.

## Licenses

MIT, like gosidian. Claude Code is not in the image, and is Anthropic's;
the other packages are under their own licenses: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

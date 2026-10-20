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

**One container is one agent.** Its preset names the endpoints (Anthropic's
API, with a subscription's token or an API key, and others that speak its
Messages API: OpenRouter, Ollama, vLLM), the models on each, the effort
levels a node may pick, the tools the agent may use and the limits of a
step; the repositories a step may work on, and the access to gosidian's
MCP a step may ask for. The node decides the rest: the prompt, the system
prompt, the model, the effort, the files, what the agent may do within the
preset's tools, the limits within the preset's, the JSON the answer must
be, the repository and gosidian's MCP. The node keeps gosidian's common
contract of the agents, `agent-run/1`.

## A step

1. gosidian calls `run` with the node's settings. Each file the node names
   comes by reference (`file_refs`), a list of them too. The tokens the run
   may still spend come in the call's `_meta`.
2. With `limits.min_left_percent`, a step on the subscription's endpoint
   first checks the subscription: a session or week with less left fails
   the node, with the time it resets.
3. The plugin makes a folder for the step. With `repo`, it clones the
   repository into `repo/`, on a branch of the step's own (below): the
   clone counts in `max_seconds`. The files are fetched into `in/`,
   checked against their size and SHA-256; `out/` is empty.
4. It runs `claude -p` there, the prompt on its standard input, as the
   user of the step's slot, with an environment of its own (below), and
   follows its events (`--output-format stream-json`). It stops it at
   `max_seconds`, at `max_tokens` or when the run's tokens are spent, at
   `max_cost` on an endpoint other than Anthropic's (at the preset's
   prices), or when gosidian cancels the call; Claude Code itself stops at
   `max_turns`, and on Anthropic's endpoints at `max_cost`.
5. The result decides: anything but `success` fails the node with the
   reason (`error_max_turns`, `error_max_budget_usd`, an error of the
   endpoint…). With `schema`, the answer is Claude Code's structured output,
   checked again against the schema; with `json`, the text read as JSON.
   With `repo`, the plugin then commits what the agent changed in `repo/`,
   pushes the branch and opens the pull request; a step that failed
   commits nothing.
6. The files the agent wrote in `out/` go back to gosidian, which stores
   them as attachments; the folder is removed, and every process of the
   slot's user is stopped.

What Claude Code runs with (checked on 2.1.301 and 2.1.304):

```
claude -p --output-format stream-json --verbose
  --model <model> [--effort <effort>] --max-turns <n> [--max-budget-usd <max_cost>]
  --tools <tools> --allowedTools <tools>[,mcp__gosidian__*]
  --permission-mode dontAsk --permission-prompts none --restricted
  --setting-sources "" --settings '{"disableAllHooks":true}'
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'   # or gosidian's, below
  --disable-slash-commands --no-session-persistence
  --append-system-prompt-file <step>/system.md [--json-schema <schema>]
```

- On Anthropic's endpoints `--model` is the model's id (an alias, which
  the version resolves, or a `claude-*` id) and `--max-budget-usd` is
  `max_cost`. On another endpoint it is the model's name, the proxy sends
  the endpoint's id, and the plugin keeps `max_cost` at the preset's
  prices: Claude Code knows no price of the endpoint's models. `--effort`
  only for a model that takes one.
- `system_mode: replace` puts `--system-prompt-file` in place of
  `--append-system-prompt-file`: the step's system prompt replaces Claude
  Code's own (which keeps only a line naming itself).

- Only the node's tools exist (`--tools`), and only they are approved
  (`--allowedTools`): anything else that would ask is denied
  (`dontAsk`), and the denials come back in the output.
- `--restricted` confines the file tools to the step's folder, removes the
  tools that run code unless `--tools` names them, and ignores the
  settings files; `--setting-sources ""`, the empty MCP configuration and
  `--disable-slash-commands` leave no hooks, MCP servers or skills of any
  file.
- With `mcp`, the one MCP server is gosidian's:
  `{"mcpServers":{"gosidian":{"type":"http","url":"<gosidian/mcp_url>","headers":{"Authorization":"Bearer ${GOSIDIAN_MCP_TOKEN}"}}}}`.
  Claude Code reads `${GOSIDIAN_MCP_TOKEN}` from its environment, so the
  token is never in its arguments, which any process may read; and
  `mcp__gosidian__*` approves every tool of the server (`--tools` leaves
  MCP tools alone, and `--restricted` keeps them). Checked on 2.1.304.
- Its environment is only `PATH`, `HOME` and `TMPDIR` (the step's folder),
  `LANG`, `ANTHROPIC_BASE_URL` (the proxy), `ANTHROPIC_API_KEY` (the step's
  key), `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
  `DISABLE_TELEMETRY` and `DISABLE_ERROR_REPORTING`; and, for a model on
  another endpoint, `ANTHROPIC_DEFAULT_OPUS_MODEL`,
  `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` and
  `ANTHROPIC_DEFAULT_FABLE_MODEL` (the
  model's name: a background task uses haiku's) and
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (an endpoint may refuse the
  fields of a beta); `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` when the model sets `context` and
  `max_output` (Claude Code takes an id it does not know for 200K of
  context and 32K of output); `GOSIDIAN_MCP_TOKEN` with `mcp`.

## Security

Claude Code runs its allowed tools without asking, and a document it reads
can try to steer it (prompt injection). The plugin keeps what matters out
of its reach:

- **The credentials never reach Claude Code.** Claude Code talks to a
  proxy of the plugin on 127.0.0.1 with a key valid for its step only. The
  proxy sends the step's requests to the endpoint of its model, with the
  endpoint's credential in place of the key: the subscription's token
  (`Authorization: Bearer`, with the `oauth-2025-04-20` beta), an API key
  of Anthropic's (`x-api-key`), another endpoint's key (`Authorization:
  Bearer`, no beta of Anthropic's), or none; and the endpoint's own
  headers. It forwards only the messages and the list of models (the
  account's endpoints are refused); to another endpoint it sends the step's
  model in every message, and answers the token count (404: Claude Code
  then estimates) and the list of models itself. It keeps each step within
  its tokens, and counts them. It logs methods, paths and statuses, never a
  header.
- **Claude Code runs as another user.** The server runs as root with only
  the `SETUID` and `SETGID` capabilities. It runs Claude Code as the user
  of its slot (`agent1` to `agent8`, uid 10001 up), who reads neither the
  server's environment (the credential, the plugin's token) nor the files
  only root reads. At the end of a step that user's processes are stopped,
  those a tool left behind included.
- **The files given back are files.** A link in `out/` (made with Bash) is
  skipped: the server reads only regular files of one link.
- **The repository's credentials never reach Claude Code.** The server
  clones, commits and pushes, with the deploy key and the pull requests'
  token of the preset, files only root reads; the agent only edits the
  files of `repo/`. The git folder lies outside it, readable by the agent
  (`git log`, `git diff`) and not writable; `work/` is sticky, so `repo/`
  stays where it is. Git runs without hooks, without the system's or a
  user's configuration, without filters; a hard link, a file that is not a
  plain one, or more files or bytes than the preset allows commit nothing.
  A step commits on a branch of its own, under the preset's prefix, never
  on the base or a protected branch.
- **The network is the container's.** Claude Code needs only the proxy,
  and with `mcp` gosidian's MCP, with a token of the run's project that
  gosidian makes for the call and revokes when it returns; the server
  needs the endpoints (`api.anthropic.com`, `openrouter.ai`, a host of the
  LAN…), the repositories' hosts, the npm registry and gosidian: the
  manifest's `permissions.network` lists them. With Bash or WebFetch
  allowed, the container's network should reach nothing else.
- **gosidian's MCP token stays in the step.** It is in Claude Code's
  environment, which only the slot's user and root read, never in its
  arguments; the output names the level and the endpoint, never the
  token. The agent may use it as the MCP tools do, its Bash too: what it
  reads in the vault can steer it, so `write` is for the pipelines that
  need it.

`scripts/separation-test.sh` checks this on the image, with a fake Claude
Code that tries: the user it runs as, the environment of root's processes,
the token in any process, a link to `/etc/passwd`, a process left behind;
on a repository, the deploy key, a hook and the configuration of the git
folder, a commit and a push of its own, moving `repo/`, a hard link to a
file only root reads, the MCP token in a command line; and a hard link
the server must refuse to commit.

```yaml
services:
  claude:
    image: ghcr.io/daniele-chiappa/gosidian-claude:0.2.0
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

**Other models.** Claude Code runs on another vendor's model, or a local
one, through an endpoint that speaks the Messages API (OpenRouter, Ollama,
vLLM), but Anthropic supports Claude Code with Claude models only, and
gives no help with the others behind a gateway. A small local model calls
tools less reliably than Claude, and may answer without reading the files:
try it on the pipeline's own tasks first.

## The preset

`/etc/gosidian-claude/preset.yaml` (`CLAUDE_PRESET`). Examples are in
[presets/](presets/): the subscription (`claude.yaml`), OpenRouter
(`openrouter.yaml`), Ollama on a GPU of the LAN (`ollama.yaml`).

```yaml
name: claude                     # the plugin's name in gosidian
description: Claude Code on the subscription
endpoints:                       # by name; at least one
  anthropic:
    url: https://api.anthropic.com
    auth: oauth                  # oauth, api_key, bearer or none
    key_file: /run/secrets/claude-oauth-token   # or key_env: a variable
version: latest                  # latest, stable, next, or a version (2.1.301)
models: [haiku, sonnet, opus]    # the first is the default (below)
effort:
  allowed: [low, medium, high, xhigh, max]
  default: medium                # none: Claude Code's own
tools:
  allowed: [Read, Grep, Glob]    # Write, Edit, Bash, WebFetch… on purpose
  default: [Read, Grep, Glob]
limits:
  default: {max_turns: 20, max_seconds: 10m, max_tokens: 300000, max_cost: 1}
  max: {max_turns: 60, max_seconds: 14m, max_tokens: 2000000, max_cost: 5}
  min_left_percent: {session: 0, week: 0}   # a subscription only; 0: off
system: |                        # added to Claude Code's system prompt
  Answer in the language of the task.
repos:                           # the repositories a step may work on (below)
  - name: app
    url: git@git.example.com:team/app.git
    key_file: /run/secrets/app-deploy-key
    known_hosts: "git.example.com ssh-ed25519 AAAA…"
mcp: [read]                      # gosidian's MCP a step may ask for: read, write
```

`version` matters only when no version is installed: from then on the
version changes only with the `update` node. A change of the preset
changes the manifest: `gosidian plugin show`, then `gosidian plugin
accept`.

The limits' defaults are 20 turns, 10 minutes, 300,000 tokens and $1; at
most 100 turns, 14 minutes, 2,000,000 tokens and $10. `max_tokens` counts
the four kinds together (input, output, read from and written to the
cache), as the run's `max_llm_tokens` does. `max_cost` is in US dollars:
on Anthropic's endpoints at the API's list prices (Claude Code's
`total_cost_usd`; with a subscription they measure the work, they are not
billed), on the others at the model's prices in the preset.

### Endpoints

| Field | |
|---|---|
| `url` | the API's base, `http` or `https`: the proxy adds `/v1/messages` |
| `auth` | `oauth`: a subscription's token (`claude setup-token`), as a bearer with the OAuth beta; `api_key`: a key of the Claude API, as `x-api-key`; `bearer`: another endpoint's key, as a bearer; `none`: no header |
| `key_file`, `key_env` | where the server reads the key: a file, or a variable of its environment. One of them, but with `none` |
| `headers` | headers sent with every request (OpenRouter's `HTTP-Referer` and `X-Title`), never one of authentication |

An endpoint with `oauth` or `api_key` is **Anthropic's**: the aliases of
Claude Code, the effort levels, the API's list of models, and, with
`oauth`, the subscription's limits. A preset has at most one `oauth`
endpoint. The others are **compatible**: they speak the Messages API with
models of their own, and the proxy sends each message to the step's
model, answers the token count (404: Claude Code estimates the tokens) and
the list of models (the preset's) itself, and keeps no subscription. The
endpoint must stream the answers (server-sent events) as they come.

### Models

A model is a name, or an object:

| Field | Default | |
|---|---|---|
| `name` | required | how a node picks it: letters, digits, `.` `_` `:` `[` `]` `-` |
| `endpoint` | the only endpoint | the endpoint it is on |
| `id` | the name | the model as the endpoint knows it: an alias or a `claude-*` id on Anthropic's, `anthropic/claude-sonnet-5.5` on OpenRouter, `qwen3-coder:30b` on Ollama |
| `context`, `max_output` | Claude Code's | tokens of context and of one answer (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`) |
| `cost` | none | `input`, `output`, `cache_read`, `cache_write`: US dollars per million tokens, those not given 0; for the cost of a step on a compatible endpoint, and its `max_cost` |
| `effort` | true on Anthropic's, false on the others | whether the endpoint takes an effort level: with false, no `--effort`, and the proxy drops the effort Claude Code sends all the same |

A name alone (`haiku`, `claude-opus-5-5`) is a model of the first
Anthropic endpoint. An **alias** (`haiku`, `sonnet`, `opus`) is resolved by
the installed version of Claude Code, and each version may resolve it to a
newer model: `version` and `update` say to which. A model's full id stays
the same model. Without `models` the preset has haiku, sonnet and opus,
when it has an Anthropic endpoint.

On a compatible endpoint Claude Code runs on the model's name, every alias
of its own pinned to it (a background task uses haiku's), and the proxy
puts the model's `id` in every message. A model without prices costs 0, and
`max_cost` never stops it.

**Anthropic, a subscription** (the old form, below, is the same):

```yaml
endpoints:
  anthropic: {url: https://api.anthropic.com, auth: oauth, key_file: /run/secrets/claude-oauth-token}
models: [haiku, sonnet, opus]
limits:
  min_left_percent: {session: 20, week: 10}
```

**OpenRouter** (`https://openrouter.ai/api`, its key as a bearer; Anthropic's
models and other vendors'):

```yaml
endpoints:
  openrouter:
    url: https://openrouter.ai/api
    auth: bearer
    key_file: /run/secrets/openrouter-api-key
    headers: {HTTP-Referer: "https://gosidian.example", X-Title: gosidian}
models:
  - {name: sonnet-5.5, id: anthropic/claude-sonnet-5.5, context: 1000000, max_output: 32000, cost: {input: 2, output: 10}}
  - {name: glm-5.3, id: z-ai/glm-5.3, context: 1000000, max_output: 32000, cost: {input: 1.4, output: 4.4}}
```

**Ollama on a GPU of the LAN** (0.14 or later serves `/v1/messages`; no key).
An agent wants 64K tokens of context at least: start Ollama with
`OLLAMA_CONTEXT_LENGTH=65536`. Ollama counts no tokens and has no
`cache_control` or `tool_choice`:

```yaml
endpoints:
  ollama: {url: "http://gpu.lan:11434", auth: none}
models:
  - {name: qwen3-coder, id: "qwen3-coder:30b", context: 65536, max_output: 8192}
```

**vLLM** (0.11.1 or later serves `/v1/messages` too), with a served name
without `/` and a parser of the model's tool calls:

```bash
vllm serve Qwen/Qwen3-Coder-30B-A3B-Instruct --served-model-name qwen3-coder \
  --max-model-len 65536 --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --api-key "$VLLM_API_KEY"
```

```yaml
endpoints:
  vllm: {url: "http://gpu.lan:8000", auth: bearer, key_env: VLLM_API_KEY}   # without --api-key: auth none
models:
  - {name: qwen3-coder, context: 65536, max_output: 8192}
```

One preset may have several endpoints, Anthropic's and others: each model
names its own, and the node's `model` picks among all of them.

### Repositories

`repos` is the closed list of the repositories a step may work on (the
node's `repo`). The plugin's server clones one on a branch of the step's
own, the agent edits its files, and the server commits what changed,
pushes the branch and, where the preset says so, opens a pull request.

| Field | Default | |
|---|---|---|
| `name` | required | how a node picks it: lower-case letters, digits and `-` |
| `url` | required | `git@host:owner/app.git` or `ssh://…` (SSH), `https://…`, or a path on the plugin's disk |
| `key_file` | | the deploy key, for SSH (required there): a file only root reads, which the agent never does |
| `known_hosts`, `known_hosts_file` | | the host keys SSH accepts, checked out of band (required for SSH); one or the other |
| `base` | `main` | the branch a step starts from, unless the node names another |
| `branch_prefix` | `agent/` | the steps' branches: `<prefix><run>-<step>`, or the node's `branch` under the prefix |
| `protected` | | branches a step never commits on, besides `base` |
| `author` | `gosidian agent <agent@gosidian.invalid>` | `name` and `email` of the commits |
| `depth` | 0 | the commits a clone fetches; 0 is the whole history |
| `max_files`, `max_bytes` | 500, 20 MiB | a step that changed more commits nothing, and fails |
| `pr` | | pull requests on Gitea: `kind: gitea`, `api` (up to `/api/v1`), `repo` (`owner/name`), `token_file` (the plugin's token, which only root reads) |

The manifest's `permissions.network` gains the repositories' hosts and
their pull requests' APIs. A deploy key should open its own repository
alone, and the repository's server should keep the base branch and the
protected ones from it too.

### gosidian's MCP

`mcp` lists the levels of gosidian's MCP a step may ask for (`read`,
`write`); none by default. With it, the manifest's run node says
`"mcp": true` and `permissions.mcp` lists the levels, which accepting the
manifest grants. A node with `mcp: read` or `write` gets, in the call's
`_meta`, the MCP endpoint and a token of the run's project that lasts the
call; Claude Code gets gosidian's server and the permission to use its
tools. A call that asks for `mcp` and carries no token fails: gosidian is
too old for it, or the manifest was not accepted with its
`permissions.mcp`.

### The old form, deprecated names

A preset of 0.1 works as it is: `credentials` (one of `oauth_token_file`,
`oauth_token_env`, `api_key_file`, `api_key_env`) and `upstream`
(`https://api.anthropic.com` by default) are the endpoint `anthropic`, and
its `models` are names on it. A preset has either `endpoints` or
`credentials`, not both.

`max_budget_usd` is the old name of `max_cost`, in the preset's limits and
in a node's settings: it still works in 0.2, and goes later.

## The nodes

Each node is also a tool for the agents, with the access a token needs
(`run` and `update` write, `version` and `usage` read), in the projects the
owner exposes the plugin in.

### `<agent>.run`

The node keeps gosidian's contract `agent-run/1` (the manifest says
`"contract": "agent-run/1"`): its settings and output are those of every
agent, and a few of its own.

| Setting | Default | |
|---|---|---|
| `prompt` | required | the task |
| `system` | | the role: instructions for the system prompt |
| `system_mode` | `append` | `append`: added to Claude Code's system prompt (`--append-system-prompt-file`); `replace`: in its place (`--system-prompt-file`) |
| `model` | the preset's first | one of the preset's models, by name |
| `effort` | the preset's (or Claude Code's) | one of the preset's levels, that the installed version takes; ignored for a model without effort |
| `files` | | a vault path or a list of them (`{{ trigger.files }}`), in `in/` |
| `access` | | `read` (Read, Grep, Glob), `edit` (also Write, Edit), `exec` (also Bash): those the preset allows. A level whose tools the preset allows none of fails the node, naming them |
| `tools` | access's, else the preset's default | a subset of the preset's allowed; with `access`, within its tools |
| `max_turns`, `max_seconds`, `max_tokens`, `max_cost` | the preset's | at most the preset's max; `max_tokens` also at most the run's tokens left |
| `max_budget_usd` | | deprecated: `max_cost` |
| `json` | false | the answer is a JSON value |
| `schema` | | a JSON Schema the answer must follow (`--json-schema`) |
| `repo` | | a repository of the preset (only with `repos`): `name`, `base` (the preset's), `branch` (`<prefix><run>-<step>`), `push` (true), `pr` (`true`, or `title` and `body`; a repository with `pr` in the preset) |
| `mcp` | `none` | `read` or `write`, the preset's levels (only with `mcp`): gosidian's MCP for the step |

With `repo`, the system prompt says where the repository is: in `repo/`,
on the step's branch, which the agent must not commit, push or change;
`in/` and `out/` keep their meaning. The commit's message is the preset's
name and the first line of the prompt (72 characters at most), the
agent's answer (4,000 at most), and the project and run of gosidian.

Output:

- `text`, and `json` with `json` or `schema`;
- `model`: `name` (the preset's), `id` (the endpoint's: on Anthropic's,
  the alias as the version resolved it, `claude-haiku-5-5`) and
  `endpoint`;
- `stop`: `done`, or `length` when the model's last answer was cut at its
  output tokens;
- `turns`;
- `usage`: `input`, `output`, `cache_read`, `cache_write` and
  `total_tokens`, all four together, which counts in the run's
  `max_llm_tokens`;
- `cost`: US dollars, and `cost_source`: `agent` (Claude Code's
  `total_cost_usd`, on Anthropic's endpoints), `prices` (the tokens the
  proxy counted at the model's prices, on the others) or `none` (a model
  without prices: 0);
- `tools`: the calls of each tool (`{"Read": 3, "Grep": 1}`);
- `denials`: the tool calls refused, each `tool` and its `input`;
- `executor`: `plugin` (`gosidian-claude`), `version` (the plugin's),
  `agent` (`claude-code`), `agent_version` (the version that ran);
- `repo`, with `repo`: `name`, `base`, `branch`, `commit` (none when
  nothing changed, and `note` says so), `changed` (files), `insertions`,
  `deletions`, `pushed`, `pr_url`;
- `mcp`, with `mcp`: `level`, `url` and `status` (gosidian's server as
  Claude Code found it at the start: `connected`, `failed`…); never the
  token;
- the plugin's own: `effort` (`requested` and `applied`, the effort of the
  requests the proxy saw; a model without effort levels gets none, and
  `note` says so), `subtype` (`success`), `allowed_tools` (the tools
  Claude Code had), `claude_code` (the version that ran, as
  `executor.agent_version`), `subscription` (the subscription's limits
  after the step, below; only on the subscription's endpoint);
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
    access: read
    schema:
      type: object
      required: [score, reasons]
      properties: {score: {type: integer, minimum: 0, maximum: 10}, reasons: {type: array, items: {type: string}}}
    max_cost: 0.5
  timeout: 14m
```

### `<agent>.version`

No settings. Output: `installed`, `channel` (the preset's `version`),
`latest` (the npm registry's tag), `update_available`, `aliases` (alias →
model, from the probe of the installed version), `probed_at`,
`effort_levels` (those its `--effort` takes), `models` (the list of an
Anthropic endpoint, each with the effort levels it supports),
`installed_versions`, `state`, `release_notes`. A preset without an
Anthropic endpoint has no alias to probe and no list: `probe_skipped` says
so.

### `<agent>.update`

| Setting | Default | |
|---|---|---|
| `version` | the preset's (`latest`) | a tag of the registry or a version |
| `switch` | true | put it in use once its probe passes |

It installs the version aside (`npm install --ignore-scripts`, the
platform's native binary), checks `--version`, reads the effort levels of
its `--help`, and **probes** each alias of the preset's Anthropic
endpoints: one run with a prompt of two words, no tools and one turn, whose
result names the model.
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
window that limits first). Without a subscription (an API key, or no
Anthropic endpoint): `applicable: false`. And:

- `min_left_percent`: the preset's share of the session and of the week
  the steps leave free;
- `steps`: the last steps, newest first, each `at` (when it ended),
  `seconds`, `project` and `run` (gosidian's), `model` (its id),
  `endpoint`, `effort`,
  `subtype`, `turns`, `tokens` (and `input`, `output`, `cache_read`,
  `cache_write`), `cost`, `claude_code`, `repo` (`name`, `branch`,
  `commit`); a step that failed has `error` and the model (and the
  repository) it asked for. The plugin keeps the last
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
docker build --build-arg VERSION=0.2.0 --build-context kit=agent-kit -t gosidian-claude:0.2.0 claude/
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

# gosidian-pi

A gosidian plugin whose node runs a [pi](https://pi.dev) agent: a model
that works in several turns with tools (read, grep, find, ls; bash, edit
and write when its preset allows them) on the files a pipeline hands it,
or on a repository of its preset, and answers with text or JSON, giving
back the files it writes and committing what it changed. It may read and
write the notes of the run's project through gosidian's MCP. For a task of
one call, gosidian's `llm.chat` is simpler.

The node keeps `agent-run/1`, the contract of gosidian's agents
(gosidian's `docs/plugins.md`, "Agent nodes"): the same settings and
output as the other agents, such as [claude](../claude), so a pipeline
picks an executor without learning it.

**One container is one agent.** Its preset names the endpoint and its
key, the models a node may pick, the tools the agent may use and the limits
of a step, the repositories a step may work on and the access to
gosidian's MCP it may ask for. Two containers of the same image make two
agents, say `pi-locale` on a local GPU and `pi-openrouter`, registered in
gosidian as two plugins. The node decides the rest: the prompt, the system
prompt, the model among the preset's, the effort (pi's thinking level),
the temperature, the files, the access, the limits within the preset's,
the JSON the answer must be, the repository and gosidian's MCP.

## A step

1. gosidian calls `run` with the node's settings. Each file the node names
   comes by reference (`file_refs`), a list of them too (gosidian 2.85).
   The tokens the run may still spend come in the call's `_meta`, with the
   run's project and id, and with `mcp`, gosidian's MCP endpoint and a
   token of the call.
2. The plugin makes a folder for the step. With `repo`, it clones the
   repository into `repo/`, on a branch of the step's own. The files are
   fetched into `in/`, checked against their size and SHA-256; `out/` is
   empty. With `mcp`, it checks that gosidian's MCP takes the token.
3. It runs `pi --mode json` there, the prompt on its standard input, with
   no context files, extensions or MCP (but gosidian's, with `mcp`),
   offline, and a session of its own. It follows pi's events, and stops
   it at a limit:
   - `max_turns`;
   - `max_seconds`;
   - `max_tokens` (or the run's tokens, if fewer);
   - `max_cost` (dollars, from the preset's prices).
4. With `json` or `schema`, the answer is taken as JSON and checked. If it
   does not hold, the agent gets `json_retries` more turns in the same
   session, each saying what is wrong.
5. With `repo`, the plugin commits what the agent changed in `repo/` and
   pushes the branch (and opens the pull request, if asked).
6. The files the agent wrote in `out/` go back to gosidian, which stores
   them as attachments; the folder is removed.

A step that stops at a limit, an endpoint that refuses, an answer that
stays no valid JSON, a repository that cannot be cloned or committed, or
gosidian's MCP refusing the token fails the node, with the reason: the
node's `retry` and `on_error` apply. A step that fails commits nothing.

## Security

pi runs its tools without asking, and a document it reads can try to
steer it (prompt injection). pi's tools are not confined to a folder. The
plugin keeps what matters out of reach:

- **The key never reaches pi.** pi talks to a proxy of the plugin on
  127.0.0.1 with a token valid for its step only. The proxy adds the key,
  and the preset's body (the routing), keeps each request within the
  step's token budget, and counts the usage.
- **pi runs as another user.** The server runs as root with only the
  `SETUID` and `SETGID` capabilities. It runs pi as the user of its slot
  (`agent1` to `agent8`, uid 10001 up), who reads neither the server's
  environment (the key, the plugin's token) nor the files only root reads.
  At the end of a step that user's processes are stopped, those a tool
  left behind included.
- **The files given back are files.** A link in `out/` (made with bash) is
  skipped: the server reads only regular files of one link.
- **pi's configuration is the server's.** Its folder holds the files the
  server writes (the model, the settings, gosidian's MCP), which pi reads
  and the agent cannot change or replace: a value of them may be a command
  pi runs, and a JSON retry starts pi again.
- **The repository is the server's.** The server clones, commits and
  pushes with the preset's deploy key (a file only root reads) and pinned
  host keys; the agent edits the files of `repo/` and nothing else of
  it. The git folder lies outside `repo/`, readable by the agent (git log,
  diff, status) and not writable; the agent cannot move `repo/`, commit,
  or push. git runs without hooks, configuration of the system's or a
  user's, or filters. A file that is not a plain one, a hard link, or more
  files or bytes than the preset allows, commit nothing. The common code
  is [agent-kit](../agent-kit).
- **gosidian's MCP with a token of the call.** With `mcp`, gosidian mints a
  token of the run's project that lasts the call and is revoked when it
  returns. pi gets it in its environment only (`GOSIDIAN_MCP_TOKEN`, which
  its `mcp.json` names), never in its arguments or a file: while the step
  runs, the agent can reach gosidian with it, and with bash read it, as
  the pipeline could. What the agent reads can steer it (prompt
  injection): `write` is for the pipelines that need it.
- **The network is the container's.** pi needs only the proxy, and
  gosidian with `mcp`; the server needs the endpoint, gosidian and the
  repositories' servers. With bash allowed, the container's network should
  reach nothing else.

```yaml
services:
  pi-openrouter:
    image: ghcr.io/daniele-chiappa/gosidian-pi:0.2.0
    restart: unless-stopped
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${PI_OPENROUTER_TOKEN:?}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:?}
    volumes:
      - ./pi-openrouter.yaml:/etc/gosidian-pi/preset.yaml:ro
      - ./secrets/app_deploy_key:/run/secrets/app_deploy_key:ro   # root's, mode 600
    read_only: true
    tmpfs: ["/tmp:size=1g"]        # the steps' folders and files
    cap_drop: [ALL]
    cap_add: [SETUID, SETGID]      # to run pi as the slot's user
    security_opt: ["no-new-privileges:true"]
    mem_limit: 2g
```

Without root, the plugin still works, and says so at startup: pi then runs
as the server's user and its tools could read the key, and the deploy
keys of the repositories.

## The preset

`/etc/gosidian-pi/preset.yaml` (`PI_PRESET`). Two examples are in
[presets/](presets/): `pi-locale` (llama.cpp on a 16 GB GPU, Qwen3.8-27B
at 3 bits) and `pi-openrouter` (eight models, Western and Chinese, with
the routing of the example).

```yaml
name: pi-openrouter              # the plugin's name in gosidian
description: A pi agent on OpenRouter
endpoint:
  base_url: https://openrouter.ai/api/v1   # an OpenAI-compatible API
  api_key_env: OPENROUTER_API_KEY          # or api_key_file: /run/secrets/…
  body:                                    # merged into every request
    provider: {quantizations: [fp8, bf16], data_collection: deny}
models:
  - id: anthropic/claude-sonnet-5.5        # as the endpoint knows it
    name: sonnet-5.5                       # how a node picks it
    context: 1000000
    max_output: 32000                      # tokens of one response
    reasoning: true
    images: false
    cost: {input: 2, output: 10}           # dollars per million tokens
    sampling: {temperature: 0.7}           # sent with its requests
    body: {provider: {data_collection: deny}}   # replaces the endpoint's keys
default_model: sonnet-5.5
effort: "off"                    # off, minimal, low, medium, high, xhigh, max
tools:
  allowed: [read, grep, find, ls]          # bash, edit, write on purpose
  default: [read, grep, find, ls]
limits:
  default: {max_turns: 30, max_seconds: 10m, max_tokens: 500000, max_cost: 0.5}
  max: {max_turns: 80, max_seconds: 14m, max_tokens: 3000000, max_cost: 5}
system: |                        # added to pi's system prompt
  Answer in the language of the task.
skills: []                       # paths of pi skills to load
repos:                           # the repositories a step may work on
  - name: app
    url: git@git.example.com:team/app.git
    key_file: /run/secrets/app_deploy_key  # the deploy key, root's
    known_hosts: "git.example.com ssh-ed25519 AAAA…"   # checked out of band
    base: main                   # the default base branch
    branch_prefix: agent/        # a step commits under it
    protected: [release]         # never committed on (base never is)
    author: {name: gosidian agent, email: agent@example.com}
    max_files: 500               # a step that changed more commits nothing
    max_bytes: 20971520
    pr: {kind: gitea, api: https://git.example.com/api/v1, repo: team/app, token_file: /run/secrets/gitea_token}
mcp: [read]                      # gosidian's MCP a step may ask for: read, write
```

`effort` was `thinking` (deprecated, still read). A repository over SSH
needs its deploy key and the host keys it accepts (`known_hosts`, or
`known_hosts_file`); the key file belongs to root (uid 0) with mode 600,
since the server, root without `CAP_DAC_OVERRIDE`, reads it as its owner.
The plugin holds no credentials for HTTPS. `depth` limits the commits a
clone fetches (0, the default, is the whole history). Without `repos` the
node has no `repo`; without `mcp` its `mcp` is `none` only.

The choices of models, providers and routing are the preset's, that is of
whoever runs the plugin. A change of the preset changes the manifest:
`gosidian plugin show`, then `gosidian plugin accept`. The manifest asks
for `permissions.mcp` with the preset's `mcp`, and lists the repositories'
hosts in `permissions.network`.

## The node

`<agent>.run`, for example `pi-openrouter.run`. It keeps `agent-run/1`,
and adds settings of pi's own:

| Setting | Default | |
|---|---|---|
| `prompt` | required | the task |
| `system` | | instructions added to the system prompt |
| `system_mode` | `append` | `replace` puts them in place of pi's |
| `model` | the preset's | one of the preset's names |
| `effort` | the preset's | pi's thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; a model without reasoning ignores it |
| `files` | | a vault path or a list of them (`{{ trigger.files }}`), in `in/` |
| `access` | | `read` (read, grep, find, ls), `edit` (also edit, write), `exec` (also bash): the tools of the level the preset allows. A level of which the preset allows none of its own tools fails the node, naming them |
| `tools` | `access`'s, else the preset's default | pi's tools, a subset of the preset's allowed; with `access`, within its tools |
| `temperature` | the model's | |
| `max_output` | the model's | tokens of one response |
| `max_turns`, `max_seconds`, `max_tokens`, `max_cost` | the preset's | at most the preset's max |
| `json` | false | the answer is a JSON value |
| `schema` | | a JSON Schema the answer must follow |
| `json_retries` | 1 | turns to fix an answer that does not hold |
| `inline_files` | false | also put the text files in the prompt (256 KiB together at most): for a model that reads them badly with its tools |
| `repo` | | a repository of the preset: `name`, `base` (default the preset's), `branch` (default `<prefix><run>-<step>`, under the preset's prefix), `push` (true), `pr` (`true`, or `title` and `body`) |
| `mcp` | `none` | gosidian's MCP for the call: `read` or `write`, as the preset allows |
| `thinking` | | deprecated: `effort` |

With `repo`, the repository is in `repo/`, on the step's branch; the
agent edits its files (it needs `edit` or `exec`), and the plugin commits
what changed when the step ends well. The commit message is the preset's
name and the task's first line, the answer, and gosidian's project and
run. With `mcp`, gosidian's tools are pi's tools of the step, named
`mcp__gosidian__<tool>`.

Output: `text`, `json`, `model` (`name`, `id` as the endpoint knows it,
`endpoint`: its host), `stop` (`done`, or `length` if the last response
hit `max_output`), `turns`, `usage` (`input`, `output`, `cache_read`,
`cache_write`, `total_tokens`), `cost` (US dollars, which pi adds up at the
preset's prices) and `cost_source` (`agent`; `none` when the model has no
prices), `tools` (calls by tool), `executor` (`plugin`, `version`, `agent`:
`pi`, `agent_version`), with `repo` the repository's `name`, `base`,
`branch`, `commit`, `changed`, `insertions`, `deletions`, `pushed`,
`pr_url` (and a `note`), with `mcp` its `level` and `url`, `skipped`, and
from gosidian `files`. `usage.total_tokens` counts in the run's
`max_llm_tokens`. `usage.cost` is deprecated: `cost`.

The node's `timeout` (5 minutes by default) must cover `max_seconds`, and
with `repo` the clone and the push:

```yaml
- id: summary
  use: pi-openrouter.run
  with:
    prompt: "Riassumi le procedure in in/: per ognuna titolo, scopo e passi."
    files: "{{ trigger.files }}"
    schema:
      type: array
      items: {type: object, required: [title, purpose], properties: {title: {type: string}, purpose: {type: string}, steps: {type: array, items: {type: string}}}}
    max_cost: 0.2
  timeout: 14m

- id: fix
  use: pi-openrouter.run
  with:
    prompt: "Correggi i link rotti nella documentazione di docs/."
    access: edit
    repo: {name: app, pr: true}
    mcp: read
  timeout: 14m
```

## Environment

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | empty | the bearer token gosidian sends; empty: none |
| `PI_PRESET` | `/etc/gosidian-pi/preset.yaml` | the preset |
| `PI_WORKERS` | 1 | steps at once (at most 8 as root, a user each); the others wait |
| `PI_RUNS_DIR` | `/tmp/gosidian-pi` | the steps' folders |
| `PI_MAX_FILES_BYTES` | 256 MiB | the files of one step together |
| `PI_MAX_OUT_FILES`, `PI_MAX_OUT_BYTES` | 50, 50 MiB | the files given back |
| `PI_UID`, `PI_GID` | 10001 | the first slot's user, as root |
| `PORT` | 8000 | MCP at `/mcp`, `GET /health` without a token |

## Building and testing

```bash
docker build --build-arg VERSION=0.2.0 --build-context kit=agent-kit -t gosidian-pi:0.2.0 pi/
pi/scripts/test.sh                # types and tests in node:24-alpine, with git
pi/scripts/separation-test.sh     # the image as in production: users, secrets, links, leftovers, a repository, gosidian's MCP
```

`src/kit` links [agent-kit](../agent-kit), the code the agent plugins
share; the image copies it from the build context `kit`. The tests run the
real pi against a fake OpenAI-compatible endpoint, a fake of gosidian's
MCP and repositories on disk: no GPU, no key, git. The separation test
also starts a git server over SSH with a deploy key of its own. The image
is built for amd64.

## Licenses

MIT, like gosidian. pi and the other packages are under their own
licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

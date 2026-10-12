# gosidian-pi

A gosidian plugin whose node runs a [pi](https://pi.dev) agent: a model
that works in several turns with tools (read, grep, find, ls; bash, edit
and write when its preset allows them) on the files a pipeline hands it,
and answers with text or JSON, giving back the files it writes. For a task
of one call, gosidian's `llm.chat` is simpler.

**One container is one agent.** Its preset names the endpoint and its
key, the models a node may pick, the tools the agent may use and the limits
of a step. Two containers of the same image make two agents, say
`pi-locale` on a local GPU and `pi-openrouter`, registered in gosidian as
two plugins. The node decides the rest: the prompt, the system prompt, the
model among the preset's, the thinking level, the temperature, the files,
the limits within the preset's, and the JSON the answer must be.

## A step

1. gosidian calls `run` with the node's settings. Each file the node names
   comes by reference (`file_refs`), a list of them too (gosidian 2.85).
   The tokens the run may still spend come in the call's `_meta`.
2. The plugin makes a folder for the step: the files are fetched into
   `in/`, checked against their size and SHA-256; `out/` is empty.
3. It runs `pi --mode json` there, the prompt on its standard input, with
   no context files, extensions or MCP, offline, and a session of its own.
   It follows pi's events, and stops it at a limit:
   - `max_turns`;
   - `max_seconds`;
   - `max_tokens` (or the run's tokens, if fewer);
   - `max_cost` (dollars, from the preset's prices).
4. With `json` or `schema`, the answer is taken as JSON and checked. If it
   does not hold, the agent gets `json_retries` more turns in the same
   session, each saying what is wrong.
5. The files the agent wrote in `out/` go back to gosidian, which stores
   them as attachments; the folder is removed.

A step that stops at a limit, an endpoint that refuses, or an answer that
stays no valid JSON fails the node, with the reason: the node's `retry`
and `on_error` apply.

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
- **The network is the container's.** pi needs only the proxy; the server
  needs the endpoint and gosidian. With bash allowed, the container's
  network should reach nothing else.

```yaml
services:
  pi-openrouter:
    image: ghcr.io/daniele-chiappa/gosidian-pi:0.1.0
    restart: unless-stopped
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${PI_OPENROUTER_TOKEN:?}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:?}
    volumes:
      - ./pi-openrouter.yaml:/etc/gosidian-pi/preset.yaml:ro
    read_only: true
    tmpfs: ["/tmp:size=1g"]        # the steps' folders and files
    cap_drop: [ALL]
    cap_add: [SETUID, SETGID]      # to run pi as the slot's user
    security_opt: ["no-new-privileges:true"]
    mem_limit: 2g
```

Without root, the plugin still works, and says so at startup: pi then runs
as the server's user and its tools could read the key.

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
thinking: "off"                  # off, minimal, low, medium, high, xhigh, max
tools:
  allowed: [read, grep, find, ls]          # bash, edit, write on purpose
  default: [read, grep, find, ls]
limits:
  default: {max_turns: 30, max_seconds: 10m, max_tokens: 500000, max_cost: 0.5}
  max: {max_turns: 80, max_seconds: 14m, max_tokens: 3000000, max_cost: 5}
system: |                        # added to pi's system prompt
  Answer in the language of the task.
skills: []                       # paths of pi skills to load
```

The choices of models, providers and routing are the preset's, that is of
whoever runs the plugin. A change of the preset changes the manifest:
`gosidian plugin show`, then `gosidian plugin accept`.

## The node

`<agent>.run`, for example `pi-openrouter.run`:

| Setting | Default | |
|---|---|---|
| `prompt` | required | the task |
| `system` | | instructions added to the system prompt |
| `system_mode` | `append` | `replace` puts them in place of pi's |
| `model` | the preset's | one of the preset's names |
| `thinking` | the preset's | |
| `files` | | a vault path or a list of them (`{{ trigger.files }}`), in `in/` |
| `tools` | the preset's default | a subset of the preset's allowed |
| `temperature` | the model's | |
| `max_output` | the model's | tokens of one response |
| `max_turns`, `max_seconds`, `max_tokens`, `max_cost` | the preset's | at most the preset's max |
| `json` | false | the answer is a JSON value |
| `schema` | | a JSON Schema the answer must follow |
| `json_retries` | 1 | turns to fix an answer that does not hold |
| `inline_files` | false | also put the text files in the prompt (256 KiB together at most): for a model that reads them badly with its tools |

Output: `text`, `json`, `model`, `stop` (`done`, or `length` if the last
response hit `max_output`), `turns`, `tools` (calls by tool), `usage`
(`input`, `output`, `cache_read`, `cache_write`, `total_tokens`, `cost`),
`skipped`, and from gosidian `files`. `usage.total_tokens` counts in the
run's `max_llm_tokens`.

The node's `timeout` (5 minutes by default) must cover `max_seconds`:

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
docker build --build-arg VERSION=0.1.0 -t gosidian-pi:0.1.0 pi/
docker run --rm -v "$PWD/pi:/app" -w /app node:24-alpine sh -c 'npm ci --ignore-scripts && npm run check && npm test'
pi/scripts/separation-test.sh     # the image as in production: users, secrets, links, leftovers
```

The tests run the real pi against a fake OpenAI-compatible endpoint: no
GPU and no key. The image is built for amd64.

## Licenses

MIT, like gosidian. pi and the other packages are under their own
licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

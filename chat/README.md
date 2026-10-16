# gosidian-chat

Bots for [gosidian](https://github.com/daniele-chiappa/gosidian): a chat on
the documents of a project, as a widget any web page loads and as a page of
its own, answered by a pipeline of the project. A bot is a gosidian note
`type: chat`, whose ```` ```chat ```` block says which pipeline answers,
which scopes of the archive it opens, and who may chat (gosidian's
[`docs/chat.md`](https://github.com/daniele-chiappa/gosidian/blob/main/docs/chat.md)).
gosidian hands each bot to this plugin; the plugin serves its chat on the
internet and starts its pipeline on each message, with the bot's run token,
which starts that pipeline and nothing else.

```
page with the widget ─┐
bot's page (iframe)  ─┼─▶ gosidian-chat ──(run token)──▶ gosidian: the bot's pipeline
                      │   access, limits,                search, rerank, model,
                      │   conversations                  the conversation's note
```

gosidian need not be on the internet: only the plugin is.

## Running it

```yaml
services:
  gosidian-chat:
    image: ghcr.io/daniele-chiappa/gosidian-chat:0.2.0
    restart: unless-stopped
    read_only: true
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${CHAT_PLUGIN_TOKEN}   # gosidian's token for /mcp
      CHAT_PUBLIC_URL: https://chat.example.com     # its address on the internet
    ports: ["8095:8000"]
```

Then register it in gosidian's `config.toml`, with its token in a sealed
secret, and accept its manifest:

```toml
[[pipelines.plugins]]
name = "chat"
url = "http://gosidian-chat:8000/mcp"
token_secret = "chat-token"
```

```bash
gosidian plugin show chat
gosidian plugin accept chat <sha>
```

gosidian also needs `[pipelines] files_url`, the address the plugins
reach it at (the bots' pipelines start there), and its secrets
(`GOSIDIAN_SECRETS_KEY`). Behind a proxy that terminates TLS, set
`CHAT_TRUST_PROXY=true` so the limits count the clients' addresses.

| Variable | Default | |
|---|---|---|
| `CHAT_PUBLIC_URL` | (required) | the plugin's address on the internet: the widget's and the bots' pages start with it |
| `GOSIDIAN_PLUGIN_TOKEN` | none | gosidian's bearer token for `/mcp` |
| `CHAT_NAME` | `chat` | the name gosidian registers the plugin with |
| `CHAT_WAIT` | `60s` | how long a message waits for its answer (gosidian waits at most its `[pipelines] max_sync_wait`) |
| `CHAT_SESSION_TTL` | `1h` | a conversation is forgotten this long after its last message |
| `CHAT_MAX_SESSIONS` | `10000` | open conversations; the oldest go first |
| `CHAT_MAX_HISTORY` | `10` | the turns before a message the pipeline gets |
| `CHAT_PER_MINUTE`, `CHAT_PER_SESSION`, `CHAT_MAX_MESSAGE` | `10`, `200`, `2000` | a bot's limits when its note sets none: messages a minute and in a conversation, characters of a message |
| `CHAT_IP_PER_MINUTE` | `60` | messages a minute from one address, all bots together |
| `CHAT_TRUST_PROXY` | `false` | the client's address from `X-Forwarded-For` |
| `CHAT_FRAME_ANCESTORS` | none | origins, comma-separated, besides gosidian's public address that may frame the bots' pages: gosidian reached at another address (a tunnel, a second name) |

The plugin keeps nothing on disk: the bots and their secrets live in
memory, and gosidian hands them again every five minutes, so a restart
loses the bots for that long, and the open conversations.

## The widget

The bot's note, in gosidian, gives the code for a site:

```html
<div id="chat-docs"></div>
<script src="https://chat.example.com/chat.js" data-bot="docs"
        data-container="chat-docs" data-key="pk-…" async></script>
```

- `data-key` is a site's key, as the note's `access.keys` names it: the
  plugin takes it only from the key's `origins`. It is public, in the page.
- `data-token` is a token the site signed for its user, with the secret of
  the note's `access.signed`: a JWT (HS256) with `sub` (the user), `bot`,
  `exp`, and an `iss` of the site's own.
- Neither, for a bot with `access.open`.

The widget draws the chat in a shadow root of the container: the welcome,
the scopes to choose among those the bot opens (none chosen is all of
them), the answers with their sources and links, and a rating of each
(👍, 👎, or from -10 to 10 with a comment). It keeps the conversation's id
in the page's `sessionStorage`.

A flat list of scopes shows as boxes, several of which may be chosen.
Nested scopes, which gosidian makes of a folder's tree (the note's
`folders`), show as a select per level, named by `scope_labels`: the
folders under the bot's, then those of the one chosen; the deepest
chosen is the scope of the message.

`/embed/<bot>` is the bot's page, the chat on its own: gosidian shows it in
the bot's note, with a token it signs for the reader in the fragment
(`#token=…`), which no server sees. Only gosidian may frame it.

## The API

| Request | |
|---|---|
| `GET /api/bots/<bot>` | `title`, `welcome`, `scopes` (`name`, `label`, and `children` for nested ones), `scope_labels`, `max_message` |
| `POST /api/bots/<bot>/messages` | `{message, session, scopes}` → `{session, turn, answer}`: the answer is the output of the bot's pipeline (`text`, `sources`, each with its `url`); `session` empty opens a conversation; `scopes` names scopes at any depth, none is those of the first level |
| `POST /api/bots/<bot>/ratings` | `{session, turn, rating, comment}`: `turn` an answer of the conversation, `rating` from -10 to 10 |

A request carries `Authorization: Bearer <token>`, or `X-Chat-Key` from
one of the key's origins, or nothing where the bot is open. Refusals are
`403` with the reason, `429` with `Retry-After` over a limit, `502` when
the pipeline failed, `504` when it did not answer in time.

The pipeline gets the message as gosidian's `chat` trigger takes it
(`kind`, `message`, `history`, `scopes`, `session`, `user`), plus `bot`,
`note`, `filters` (the filters of the scopes chosen, in their order) and,
with the note's `limits.max_tokens`, `max_tokens`. The history is the
plugin's: a client cannot write the bot's turns.

## Security

- The plugin holds only the bots' run tokens: each starts its bot's
  pipeline, nothing else.
- A client chooses among the scopes the bot opens; it never sends a filter.
- The answers are escaped before they are marked; links are http(s) only.
- The bot's page has a Content-Security-Policy without inline scripts, and
  every other answer refuses to be framed.
- The system prompt of the bot's pipeline should say that the sources are
  data, not instructions: the plugin passes the text it gets.

## Building and testing

```bash
docker build -t gosidian-chat chat/
sh chat/scripts/test.sh     # Go: vet, gofmt, race; the widget: tsc, node --test
```

## Licenses

MIT. What the image holds besides: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

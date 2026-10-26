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
    image: ghcr.io/daniele-chiappa/gosidian-chat:0.4.1
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
| `CHAT_IMAGE_MAX_BYTES` | `10485760` | the bytes of one image of an answer |
| `CHAT_IMAGES_MAX_BYTES` | `268435456` | the images kept in memory, all together; the oldest go first |
| `CHAT_IMAGES_TTL` | `CHAT_SESSION_TTL` | how long an image of an answer is served |
| `CHAT_IMAGES_PER_CALL` | `40` | the images one call of the node `images` hands: those of an answer, the others and those of its sources |

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

With the note's `dates`, the chat offers a day: the answer is about the
documents as they were then. With `handoff`, a button asks for a person,
also after an answer that found nothing: a short form, with a contact
when the note wants one, hands the conversation on.

An answer's images show where its text marks them: a line `[img:n]` is
the image of `images` with that `n`, as wide as the answer. Those without
a number show under it; `more_images` fold under «Altre immagini». A
source with its `text`, the passage as the documentation has it, opens
with a click, its own `images` in place. Any image opens large with a
click; a click or Esc closes it.

The answer shows as the model writes it: the widget asks for
`text/event-stream`, and the text of the bot's pipeline (its `llm.chat`
nodes with `stream: true`, gosidian 2.111 or later) fills the bubble
until the answer, with its images and sources, takes its place. The
lines that are only a mark in brackets (`[img:3]`) wait for the answer.
An answer cut short (the connection lost, the time passed) keeps what
arrived, grey, with the reason and «Riprova», which asks again.

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
| `GET /api/bots/<bot>` | `title`, `welcome`, `scopes` (`name`, `label`, and `children` for nested ones), `scope_labels`, `max_message`, `handoff` (`label`, `contact`, or none), `dates` |
| `POST /api/bots/<bot>/messages` | `{message, session, scopes, as_of}` → `{session, turn, answer}`: the answer is the output of the bot's pipeline (`text`, with an image's `[img:n]` lines; `sources`, each with its `url`, and its `text` and `images` to open it; `images`, each with its `url`, `title` and `n`; `more_images`; `non_so`); `session` empty opens a conversation; `scopes` names scopes at any depth, none is those of the first level; `as_of`, a day (YYYY-MM-DD), for a bot with `dates`. With `Accept: text/event-stream`, events: `delta` (`{text}`, what the model wrote since the last one) and `reset` (`{}`: the text starts over), then `answer` (the JSON above) or `error` (`{status, error}`, the status a JSON answer would have had) |
| `POST /api/bots/<bot>/handoff` | `{session, message, contact}` → `{session, answer}`: the bot's pipeline gets the conversation (`kind: handoff`) and hands it on; one a minute per conversation |
| `GET /api/bots/<bot>/images/<id>` | an image of an answer, png, jpeg, gif or webp: its address is its key, without a token |
| `POST /api/bots/<bot>/ratings` | `{session, turn, rating, comment}`: `turn` an answer of the conversation, `rating` from -10 to 10 |

A request carries `Authorization: Bearer <token>`, or `X-Chat-Key` from
one of the key's origins, or nothing where the bot is open. Refusals are
`403` with the reason, `429` with `Retry-After` over a limit, `502` when
the pipeline failed, `504` when it did not answer in time.

The pipeline gets the message as gosidian's `chat` trigger takes it
(`kind`, `message`, `history`, `scopes`, `session`, `user`, `as_of`), plus
`bot`, `note`, `filters` (the filters of the scopes chosen, in their
order) and, with the note's `limits.max_tokens`, `max_tokens`. The history
is the plugin's: a client cannot write the bot's turns.

## The node images

A bot's pipeline shows images with its answer through the node
`<plugin>.images` (`chat.images`): `bot` and `images`, vault paths of
png, jpeg, gif or webp files, which gosidian hands by reference. The
plugin fetches each one, checks its size, its SHA-256 and its type by its
bytes, keeps it in memory and gives `images` (`url`, `name`, `mime`,
`size`) and `skipped` (`name`, `error`); the same image handed again
keeps its address, and one copy. The pipeline puts the addresses in its
answer, as `images` (`url`, `title`, `n`), `more_images` and the
`images` of its sources: the widget's page cannot read gosidian's files,
the plugin's address it can.

```yaml
- id: show
  use: chat.images
  with: {bot: "{{ trigger.bot }}", images: ["documents/manual/Setup_img/menu.png"]}
```

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

# gosidian-notify

A gosidian plugin that tells people what a pipeline did, and asks them
what it should do next. Its nodes:

- **`send`** notifies people, groups and rooms of the preset on their
  channels: a Telegram chat or a topic of a Telegram group, an ntfy topic,
  an email address; with an image of the project, if given (a preview's
  screenshot): a photo on Telegram, an attachment on ntfy and by email;
- **`ask`** puts a choice of 2 to 4 to people (or to a room, where its
  approvers answer), with Telegram's buttons or a link to the plugin's
  reply page, and POSTs the first valid answer to the run's
  `{{ run.resume_url }}`, where a `wait.call` node waits for it;
- **`cancel`** withdraws a question decided elsewhere.

**A node names destinations, never an address.** Whoever installs the
plugin writes the people (with their Telegram user id, ntfy topic, email
address), the groups of people and the rooms in the preset; a node gives
their names (`alice`, `@ops`, `#team/agents`), and a name the preset does
not have is refused before anything is sent. An agent, or a note an agent
wrote, cannot send a message out of the preset or move someone's
notifications, and the addresses stay out of the vault.

The text is plain on every channel (no HTML or markdown interpreted), cut
to each channel's length. In a person's or a room's quiet hours, `low` and
`normal` wait and go as one digest; the same `key` within a window is
counted, not sent again; each person, room and channel has a cap of
messages an hour.

Nextcloud, free-text answers, attachments other than one image and a
self-hosted chat are not here: the channels are one interface
(`src/channels/channel.ts`), and they come later.

## The pipeline

An agent opens a PR, a preview publishes it and tries it, `ask` puts the
question in the team's `agents` topic with the check's screenshot, and only
"approve" merges:

```yaml
nodes:
  - id: ask
    use: notify.ask
    with:
      to: ["#team/agents"]
      approvers: [alice]
      title: "The pilot's PR is ready"
      text: "{{ summary.text }}"
      link: "{{ publish.url }}"
      image: "{{ check.files.0.path }}"     # preview.check's screenshot, an attachment of the project
      choices: [approve, redo, discard]
      resume_url: "{{ run.resume_url }}"
      expires: 24h
  - id: answer
    use: wait.call
    with: {timeout: 24h}
  - id: merge
    use: exec.run
    when: "{{ answer.choices.approve }}"
    with: {…}
```

A pipeline that tells the team a run failed (with gosidian's `on: run`
trigger):

```yaml
nodes:
  - id: tell
    use: notify.send
    with:
      to: ["#team/errors"]
      title: "{{ trigger.pipeline }} failed"
      text: "{{ trigger.failed_step }}: {{ trigger.error }}"
      priority: high
      key: "{{ trigger.pipeline }}"
```

## The nodes

`<plugin>.send`, for example `notify.send`:

| Setting | Default | |
|---|---|---|
| `to` | | a name or a list (1 to 50): people (`alice`), groups (`@ops`), rooms (`#team`) and their topics (`#team/agents`) of the preset |
| `title` | | plain text on one line, cut at `limits.title` (200) |
| `text` | | plain text, cut at each channel's length: a title, a text or both |
| `link` | | an http(s) address, without credentials |
| `note` | | a note of the project (relative to it, or its vault path): its address in gosidian's web UI, `<gosidian_url>/notes/<project>/<path>.md`. `link` or `note`, not both |
| `priority` | `normal` | `low` (silent on Telegram), `normal`, `high`, `urgent` |
| `key` | | the same key to the same destination within `group_window` (10 minutes) is counted, not sent again |
| `channels` | all | only these of each destination's channels: `telegram`, `ntfy`, `email` |
| `image` | | one image of the project, a vault path (an attachment: `{{ check.files.0.path }}`), which gosidian hands by reference: PNG, JPEG, WebP or GIF by its first bytes, at most `limits.image` (8 MiB). See [An image](#an-image) |
| `require` | `any` | `any`: the node fails only when nothing went (every channel failed); `all`: when a channel failed |

Output: `id`; `ok`, nothing failed; `sent`, one entry per destination and
channel, `{to, channel, status, error}`, `status` being `sent`, `held`
(quiet hours), `grouped` (its key's window) or `failed` (with the error);
`counts` of each status. A destination with none of the node's channels is
one entry with `channel: null`, failed. A group is its people, each once.
With an image, a `sent` or `held` entry says what became of it: `image` is
`sent` (with the message), `dropped` (the message went, or will, without
it; `note` says why) or `held` (kept for when the held question goes).

`<plugin>.ask` takes `to`, `title`, `text`, `link`, `note`, `priority`,
`channels`, `image` and `require` as `send` does (not `key`), and:

| Setting | Default | |
|---|---|---|
| `choices` | | 2 to 4 labels, different, the first the positive one |
| `resume_url` | | `{{ run.resume_url }}`: gosidian's resume address of the call's run, at the preset's `gosidian_url` or `gosidian_api` (or a path); any other is refused |
| `approvers` | the people of `to` | who may answer: people or groups of the preset. A question to rooms only needs them |
| `expires` | `limits.expires` (24h) | how long it waits, at most `limits.max_expires` (7d): give the `wait.call`'s timeout |

Output: `id` (for `cancel`), `ok`, `sent`, `counts` as for `send`;
`expires_at`; `approvers`; `can_answer`, the approvers with a way to
answer. A question no approver can answer is refused: an approver needs
Telegram's buttons (their user id in the preset, and their own chat or a
room on Telegram) or a link of their own (their ntfy or email, and the
plugin's `public_url`).

What each destination gets:

- **Telegram**: the question with a button per choice, in a person's chat
  and in a room's topic. A press counts only from a person the question
  allows, recognized by the user id Telegram gives with the press (no one
  can send another's); the others get an alert, "You cannot answer this
  question". Once decided, the buttons become one, the outcome
  (`approve: alice`), on every message of the question;
- **ntfy and email**, to a person who may answer: a link to the reply page
  with a token of their own (the action Answer on ntfy, a line on email);
- **a room on ntfy or email**, and a person in `to` who is not an
  approver: the question, no link.

The first valid answer decides. The plugin POSTs to `resume_url`:

```json
{"choice": "approve", "choices": {"approve": true, "reject": false}, "by": "alice", "channel": "telegram", "at": "2026-10-20T09:12:44.000Z"}
```

`channel` is `telegram` or `page` (the reply page, reached from ntfy or
email); `by` is the person's name in the preset. `{{ answer.choices.approve }}`
is a boolean for `when`. Every later answer finds "Already decided by alice:
approve". gosidian answering 409 (the `wait.call` is not waiting yet) or
not answering: the plugin tries again, at 2, 4, 8… seconds (at most 5
minutes apart), until the question's wait is over; 404 (the run no longer
waits) or another 4xx: it stops, and says so in its log.

`<plugin>.cancel`: `id` → `{canceled, status}`. An open question of the
project is withdrawn: its links show "This question was withdrawn", its
buttons "Withdrawn". A question decided, expired or already withdrawn says
so (`canceled: false`); one of another project is as one that is not there
(`status: unknown`).

**The project.** Every call carries `gosidian/project` in its `_meta`, and
only gosidian holds the plugin's token: a question keeps its project, and
only its project withdraws it; a `key` groups within its project. A call
without a project is refused.

## An image

`image` names one file of the project, as a pipeline names a file for a
plugin: a vault path, an attachment (preview's screenshots come back as
attachments, `{{ check.files.0.path }}`). The manifest asks for
`permissions.files`, and its `send` and `ask` take `image` by reference
(`file_refs`): gosidian hands the plugin `{name, mime, size, sha256, url}`,
the url a ticket of gosidian's, valid while the step may run. Without
`image` (left out, or null), nothing is fetched; an empty path is gosidian's
to refuse.

- **From gosidian only.** The url must have the origin of the preset's
  `gosidian_url` or `gosidian_api` and be a ticket's
  (`/api/v1/run-files/<ticket>`); the plugin fetches that ticket at
  `gosidian_api`, whatever origin of gosidian's the url names, never
  another host or another address, without following a redirect. The
  plugin's `files_url` in gosidian should then be `gosidian_api`
  (`http://gosidian:8080` on the network of a compose file, gosidian's
  `[pipelines] files_url` by default).
- **Checked.** At most `limits.image` (8 MiB; a size from 1 KiB to 50 MB),
  refused before it is fetched when gosidian says it is bigger, and
  stopped when more comes; the size and the SHA-256 gosidian gave; a PNG,
  JPEG, WebP or GIF **by its first bytes**, whatever its name or MIME type
  say (an SVG, a PDF, a page are refused). The name it goes with is the
  file's, plain ASCII, its extension the one its bytes say.
- **Refused, the node fails** before anything is sent: a file that is not
  one of those images, one too big, one whose size or SHA-256 differs, a
  url not of gosidian's, a ticket gone (404: a node that sends an image
  after the step's time).

What each channel does with it:

- **Telegram**: a photo, its bytes uploaded (`sendPhoto`, multipart: never
  an address Telegram would fetch), in the person's chat or the room's
  topic. When the whole text (title, text, link, the reply page's line)
  fits a caption, 1024 characters, it is one message: the photo, the text
  its caption, and a question's buttons under it. A longer text: the photo
  with the title as its caption (silent), then the text as without an
  image, with the buttons. The buttons, and the outcome they become
  (`editMessageReplyMarkup`, which changes a photo's as a text's), are
  always on the message with the whole text. A GIF goes as a file
  (`sendDocument`, which Telegram shows moving), and so does a photo
  Telegram does not take as one (more than 10 MB, or sides too long, as a
  full page's screenshot can have). An image Telegram takes in no way (a
  group where the bot may not send media): the message goes without it,
  `image: dropped` and Telegram's error in `note`.
- **ntfy**: an attachment, a `PUT` to the topic with the bytes and the
  name (`X-Filename`), the message's title, text, priority, tags, click and
  actions in headers (RFC 2047, so UTF-8 passes). The server keeps
  attachments only with an `attachment-cache-dir` (and a `base-url`); a
  server without, or one that finds it too big (413): the message goes
  without it, `image: dropped`, `note` saying why, and a server without
  attachments is not sent one again for an hour. The posts stay one at a
  time.
- **Email**: an attachment (`multipart/mixed`): the `text/plain` part as
  without an image, then the image, its bytes given to nodemailer (no path,
  no address). No HTML part. A server that refuses the size (552, or past
  the `SIZE` it announces): the message without it, said.

**Quiet hours, the digest, grouping.** A question held in quiet hours keeps
its image **on the volume** (`images/<sha256>`, mode 600), since gosidian's
ticket does not last the night: when the quiet hours end it goes with its
image, and the image is removed once no held question needs it (sent,
decided, expired or withdrawn). A `send` held goes in the digest, which
**carries no image**: its line says `[image]` (`strings.image`), and its
entry says `image: dropped`. The count of a grouped key goes as text too,
without the image.

## The reply page

On a port of its own (8080), apart from MCP (8000):

- `GET /r/<token>` shows the question, its link, who answers ("Answering
  as alice") and a button per choice. **It decides nothing**: mail
  scanners and link previews open the links they find. `POST /r/<token>`
  with `choice=<index>` decides;
- a token is 128 random bits, one per person and question, kept as its
  SHA-256 only; it works once (the question is then decided) and dies with
  the question's wait, or when it is withdrawn. A question closed is kept a
  day, for its page to say how it ended (decided by whom, expired,
  withdrawn), then forgotten: its links then are as any unknown one, a 404;
- every answer is `Cache-Control: no-store`, `X-Robots-Tag: noindex,
  nofollow, noarchive`, `Referrer-Policy: no-referrer` (the token is in the
  address), `X-Frame-Options: DENY`, and
  `Content-Security-Policy: default-src 'none'; style-src 'sha256-…';
  img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri
  'none'`: no script at all, the one style by its hash;
- `/robots.txt` disallows everything; `/health` answers `{"status":
  "ok"}`; anything else is a 404. There is no index and no listing.

The page's texts are the preset's `strings`, English by default.

## Quiet hours, grouping, caps

- **Quiet hours** (`quiet: "22:00-07:00"`) belong to a person or a room, in
  the preset's `time_zone` (default UTC), whatever the container's. In
  them, `low` and `normal` are held (`held`), and `high` and `urgent` go;
  a question waits too, unless it is `urgent`. When they end, the held
  messages go as **one digest a channel**: "3 notifications while quiet",
  each with its time, title, first lines and link, as many as fit, then
  "… and N more" (no image: a notice that had one says `[image]`); then
  each held question still open, with its buttons or its link, and its
  image. Past `limits.held` (100) held for a destination, the oldest
  goes, and the digest counts it.
- **Grouping**: `send` with a `key`, to a destination that got the same key
  within `group_window`, is `grouped`: counted, not sent. When the window
  ends, one message says how many came, with the last one's text: "Disk
  full (+3)". A key held in quiet hours counts on the one held.
- **Caps**: `limits.per_hour` messages an hour for a person (30), a room
  (60, its topics together) and a channel (300, all of it); past one, the
  entry is `failed`, "over the cap of 30 messages an hour for alice". A
  send that failed does not count. The digests and the counts of the
  grouping are not held back by the caps.
- **Lengths**: `limits.title` characters for a title, `limits.text` for
  the text on each channel (Telegram 4000 characters, ntfy 3500 bytes,
  email 20000 characters); the link and the reply page's line are never
  cut, the text is.

The held messages, the open windows, the counts, the open questions and
the answers still to hand gosidian are in `state.json` in the volume
(mode 600), the images of the held questions beside it (`images/`): a
restart loses none of them.

## The channels

### Telegram

One bot, made with BotFather; its token in a file (`token_file`). The
plugin calls the Bot API over HTTPS with no SDK, and sets no `parse_mode`:
the text is shown as it is.

- **A person** is their user id (`telegram: 123456789`): the bot writes to
  their private chat, which **they open first** (a message to the bot, or
  /start): a bot cannot start a conversation. The same id is who they are
  when they press a button in a group.
- **A room** is a supergroup with topics (`chat: -100…`): `#team` writes
  to its General topic, `#team/agents` to the topic the preset maps
  (`topics: {agents: 15}`, the `message_thread_id`, which is the number at
  the end of a topic's link). A topic has one level: a group a project
  with a topic a theme, or a group for several projects with topics named
  "project · theme".
- **`auto_topics: true`**: a topic a node names that the room does not map
  (`#team/errors`) is made the first time (`createForumTopic`) and its id
  kept in the volume. The bot must be an **admin with the right to manage
  topics**. The name is made plain, at most 128 characters; the group is
  always the preset's, so a pipeline at most opens a topic in it. Past
  `max_auto_topics` (50) made by the bot, a new topic goes to General with
  its name in brackets; a topic made by the bot and deleted in the group is
  made again.
- **The buttons**: the plugin takes the bot's updates with `getUpdates`
  (long polling), so nothing is exposed. **A bot has one consumer of its
  updates**: two plugins with the same bot (a lab and production) take each
  other's presses, and Telegram answers one of them 409: use a bot for
  each. A webhook set on the bot stops `getUpdates` too. With `poll:
  false`, a question has the reply page's link on Telegram instead.
- **Who writes to the bot** is logged with its ids (user id, chat id, the
  group's title, the topic's id), never the text: how to find a person's
  user id and a group's chat id. Adding the bot to a group is logged too;
  in a group with privacy mode on, the bot sees only the commands sent to
  it.
- **An image** is a photo, uploaded, the text its caption when it fits
  1024 characters, else after it ([An image](#an-image)); the bot needs the
  right to send media in a group.
- Telegram's groups are **not end-to-end encrypted**: what the bot writes
  goes through Telegram's servers. A notification should say what happened
  and link to it, not carry the content of private documents (nor their
  screenshots).

### ntfy

A server (`server: https://ntfy.example.com`) and an access token
(`token_file`, `tk_…`) that may write the topics. A person's topic
(`ntfy: alice-notify`), a room's (`ntfy: team-alerts`, or
`{topic: team-alerts, topics: {errors: team-errors}}`); a room's topic
with no ntfy topic of its own goes to the room's, tagged with its name.
The message is plain, its priority ntfy's own (low 2, normal 3, high 4,
urgent 5), a link opens on a tap, and a question's link is the action
Answer. With a server of your own, access control on
(`auth-default-access: deny-all`) and a token: whoever knows a topic of a
public server reads it.

The plugin posts one message at a time: ntfy 2.28 answers some of a
token's concurrent posts 403, as if the token were not valid.

**An image** is an attachment, which the server keeps only with
`attachment-cache-dir` and `base-url` set (and within its
`attachment-file-size-limit`, 15 MB by default); without them the message
goes without it, said in `sent[]` ([An image](#an-image)). The phone gets
the attachment's address on the ntfy server: whoever has it opens it until
it expires (`attachment-expiry-duration`, 3 hours by default).

**iOS**: a self-hosted server reaches an iPhone through Apple's push, which
ntfy's app gets from ntfy.sh: set `upstream-base-url: "https://ntfy.sh"` on
your server. ntfy.sh then gets a wake-up signal (the topic's hash), not
the message.

### Email

The preset's SMTP server (`host`, `port`), STARTTLS required by default
(`security: starttls`; `tls` on 465; `none` only for a relay on the LAN),
the user and the password in files, `from`. One `text/plain` message per
destination, UTF-8, with `Auto-Submitted: auto-generated`; `high` and
`urgent` add `X-Priority: 1` and a label in the subject. nodemailer writes
and sends it, with no access to files or addresses of a message. An image
is an attachment beside the text ([An image](#an-image)).

## Security

- **The destinations are the preset's.** A node never gives an address, a
  chat id or a topic id: names only, checked before anything goes. The
  Telegram group of a room is the preset's; `auto_topics` at most opens a
  topic in it.
- **The text is plain, its length cut**, its control characters and the
  characters that reorder a line (bidi overrides) taken out. The text often
  comes from agents: plain text, fixed destinations and a cap an hour limit
  what a prompt injection can make the plugin say, and to whom.
- **The credentials** (the bot's token, ntfy's token, the SMTP password)
  are files the preset names, read at start (a missing or empty one stops
  it, saying which). They are in no output, error, log line or `_meta`:
  every text that leaves the plugin is redacted, and so is the key of a
  resume address. gosidian never sees them.
- **The network**: the manifest's `permissions.network` lists the hosts the
  plugin calls (Telegram's API, the ntfy server, the SMTP server,
  gosidian's `gosidian_api`), and it calls no other: a `link` is text, an
  answer goes only to a `resume_url` of gosidian's, an image is fetched
  only from gosidian's tickets at `gosidian_api`. The container enforces
  it: give it a network that reaches those only.
- **The files**: the manifest asks for `permissions.files`, for `image`
  only: one file of the pipeline's project, which gosidian hands by
  reference; the plugin never sees the vault. Its ticket is a key, like the
  resume key: in no output, error or log line, nor in the state; what is
  kept of an image is its name, type, size and SHA-256 (and, for a held
  question, its bytes in `images/`).
- **An answer is a person's**: on Telegram by the user id Telegram gives,
  on the page by a token that only that person got. A page reachable from
  outside the LAN is as exposed as whoever installs makes it: **the token
  is the key**. It is 128 random bits, works once and expires with the
  question.
- **The image** runs as the user node (1000), with no capability, on a
  read-only root; it adds nothing to `node:24-alpine` but tini, and runs no
  process but its server.

The separation test runs it so, on a network with no way out, beside a
real ntfy (without attachments) and Mailpit and fakes of Telegram and
gosidian, and checks: destinations not in the preset refused, no request
to a host outside the preset (a link given, a `resume_url` or an image's
url of another host), an image as a photo with the buttons on it, as an
attachment by email, without it on that ntfy and said so, a file that is
not an image refused, a GET that decides nothing, a press of someone not
allowed that counts for nothing, the answer at `resume_url` once, no
credential, resume key, token of the page or file ticket in any output, in
the log or in the state (the tokens as hashes, the resume key only where
the answer goes), the state mode 600, only tini and the server running, no
capability, the root read-only.

## The preset

`/etc/gosidian-notify/preset.yaml` (`NOTIFY_PRESET`); there is no default:
the plugin has no one to notify without one. Every field is in
[presets/notify.yaml](presets/notify.yaml):

```yaml
name: notify
public_url: http://notify.lan:8086        # the reply page; else NOTIFY_PUBLIC_URL
gosidian_url: https://gosidian.example.com # notes' links; resume_url's host
gosidian_api: http://gosidian:8080         # where the answers go; default gosidian_url
time_zone: Europe/Rome                     # of the quiet hours; default UTC
channels:
  telegram: {token_file: /run/secrets/telegram-bot-token}
  ntfy: {server: "https://ntfy.example.com", token_file: /run/secrets/ntfy-token}
  email: {host: smtp.example.com, port: 587, user_file: /run/secrets/smtp-user, password_file: /run/secrets/smtp-password, from: "gosidian <notify@example.com>"}
people:
  alice: {telegram: 123456789, ntfy: alice-notify, email: alice@example.com, quiet: "22:00-07:00"}
  bob: {email: bob@example.com}
groups:
  ops: [alice, bob]
rooms:
  team:
    telegram: {chat: -1001234567890, topics: {agents: 15, releases: 12}, auto_topics: true}
    ntfy: team-alerts
limits: {title: 200, text: {telegram: 4000, ntfy: 3500, email: 20000}, per_hour: {person: 30, room: 60, channel: 300}, group_window: 10m, expires: 24h, max_expires: 7d, held: 100, image: 8MiB}
strings: {lang: en}                        # the texts people read
```

The preset is checked at start: a person or a room with a channel the
preset does not configure, a group with someone who is not a person, a
topic's name with `/` or `#`, a time zone that is not one, hours that are
not `HH:MM-HH:MM`. Its people, groups, rooms and channels are in the
manifest (the names in `to`'s description, the hosts in its network): a
change of the preset asks gosidian for a new accept (`gosidian plugin
show`, then `gosidian plugin accept`).

## Running it

```yaml
services:
  notify:
    image: ghcr.io/daniele-chiappa/gosidian-notify:0.2.0
    restart: unless-stopped
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${NOTIFY_TOKEN:?}
      NOTIFY_PUBLIC_URL: http://notify.lan:8086   # what the phones reach: the port below
    ports:
      - "8086:8080"               # the reply page (bind it to a LAN address, or put a proxy before it)
    # 8000 (MCP) stays on the network gosidian is on
    volumes:
      - notify-state:/var/lib/gosidian-notify
      - ./notify.yaml:/etc/gosidian-notify/preset.yaml:ro
      - ./secrets/notify:/run/secrets:ro            # telegram-bot-token, ntfy-token, smtp-user, smtp-password
    read_only: true
    tmpfs: ["/tmp"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 256m
    pids_limit: 128
volumes:
  notify-state:
```

```toml
[[pipelines.plugins]]
name = "notify"
url = "http://notify:8000/mcp"
token_secret = "notify-token"
files_url = "http://gosidian:8080"   # the images' tickets: gosidian_api's origin; default [pipelines] files_url
```

The secret files must be readable by the user node (1000): `chmod 444`, or
owned by 1000 with mode 400. The volume is the user's: a named volume takes
it from the image; a folder of the host needs `chown 1000:1000`. The
plugin must reach `gosidian_api` (on the network of a compose file,
`http://gosidian:8080`) to hand gosidian the answers, and gosidian's
`resume_url` must have the origin of `gosidian_url` or `gosidian_api`
(gosidian's `[pipelines] public_url`, or a path when it has none); so must
the url of an image's ticket (the plugin's `files_url` in gosidian, else
`[pipelines] files_url`), which the plugin fetches at `gosidian_api`.
0.2.0 reads files: its manifest asks for a new accept (`gosidian plugin
show notify` says `Reads files: yes`, and `files in image, by reference`
for `send` and `ask`).

## Environment

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | empty | the bearer token gosidian sends; empty: none |
| `NOTIFY_PRESET` | `/etc/gosidian-notify/preset.yaml` | the preset |
| `NOTIFY_PUBLIC_URL` | | the reply page's address, when the preset has no `public_url` |
| `NOTIFY_HTTP_PORT` | 8080 | the reply page, `/r/<token>` and `/health` |
| `PORT` | 8000 | MCP at `/mcp`, `GET /health` without a token |

## Building and testing

```bash
docker build --build-arg VERSION=0.2.0 -t gosidian-notify:0.2.0 notify/
notify/scripts/test.sh              # types and tests in node:24-alpine, beside a real ntfy and a Mailpit
notify/scripts/separation-test.sh   # the image as in production, on a network with no way out
```

The tests fake the Telegram Bot API (with its long polling and its
uploads) and gosidian (its resume address and its file tickets), and run
the channels against an ntfy server (`binwiederhier/ntfy:v2.28.0`, deny-all
and a token, attachments on) and a Mailpit (`axllent/mailpit:v1.31.4`, a
user and a password) in containers, or a small SMTP server of their own
(`NOTIFY_TEST_NO_SERVICES=1` skips the containers and their tests). The
image (about 280 MB) is built for amd64.

## Licenses

MIT, like gosidian. The packages in the image are under their own
licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

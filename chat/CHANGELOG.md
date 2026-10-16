# Changelog: gosidian-chat

The changes of the `chat` plugin, newest first. A tag `chat/vX.Y.Z`
publishes `ghcr.io/daniele-chiappa/gosidian-chat:X.Y.Z`, and its release
notes are its section here.

## [0.4.0] — 2026-10-17

Images in place in an answer, and the bots back at once after a restart.
A bot's pipeline marks where an image goes with a line `[img:n]`
(gosidian 2.94 numbers the images of a section, `note.sections` with
`media_numbers`); gosidian 2.94 asks `chat_bots`, and with 2.93 the bots
come back within five minutes as before. The manifest changes (the tool
`chat_bots`), and the owner accepts it again.

### Added
- **Images in place**: a line `[img:n]` of an
  answer shows the image of `images` with that `n` there, as wide as the
  answer; `more_images` fold under «Altre immagini»; a source with its
  `text` opens with a click, its `images` in place. Any image opens large
  with a click, and closes with a click or Esc. Headings show bold, and a
  numbered list an image broke goes on with its numbers.
- `chat_bots` (read): the bots the plugin has, and when it started.
  gosidian 2.94 asks it every 30 seconds, and hands the bots again at once
  after a restart instead of up to five minutes later.
- `CHAT_IMAGES_PER_CALL` (40): the images one call of the node `images`
  hands; it was a constant of 20.

### Changed
- The same image handed again keeps its address and one copy in memory,
  kept for another `CHAT_IMAGES_TTL`: the screenshots of a section come
  back with each answer that cites it.

## [0.3.0] — 2026-10-16

Images in an answer, a person and a day. The button for a person and the
day follow the bot's note in gosidian 2.93 (`handoff`, `dates`); with
gosidian 2.92 the chat works as before, without them.

### Added
- **Images in an answer**: the node `images` (tool `chat_images`) takes
  images by reference from a bot's pipeline, checks them (size, SHA-256,
  png, jpeg, gif or webp by their bytes) and serves them at
  `/api/bots/<bot>/images/<id>`, a random address, for as long as
  `CHAT_IMAGES_TTL`; `CHAT_IMAGE_MAX_BYTES` and `CHAT_IMAGES_MAX_BYTES`
  cap them. The widget shows them under the answer.
- **A person** (gosidian 2.93, the note's `handoff`): a button in the
  widget, also after an answer that found nothing, and
  `POST /api/bots/<bot>/handoff` (`message`, `contact`), which starts the
  bot's pipeline with `kind: handoff` and the conversation.
- **A day** (the note's `dates`): a field in the widget, `as_of` in a
  message, passed to the pipeline.

### Changed
- Scopes nest up to six levels (they did three), as gosidian's
  `folders.levels`.
- The widget folds the scopes and the day under a line that says what is
  chosen, and takes the plugin's images from where its script came from
  (a tunnel, a LAN address), not from `CHAT_PUBLIC_URL`.

### Fixed
- The widget sends a message without a `<form>`, on a click or Enter: in
  a frame sandboxed without `allow-forms`, as gosidian's note of a bot
  frames it, the browser dropped the submit and nothing was sent.

## [0.2.0] — 2026-10-16

The scopes of a bot may nest: gosidian 2.92 makes them of a folder's tree
(a note's `folders`). A bot with a flat list of scopes works as before,
with gosidian 2.91 too.

### Added
- **Nested scopes** (gosidian's scopes from folders): a scope may have
  `children`, at most three levels deep, and `chat_configure` takes
  `scope_labels`, what the chat calls each level. The API gives the tree
  (without the filters) and `scope_labels`; a message names a scope at any
  depth. The widget shows nested scopes as a select per level, a flat
  list as boxes as before.

## [0.1.0] — 2026-10-16

The first version: the bots of gosidian's notes `type: chat` (gosidian
2.91), as a widget for any page and as a page of their own.

### Added
- **The tools `chat_configure` and `chat_remove`**, which gosidian calls
  for its notes `type: chat`: a bot, its scopes, who may chat, its limits
  and the run token of its pipeline. The bots live in memory, their
  secrets with them; gosidian hands them again every five minutes.
- **The API of a bot**: its title and scopes (`GET /api/bots/<bot>`), a
  message (`POST /api/bots/<bot>/messages`), which starts the bot's
  pipeline and gives back its answer, its sources with their links, and
  the turn's id, and a rating of an answer from -10 to 10, with a comment
  (`POST /api/bots/<bot>/ratings`).
- **Who may chat**: gosidian's users with the token gosidian signs, a
  site's users with a token the site signs (JWT, HS256), the pages of a
  site with its key from its origins (CORS), or anyone.
- **Conversations** kept by the plugin, not by the page: the pipeline
  gets the turns before (`CHAT_MAX_HISTORY`), and a rating names an answer
  of the same conversation. A conversation is its owner's: another token,
  key or address naming it gets a new one.
- **Limits**: messages a minute and in a conversation, characters of a
  message (the bot's `limits`, else `CHAT_PER_MINUTE`, `CHAT_PER_SESSION`,
  `CHAT_MAX_MESSAGE`), and messages a minute of one address
  (`CHAT_IP_PER_MINUTE`).
- **The widget** `chat.js`, without a framework, in a shadow root: the
  answers escaped and then marked (bold, code, lists, http links,
  citations), the sources, the scopes to choose, the ratings (👍, 👎, or
  from -10 to 10 with a comment), light and dark.
- **A page per bot**, `/embed/<bot>`, which gosidian shows in the bot's
  note: the token in its fragment, a strict Content-Security-Policy, and
  only gosidian may frame it, at its public address and at those
  `CHAT_FRAME_ANCESTORS` adds.

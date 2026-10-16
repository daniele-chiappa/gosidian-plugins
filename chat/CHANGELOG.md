# Changelog: gosidian-chat

The changes of the `chat` plugin, newest first. A tag `chat/vX.Y.Z`
publishes `ghcr.io/daniele-chiappa/gosidian-chat:X.Y.Z`, and its release
notes are its section here.

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

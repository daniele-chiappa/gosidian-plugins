# Changelog: gosidian-notify

The changes of the `notify` plugin, newest first. A tag `notify/vX.Y.Z`
publishes `ghcr.io/daniele-chiappa/gosidian-notify:X.Y.Z`, and its release
notes are its section here.

## [0.1.0] — 2026-10-20

The first release: notifications to the people, groups and rooms of the
preset on Telegram, ntfy and email, and the answer to a question, from a
phone, back to the run that waits for it.

### Added
- **The preset**: the people (a Telegram user id, an ntfy topic, an email
  address, quiet hours), the groups of people (`@ops`), the rooms (a
  Telegram supergroup and its topics, `auto_topics`; an ntfy topic, with a
  topic of its own for some of the room's; an email address; quiet hours);
  the channels, their credentials in files; `time_zone` (default UTC);
  `public_url` (or `NOTIFY_PUBLIC_URL`), `gosidian_url` and `gosidian_api`;
  `limits` (the lengths, the messages an hour, the grouping window, a
  question's wait, the held messages); `strings`, the texts people read
  (English by default). A node names destinations of the preset only: an
  unknown name, an address, a chat id is refused before anything goes.
- **The node `send`**: `to`, `title`, `text` (plain, cut to each channel's
  length), `link` or `note` (a link to gosidian's web UI), `priority`,
  `key`, `channels`, `require`. Output: per destination and channel,
  `sent`, `held`, `grouped` or `failed` with the error. In quiet hours (in
  the preset's time zone) `low` and `normal` are held and go as one digest
  a channel when they end, `high` and `urgent` go; the same key within
  `group_window` is counted, and the count goes at the window's end; caps
  an hour for a person, a room and a channel.
- **The node `ask`**: 2 to 4 `choices`, `resume_url`, `approvers`,
  `expires`. Telegram's inline buttons, a press counted only from the
  people allowed (by their user id; the others get "You cannot answer
  this question"), the buttons turned into the outcome; on ntfy and email,
  a link to the reply page with a token of the person's own (128 bits,
  single use, kept as a hash, dead with the wait). The first valid answer
  is POSTed to `resume_url` as `{choice, choices, by, channel, at}`, again
  while gosidian does not take it; a second answer finds it decided.
- **The node `cancel`**: withdraws an open question of the project.
- **The reply page**, on a port of its own (8080): `GET /r/<token>` shows,
  only `POST` decides; no-store, noindex, no referrer, a CSP with no
  script.
- **Telegram**: the Bot API over HTTPS with no SDK, no `parse_mode`;
  `auto_topics` (made once, a clean name, kept on the volume, made again
  when deleted, at most `max_auto_topics`); `getUpdates` long polling, its
  offset kept, the ids of who writes to the bot logged; a second consumer
  of the bot said in the log.
- **ntfy**: JSON publishing with an access token, ntfy's priorities, the
  action Answer; one post at a time (ntfy 2.28 answers some concurrent
  posts of a token 403).
- **Email**: SMTP with STARTTLS required by default, `text/plain`, with
  nodemailer 10.0.15.
- **The state** in a volume (`state.json`, mode 600): the held messages,
  the grouping windows, the counts, the open questions, the answers still
  to hand gosidian, the topics the bot made, the updates' offset.
- **The image** `ghcr.io/daniele-chiappa/gosidian-notify`, amd64, run as
  the user node (1000), nothing added to `node:24-alpine` but tini. A
  separation test of it as in production, beside a real ntfy and Mailpit:
  the destinations only the preset's, no host outside the preset called,
  no secret in an output, the log or the state.

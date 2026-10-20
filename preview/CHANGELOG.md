# Changelog: gosidian-preview

The changes of the `preview` plugin, newest first. A tag
`preview/vX.Y.Z` publishes `ghcr.io/daniele-chiappa/gosidian-preview:X.Y.Z`,
and its release notes are its section here.

## [0.1.0] — 2026-10-20

The first release: the static build of a branch, as exec zips
it, served at an address that expires, each page in an opaque origin of
its own, and tried with a Playwright server.

### Added
- **The node `publish`**: `site`, a zip by reference (its size and
  SHA-256 checked); `ttl` (default 7d, at most the preset's `max_ttl`);
  `index`; `spa`, the index for the paths of a client-side router;
  `title`. The zip is checked before a byte is written: no absolute path,
  `..`, backslash or control character; no link, device or encrypted
  entry; at most `max_files` files, `max_depth` folders deep, `max_bytes`
  unpacked, `max_ratio` of compression; only the preset's types, and the
  index at its root. The bytes are counted again while inflating. Output:
  `id` (130 random bits), `url`, `expires_at`, `files`, `bytes`.
- **The node `check`**: a preview of the project (`id`, or a `url` under
  it, never another address) in a new context of a Playwright server's
  Chromium, with a `viewport` and `steps`: `goto`, `click`, `fill`,
  `select`, `press`, `wait_for`, `expect_text`, `expect_count`,
  `screenshot`. A failing step stops the others and takes a screenshot.
  Output: `ok`, each step's result, the console's errors and warnings and
  the uncaught exceptions, the failed requests, the screenshots as files.
  Without steps: the page loads with no error and no failed request.
- **The nodes `unpublish` and `list`**, of the call's project only.
- **The previews' server**, on a port of its own (8080): `GET` and `HEAD`
  of `/p/<id>/<path>`; every answer with `Content-Security-Policy:
  sandbox …` (no `allow-same-origin`), `nosniff`, `no-referrer`,
  `no-store`, CORS `*` without credentials; the same 404 for an id that is
  not live and a path that is not a file; no listing; no way out of a
  preview's folder.
- **The preset**: `public_url` (or `PREVIEW_PUBLIC_URL`), `store_dir`,
  `limits`, `types` (safe defaults, added to or removed), `connect` (`open`,
  or `self`: the pages reach only their own files, named by their address,
  since WebKit's `'self'` matches nothing in an opaque origin), and
  `playwright` (`ws_endpoint` or `PREVIEW_PLAYWRIGHT_WS`, `timeout`,
  `max_steps`). The expired previews are removed at start and every hour.
- **The image** `ghcr.io/daniele-chiappa/gosidian-preview`, amd64, with no
  browser, run as the user node (1000); playwright-core 1.61.0, so a
  Playwright server 1.61.x. A separation test of it as in production, in
  Chromium, Firefox and WebKit: no storage, no cookies, no DOM of another
  preview, no credentials of the host in a page's reach; the bad zips
  refused; nothing of a zip run.

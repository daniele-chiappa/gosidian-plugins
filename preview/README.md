# gosidian-preview

A gosidian plugin that serves the static build of a branch (HTML, JS, CSS,
data in JSON) at an address no one guesses, until it expires, and tries it
with a real browser. Its nodes:

- **`publish`** takes a zip of the build, as [exec](../exec) gives it back,
  checks it, and serves it at `<public_url>/p/<id>/`;
- **`check`** opens a preview in a browser of a Playwright server, does what
  a person would (click, fill, select, press, wait, expect a text or a
  count, screenshot) and gives back each step's result, the page's console
  errors and warnings, the failed requests and the screenshots;
- **`unpublish`** removes a preview before it expires; **`list`** gives the
  live ones of the project.

The plugin runs nothing of a zip: it unpacks files and serves them. The
build is exec's, in exec's sandbox. Each page runs in an **opaque origin**
of its own (a CSP sandbox), apart from the other previews, from gosidian
and from anything else on the same host.

Previews of apps with a server (a container per branch), a frame of a
preview in gosidian's web UI and an agent that explores an app with a
browser are not here: they come later.

## The pipeline

An agent writes the app on its branch; exec builds it and zips it;
`publish` serves it; `check` tries it; a note of the task keeps the link,
the screenshots and the verdict, for a person to open.

```yaml
- id: build
  use: exec.run
  with:
    repo: {name: sandbox, ref: "{{ agent.repo.branch }}"}
    script: |
      cd repo
      npm ci
      npm test
      npm run build -- --base=./
      python3 -m zipfile -c ../out/site.zip dist/.
  timeout: 16m

- id: publish
  use: preview.publish
  with:
    site: "{{ build.files.0.path }}"     # out/site.zip, an attachment now
    ttl: 3d
    title: "{{ agent.repo.branch }}"

- id: check
  use: preview.check
  with:
    id: "{{ publish.id }}"
    steps:
      - {action: wait_for, text: "Il piano"}
      - {action: select, selector: "#giorni", value: "3"}
      - {action: click, selector: "text=Mostra"}
      - {action: expect_count, selector: ".giorno", count: 3}
      - {action: screenshot, name: piano, full_page: true}

- id: note
  use: note.write
  with:
    path: "tasks/{{ run.id }}.md"
    body: |
      Anteprima: {{ publish.url }} (fino a {{ publish.expires_at }})
      Prova riuscita: {{ check.ok }}

      {{ check.files.0.markdown }}
```

**The zip has the build's files at its root**, `index.html` among them.
In exec's image (Python 3.14) `python3 -m zipfile -c out/site.zip dist/.`
does it: the trailing `/.` puts the folder's files at the root (so does
`cd dist && python3 -m zipfile -c ../out/site.zip .`). `dist/` without the
dot puts them under `dist/`, and `publish` refuses the zip: "no index.html
at its root (it has dist/index.html): zip the build's files, not its
folder". The image has `unzip` but not `zip`. Python's zipfile follows
links: a link in `dist/` goes in as the file it points at.

**The build's addresses are relative.** A preview lives under
`/p/<id>/`: an app built for `/` (`/assets/app.js`) finds nothing. With
Vite, `--base=./` (or `base: "./"`); with Create React App,
`"homepage": "."`; a client-side router takes its base from
`document.baseURI` or a hash router.

## The nodes

`<plugin>.publish`, for example `preview.publish`:

| Setting | Default | |
|---|---|---|
| `site` | | the zip, a vault path (exec's `out/site.zip` comes back as an attachment). gosidian hands it by reference (`file_refs`); the plugin checks its size and SHA-256 |
| `ttl` | the preset's (7d) | how long the preview lives: seconds, or `90m`, `12h`, `3d`; at most the preset's `max_ttl` (30d) |
| `index` | `index.html` | the page served at the preview's root, a `.html` or `.htm` of the zip |
| `spa` | false | true: a path that is not a file and has no extension (`/users/42`) gets the index, for a client-side router |
| `title` | | a name, for `list` |

Output: `id` (26 characters of base32: 130 random bits), `url`
(`<public_url>/p/<id>/`), `expires_at`, `files`, `bytes`, `title`.

The zip is checked before a byte is written, and refused, saying why, when
it holds:

- a path that is absolute, has `..`, a backslash, a control character, an
  empty or `.` part, or a part over 255 bytes;
- a symbolic link, a device or any entry but files and folders (the Unix
  type in the external attributes), an entry twice, a file that is also a
  folder;
- an encrypted entry, a compression other than store and deflate;
- more than `max_files` files, a file more than `max_depth` folders deep;
- more than `max_bytes` once unpacked as declared, more than the store's
  room (`max_total_bytes`, after the expired previews are removed), a ratio
  over `max_ratio` (the archive's, and each entry's over 1 MiB);
- a file of a type the preset does not serve (all of them named), or no
  index at its root.

Then it is unpacked into a folder of the plugin's: the bytes are counted as
they come out of the inflater (an entry that lies about its size, or a
total past `max_bytes`, stops it), files are new (`O_EXCL`, `O_NOFOLLOW`)
with mode 644 and folders 755, whatever the zip says. The preview is made
in `<id>.tmp/` and renamed when whole.

`<plugin>.check`:

| Setting | Default | |
|---|---|---|
| `id` | | a live preview of the project |
| `url` | | or an address under `<public_url>/p/<id>/` of one (a page of it, with its query): never another address |
| `viewport` | 1280 × 800 | `{width, height}` |
| `steps` | none | the actions, one after another, at most the preset's `max_steps` (50) |
| `timeout` | the preset's (60 s) | seconds, the whole check, at most 600 |

| Action | | |
|---|---|---|
| `goto` | `path` | a path under the preview (`about.html`, `#/users`); empty: its index. A path that leaves the preview fails the step |
| `click` | `selector` | |
| `fill` | `selector`, `value` | |
| `select` | `selector`, `value` | an option's value or label, or a list of them |
| `press` | `key`, `selector` | `Enter`, `Tab`, `ArrowDown`, `Control+A`…; without a selector, to the page |
| `wait_for` | `selector` or `text` | until it is visible |
| `expect_text` | `text`, `selector` | the element's text (default the page's) holds the text |
| `expect_count` | `selector`, `count` | so many elements match |
| `screenshot` | `name`, `full_page` | a PNG, `<step>-<name>.png` |

Selectors are Playwright's (CSS, `text=…`, `role=button[name="Mostra"]`);
an action takes the first element that matches. Each step may set
`timeout`, in seconds (default 10). The page of `url` (else the index) is
opened first, unless the first step is a `goto`.

A step that fails stops the others: they are marked `not_run`, and a
screenshot of the page is taken (`<step>-failed.png`). Without steps, the
check opens the page, waits for it to load and for the network to rest (5
seconds at most), and `ok` says there was no error in its console and no
failed request.

Output: `ok`; `url`, the page at the end; `error`, when the first page did
not open; `steps` (`action`, `ok`, `ms`, `error`, `not_run`, `screenshot`);
`console`, the page's errors, warnings and uncaught exceptions
(`pageerror`), at most 50; `failed_requests` (`{url, status}` for an
answer of 400 or more, `{url, error}` for a request that failed or was
blocked), at most 50; `screenshots`, their names; `seconds`; `browser`;
and from gosidian `files`, the screenshots stored as attachments of the
project. A failed check is a result (`ok: false`), not a failed node: the
pipeline decides. The node fails when the preview is not one of the
project's, when a step is not one it knows, or when the Playwright server
does not answer.

Each check is a new browser context, with the viewport, closed at the end;
two run at once (`PREVIEW_MAX_CHECKS`), the others wait. With
`connect: self`, the check's browser reaches nothing outside the preview:
a navigation or a request elsewhere is blocked and listed in
`failed_requests`.

`<plugin>.unpublish`: `id` → `{removed}`. A preview of another project is
not removed, and the answer is the same as for one that is not there.

`<plugin>.list`: the live previews of the project, newest first:
`previews: [{id, url, title, created_at, expires_at, files, bytes}]`.

**The project.** Every call carries `gosidian/project` in its `_meta`, and
only gosidian holds the plugin's token: a preview keeps its project (and
the run that made it) in its `meta.json`, and `check`, `unpublish` and
`list` see the call's project's previews only. A call without a project is
refused.

## Serving

A port of its own (8080), apart from MCP (8000), with `GET` and `HEAD`
only (anything else: 405):

- `/p/<id>/` is the index; `/p/<id>/<path>` a file; a folder's
  `<path>/` its `index.html`; a folder without its slash, and `/p/<id>`,
  send to it with a slash (301, a relative `Location`).
- An id that is not live (unknown, expired, removed), a path that is not a
  file, a part of a path that is empty, `.`, `..` or holds a slash, a
  backslash or a control character (encoded or not), a link, a file of a
  type the preset does not serve: the same 404, the same body. There is no
  listing, of a folder or of the previews.
- `/health` answers `{"status": "ok"}`, and nothing about the previews.

Every answer, the 404s too, carries:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads;
  default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * data: blob:
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store
Cross-Origin-Resource-Policy: cross-origin
Access-Control-Allow-Origin: *
X-Robots-Tag: noindex, nofollow
```

With `connect: self`, `connect-src` and `form-action` name the preview's
own folder instead, by its address: `<public_url>/p/<id>/` and the same at
the request's host (`X-Forwarded-Proto` says https behind a proxy), so a
preview opened at another name of the host (an SSH tunnel's `127.0.0.1`)
still reaches its files.

## Security

**A preview is the agents' code in a person's browser**: that is its
point. The plugin keeps it apart.

- **An opaque origin per page.** The CSP `sandbox` without
  `allow-same-origin` gives every page an origin of its own, `null`. What
  the browsers do with it, in the separation test (Chromium 149, Firefox
  151, WebKit 26.5, Playwright 1.61.0):
  - `localStorage`, `sessionStorage`, `document.cookie` (read and write)
    and `indexedDB` throw `SecurityError`; a service worker is refused.
    **An app must catch them**: one that keeps its state in
    `localStorage` without a `try` stops at its first line;
  - another preview's page, opened by a page in a popup or a frame: its
    DOM, its `location`, its `contentWindow.document` throw or are null.
    A page of the same preview in a frame is another origin too;
  - the requests a page makes (scripts, modules, `fetch`) never carry the
    cookies of the plugin's host (gosidian's, were it on the same host);
    `fetch(…, {credentials: "include"})` fails (CORS `*` takes no
    credentials). Only top-level navigations carry them (`SameSite=Lax`):
    what a person opens, and a popup a page opens, as any website could;
  - module scripts and `fetch` of the preview's own files work: they are
    requests of origin `null`, which `Access-Control-Allow-Origin: *`
    answers;
  - a Web Worker from a file of the preview does not start (its script is
    not of the page's origin); one from a `blob:` URL does. `eval` and
    WebAssembly work (`'unsafe-eval'`): the sandbox isolates, not the
    script's source.
- **Scripts, styles, images and fonts** come from the plugin's origin,
  inline, `data:` or `blob:`: the build carries what it needs, no CDN.
- **`connect: open`** (the default) lets the pages call any host: an app
  that calls a real API works, and so does an app that sends what it
  holds elsewhere. **`connect: self`** closes `fetch`, XHR, WebSocket and
  EventSource to anything but the preview's own files, and its forms'
  targets. It does not close navigation: a page may still open another
  site (a link, `window.open`, `location`), with data in the address. A
  CSP's `'self'` in `connect-src` matches nothing in an opaque origin for
  WebKit (its own fetches failed in our tests), so the plugin names the
  preview's address.
- **An address is public while it lives.** Whoever has it opens the
  preview, until it expires or is removed; the id (130 random bits) is not
  guessed, and nothing lists the previews. Who installs decides who reaches
  the port: the LAN, or behind a proxy with its authentication.
- **The plugin runs nothing of a zip.** It runs as the user node (1000),
  with no capability, on a read-only root: it unpacks files with modes of
  its own and serves them. The separation test publishes a zip with
  scripts that would write in `/tmp` if anything ran them, and checks that
  nothing did, that no process runs in the container but the server, and
  that the store has no executable, no link, no file of another user.
- **The check's browser** is the Playwright server's, where the preset puts
  it: with `connect: open`, a page reaches what that server reaches. On a
  network with services of the LAN, `connect: self` keeps the pages to
  their files. The check opens the project's previews only, never an
  address the node names elsewhere.
- **The disk**: `max_bytes` per preview, `max_total_bytes` in all, the
  expired ones removed at start and every hour.

## The preset

`/etc/gosidian-preview/preset.yaml` (`PREVIEW_PRESET`); without a file
there, the defaults, named `preview`. Every field is in
[presets/preview.yaml](presets/preview.yaml):

```yaml
name: preview
public_url: http://preview.lan:8085     # else PREVIEW_PUBLIC_URL
store_dir: /var/lib/gosidian-preview
limits: {ttl: 7d, max_ttl: 30d, max_files: 2000, max_bytes: 100MiB, max_total_bytes: 2GiB, max_ratio: 100, max_depth: 16}
types: {pdf: application/pdf}            # added to the defaults; null removes one
connect: open                            # or self
playwright: {ws_endpoint: "ws://preview.lan:4000/", timeout: 60s, max_steps: 50}   # else PREVIEW_PLAYWRIGHT_WS
```

The default types: `html`, `htm`, `js`, `mjs`, `css`, `json`, `map`,
`txt`, `csv`, `xml`, `webmanifest`, `svg`, `png`, `jpg`, `jpeg`, `gif`,
`webp`, `avif`, `ico`, `woff`, `woff2`, `ttf`, `wasm`. The manifest's
network is gosidian and the Playwright server's host; a change of the
preset (or of `PREVIEW_PLAYWRIGHT_WS`) changes the manifest: `gosidian
plugin show`, then `gosidian plugin accept`.

**Playwright's versions.** The client, `playwright-core`, is **1.64.0**,
and a Playwright server refuses a client of another minor version: the
server must be **1.64.x** (`npx playwright@1.64.0 run-server`, or the image
`mcr.microsoft.com/playwright:v1.64.0-noble`). A new version of the plugin
that moves playwright-core says so in its changelog. The server reaches
the plugin at `public_url`; the plugin reaches the server at
`ws_endpoint`.

## Running it

```yaml
services:
  preview:
    image: ghcr.io/daniele-chiappa/gosidian-preview:0.1.2
    restart: unless-stopped
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${PREVIEW_TOKEN:?}
      PREVIEW_PUBLIC_URL: http://preview.lan:8085     # what the browsers reach: the port below
      PREVIEW_PLAYWRIGHT_WS: ws://playwright:3000/
    ports:
      - "8085:8080"               # the previews, for the people's browsers (bind it to a LAN address)
    # 8000 (MCP) stays on the network gosidian is on
    volumes:
      - preview-store:/var/lib/gosidian-preview
      # - ./preview.yaml:/etc/gosidian-preview/preset.yaml:ro
    read_only: true
    tmpfs: ["/tmp"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 512m
    pids_limit: 256
    networks: [default]

  # A Playwright server of the same minor version: it must reach
  # PREVIEW_PUBLIC_URL, and the plugin must reach it.
  playwright:
    image: mcr.microsoft.com/playwright:v1.64.0-noble
    restart: unless-stopped
    init: true
    shm_size: 1g
    command: ["npx", "-y", "playwright@1.64.0", "run-server", "--port", "3000", "--host", "0.0.0.0"]
    networks: [default]
volumes:
  preview-store:
```

```toml
[[pipelines.plugins]]
name = "preview"
url = "http://preview:8000/mcp"
token_secret = "preview-token"
```

A Playwright server that is already there (`playwright run-server`,
1.64.x) does as well, when it reaches `PREVIEW_PUBLIC_URL`. The volume is the user node's (1000): a named volume
takes it from the image; a folder of the host needs `chown 1000:1000`.

## Environment

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | empty | the bearer token gosidian sends; empty: none |
| `PREVIEW_PRESET` | `/etc/gosidian-preview/preset.yaml` | the preset (a missing file at the default path: the defaults) |
| `PREVIEW_PUBLIC_URL` | | the previews' address, when the preset has no `public_url` |
| `PREVIEW_PLAYWRIGHT_WS` | | the Playwright server, when the preset has no `playwright.ws_endpoint` |
| `PREVIEW_HTTP_PORT` | 8080 | the previews, `/p/<id>/` and `/health` |
| `PORT` | 8000 | MCP at `/mcp`, `GET /health` without a token |
| `PREVIEW_MAX_CHECKS` | 2 | checks at once; the others wait |

## Building and testing

```bash
docker build --build-arg VERSION=0.1.2 -t gosidian-preview:0.1.2 preview/
preview/scripts/test.sh              # types and tests in node:24-alpine, beside a Playwright server 1.64.0
preview/scripts/separation-test.sh   # the image as in production, two previews in Chromium, Firefox and WebKit
```

The tests build their zips with a small writer of their own: good ones,
and the malicious ones (traversal, absolute paths, links, devices, bombs,
sizes that lie, encrypted entries, types not served, no index). The
browser's tests need a Playwright server: `test.sh` starts one in a
container (`PREVIEW_TEST_NO_PLAYWRIGHT=1` skips them), and without
`PREVIEW_TEST_PLAYWRIGHT_WS` they are skipped. The image (about 300 MB, no
browser) is built for amd64.

## Licenses

MIT, like gosidian. The packages in the image are under their own
licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

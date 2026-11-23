# gosidian-office

The office of a team of agents, for [gosidian](https://github.com/daniele-chiappa/gosidian):
a page gosidian opens in a window of its own for the notes `type: team`,
which draws the team as an office seen from above. Each role sits at its
desk, the coordinator's at the head and the others in rows below: one of
Kenney's Mini Characters, always the same for the same role, its shirt in
the role's color. The delegations run as paths on the floor from a
delegator to each of its delegates; over each character, its state and
what it spent today. Whoever may write the team's project changes it on
the map too: the page proposes the changes, gosidian's window keeps them
as a draft the server checks, and only the window's own **Save** writes
the note. The same office also turns in 3D, to look at.

```
gosidian's window ──(postMessage, office/1)──▶ the office (iframe, from this plugin)
  reads the team with the rights                 the map, the list of the roles,
  of whoever is logged in, sends it              the panel of a role; asks the
  again when it changes                          window to open a note or refresh
```

The page talks to the window that opened it and to nothing else: the plugin
only serves files, and holds no credentials of gosidian's.

It needs gosidian 2.168.0 or later, whose windows speak the bridge
`office/1` and which serves `GET /api/v1/fleet/teams/<path>`; to change a
team on the map, gosidian 2.170.0 or later, which takes `POST` on it and
keeps the draft.

## Running it

```yaml
services:
  gosidian-office:
    image: ghcr.io/daniele-chiappa/gosidian-office:0.1.0
    restart: unless-stopped
    read_only: true
    mem_limit: 64m
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${OFFICE_PLUGIN_TOKEN}       # gosidian's token for /mcp
      OFFICE_PUBLIC_URL: https://office.example.com       # the address the browsers reach it at
      OFFICE_FRAME_ANCESTORS: https://vault.example.com   # gosidian's address
    ports: ["8098:8000"]
```

| Variable | |
|---|---|
| `OFFICE_PUBLIC_URL` | The address the browsers reach the plugin at; gosidian's windows open the page from `<it>/app/`. Required. |
| `OFFICE_ALT_URLS` | Other addresses of the plugin, comma-separated, at most 4, for a gosidian reached more than one way (a name and the LAN, the LAN and an SSH tunnel): the window opens the one on the host gosidian was opened at. Each needs its gosidian origin in `OFFICE_FRAME_ANCESTORS`. |
| `OFFICE_FRAME_ANCESTORS` | gosidian's origins, comma-separated: the only pages that may show the office in a frame. Required. |
| `GOSIDIAN_PLUGIN_TOKEN` | The token gosidian calls `/mcp` with. |
| `OFFICE_NAME` | The name gosidian registers the plugin with (default `office`). |
| `OFFICE_SITE_DIR` | The page's build (default `/usr/share/gosidian-office/site`, in the image). |
| `OFFICE_LICENSES_DIR` | The licenses the references' page reads (default `/licenses`, in the image). |
| `PORT` | Default 8000. |

Then, as for any plugin, register it in gosidian's `config.toml`, read its
manifest with `gosidian plugin show office` and accept it.

## What it serves

- **`/app/`**: the page. Each file in the precompressed copy the browser
  accepts (Brotli, then gzip), the models as `model/gltf-binary`; the files
  of `assets/`, named by Vite with their hash, cached for good, the rest
  checked again at each visit. Its CSP: `default-src 'self'; script-src
  'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'
  blob:; object-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors <OFFICE_FRAME_ANCESTORS>`. Nothing inline: the server
  refuses to start on a build whose `index.html` has inline script or
  style. `blob:` is for the models' textures, which three.js cuts out of
  each GLB as a blob and reads back with `fetch`.
- **`/app/about`**: the references, for gosidian's window: the plugin's
  license, the 3D models with their authors, packs, sources and licenses,
  the libraries in the page and the Go modules in the server. No script
  runs on it; gosidian's origins may frame it.
- **`/mcp`**: the manifest for gosidian, with the token: one app, `office`,
  titled *Ufficio*, for the notes `type: team`, bridge `office/1`. No
  nodes, no tools, no files, no network.
- **`/health`**: the plugin's version and bridge.

Every answer has `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`; every one but `/app/` and `/app/about`,
`X-Frame-Options: DENY`.

## The page

- **The header**: the team's name, its coordinator, today's spend against
  `budget.day_usd` (or *no limit*), `max_agents`, a button to refresh and
  one to open the team's note. The problems of the block, each with its
  line, under it; with `team: null` the page shows only them.
- **The map**: an orthographic camera from above, tilted enough to show
  the characters' faces. A desk per role; the coordinator's at the head
  on a rug, the roles it delegates to first in the rows below, then the
  others in the block's order. A room of the team (gosidian's `rooms`) is
  a meeting table on a rug, with nobody at it, where its coordinator
  delegates: its label, a square sign, says the state of its roles that
  asks most of a person and what it spent today, and its panel its roles,
  their open tasks and its note, which opens its own office. How many desks a row comes from the map's
  shape and from the labels, as the page measures them: the office as big
  as it can be with every label whole, smaller (down to three quarters of
  that) to keep them whole, else names shortened with an ellipsis, never two labels
  over each other. Over each character a button with the state's marker,
  the role's name and today's cost; a shortened name keeps its marker and
  cost whole, and its whole name in the button's accessible name and in
  the panel. The page is as tall as its frame: the header and the legend
  stay, the map takes the rest.
- **The states**, each a color and a shape, and always its name in words:

  | State | Marker | |
  |---|---|---|
  | `working` | green circle with a play sign | a run holds one of its tasks |
  | `waiting` | amber speech bubble | a task waits for a person |
  | `held` | red octagon with a pause sign | stopped by the budget, a limit or the tasks it depends on |
  | `queued` | blue diamond with an hourglass | a task is ready, no run holds it yet |
  | `idle` | grey ring with a bar | nothing at work |

- **The panel** of the selected role (beside the map, below it on a narrow
  window): its state and today's spend, its fields (run, model, effort,
  access, repo or host, paths and forbid, writes, delegates_to, its
  plugins' tools with those not exposed in the project, approve, review,
  checks and preview, its limits), its open tasks, each a button
  that asks the window to open it, its agent note, marked when it is
  missing, and its profile and the guides and skills its agent receives,
  when the server says them, each a button too, marked when it is missing
  or no skill.
- **The 3D**: the same office seen by a perspective camera that
  turns around it, to look at, not to change. Drag to turn (never under
  the floor nor straight down), the wheel or two fingers to come nearer
  (never farther than twice what holds everything), the right button or
  two fingers to slide; the camera's buttons (turn left and right, nearer,
  farther, **Reset the view**) and, on the view, the arrows (turn, look
  from higher or lower), + and − and 0 do the same. The office has walls
  with windows; those between the camera and the office come down as it
  turns. Behind the team's office, across a corridor and a glass wall, the
  office of each room of the team, its people at their desks with their
  labels and a sign with its name. A click on a role, on a role of a room,
  or on a character opens its panel, read only; **Edit** goes back to the
  map, and the 3D waits for the end of the changes. Each browser
  remembers the last view chosen (map, 3D, list); the map the first time.
- **The list**: the same roles as a list, for whoever does not use the map.
- **Editing**, where the window's team says `editable`:
  **Edit** starts a draft and **Stop editing** ends one without changes.
  The draft's bar says how many changes it holds, undoes the last, throws
  the draft away after a second press, opens **The team's fields**
  (coordinator, budgets, agents at once, guide, rooms: unlinked, a team of
  the project linked, a new one created) and shows the block as the draft
  writes it, line by line, the lines with a problem marked. **Add a role**
  (folded) lists the project's profiles: one pressed, or dragged onto the
  map or onto a role, adds a role with it under a free name of its own;
  the fields beside them add one with a name chosen. The panel of a role
  becomes a form: its name (renamed with **Rename**: the server refuses a
  role with open tasks and says which), its profile, executor, model,
  effort, access, review, delegations (ticked; or a role dragged onto
  another), the folders it writes, its plugins' tools (every one of the
  project, none, these), its skills and guide, each value its profile
  gives said as such, with **Use the profile's** for one the role
  overrides; **Take the role away** after a second press. Each change is
  one op over the bridge; the window answers with the team as the draft
  makes it, and the page draws that. The problems that keep the draft from
  being saved stand above the map, each on its role or room and its line,
  and mark the role's button. A form is built again only when what it
  shows changed, keeping what is typed and not sent. The frame's sandbox
  takes no form submission: the actions are buttons and Enter.
- **Keys**: Tab reaches the roles (one stop), the arrows move between them
  (left and right in reading order, up and down to the nearest desk of the
  next row; in the 3D one after the other, the rooms' people after the
  team's), Home and End to the first and the last, Enter opens the panel,
  Esc closes it and goes back to the role. The canvas has a summary in its
  `aria-label`, and a polite live region says when a role changes state.
- **Motion**: the page draws a frame only when something changed or
  moves. A character reaches out toward you when its role starts waiting
  for a person and nods when its work is done, once. In the 3D, who works
  works at the desk, a hand then the other, as long as it works; who waits
  for a person turns toward the camera and reaches out again every few
  seconds. Nothing moves with `prefers-reduced-motion`: who waits still
  faces you.
- **Languages and themes**: Italian and English, from `?lang=` and then
  from the window's messages; light and dark from the message's `theme`,
  else `prefers-color-scheme`. The roles' colors are the same in both.
- With the pipelines off (`pipelines: false`) the page shows no spend and
  no waits. Without WebGL it shows the list. Opened outside gosidian, it
  says so and links an example (`/app/?demo`), drawn from a built-in team.

## The bridge office/1

The contract is gosidian's `docs/plugins.md`, «The bridge office/1». The
window opens `/app/?host=gosidian&origin=<gosidian's origin>&lang=<it|en>`.
The page:

- posts `{bridge: "office/1", type: "ready"}` to `window.parent`, at
  `origin` only (never `*`), as soon as it loads;
- takes a message only when its `source` is `window.parent`, its `origin`
  is `origin`, and its `bridge` is `office/1`: `team` (the team, `theme`,
  `lang`) and `error` (`message`); anything else it ignores;
- reads the team defensively: every field gets its type, a role named
  `__proto__` is a role like another;
- posts `refresh` from its button and `open` with a `path` from a task, an
  agent note or the team's note;
- while the team is edited, posts `editing` (`on`), `edit` (`op`), `undo`
  and `discard`, and takes `team` with its `draft`, `refused` (a change
  the server refused, with why) and `saved`. It has no message that
  writes: the window saves from its bar.

## Building

The page is in `web/` (TypeScript, three.js, Vite), the server in Go here.

```sh
# the page: tests, type check, build into web/dist
cd web && npm ci --ignore-scripts && npx vitest run && npm run build
# the server
go test ./...
# the image: builds the page (its tests first) and the server
docker build -t gosidian-office:dev .
```

The versions are pinned in `web/package.json` and `web/package-lock.json`:
three 0.187.0, Vite 8.3.5, TypeScript 7.0.2, Vitest 5.1.0, each at least
two weeks old when chosen, and the lock file resolved with
`npm install --before=<two weeks ago>`. No package runs an install script.

The 3D models in `web/public/models/` are made from the CC0 packs by
`scripts/assets.py` (standard library Python; run it with `python3 -I`, the
packs are downloaded data):

```sh
# KayKit Furniture Bits: .gltf, .bin and texture packed into one GLB
python3 -I scripts/assets.py pack <pack>/Assets/gltf/table_medium_long.gltf web/public/models/table_medium_long.glb
# Kenney Mini Characters: four clips, the texture inside, the shirt (its
# atlas cell, row.col) in a material the page tints
python3 -I scripts/assets.py trim '<pack>/Models/GLB format/character-male-a.glb' web/public/models/character-male-a.glb \
  'idle=Idle,interact-right=Ask,emote-yes=Yes,interact-left=Left' --shirt 2.9
```

The characters' shirt cells: female-b 3.1, female-c 1.1, female-d 3.3,
male-a 2.9, male-b 2.15, male-d 3.7. A role gets one of the six by a hash
of its name (`web/src/layout.ts`, `CHARACTERS`).

`THIRD_PARTY_NOTICES.md` says where each came from, with the SHA-256 of
the files downloaded.

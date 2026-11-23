# Changelog: gosidian-office

The changes of the `office` plugin, newest first. A tag `office/vX.Y.Z`
publishes `ghcr.io/daniele-chiappa/gosidian-office:X.Y.Z`, and its release
notes are its section here.

## [0.1.0]

The first version: the office of a team of agents, in a window of
gosidian for the notes `type: team`, which whoever may write the team
changes on the map, and which turns in 3D. It needs gosidian 2.168.0 or
later, and 2.170.0 or later to change a team.

### Added
- **The 3D**: the same office seen by a perspective camera that
  turns around it, to look at. Drag, the wheel, two fingers, the camera's
  buttons and the keys on the view turn it, bring it nearer and back,
  within limits; walls with windows that come down between the camera and
  the office; the offices of the team's rooms behind a glass wall, with
  their people, their labels and a sign. A click on a role, a room's role
  or a character opens its panel, read only; **Edit** goes back to the
  map. Who works works at the desk and who waits for a person turns toward
  the camera, except with `prefers-reduced-motion`. Each browser remembers
  the last view chosen. The characters keep a fourth clip of the pack,
  `interact-left`.
- **The team changed on the map**: **Edit** starts a draft that
  gosidian's window keeps and the server checks at every change; only the
  window's **Save** writes it. The draft's bar (its changes, undo, throw
  away, the block line by line with its problems, the team's fields and
  rooms), the palette of the project's profiles (pressed, or dragged onto
  the map, a role added), the panel of a role as a form (name, profile,
  executor, model, effort, access, review, delegations, folders, tools,
  skills, guide; a profile's values said as such), a role dragged onto
  another to delegate. The problems that keep a draft from being saved,
  each on its role or room and line.
- **The map**: the team as an office seen from above, with an orthographic
  camera tilted to show the faces. A desk per role, the coordinator's at
  the head, the others in rows fitted to the map's shape and to the
  labels' measured widths, so that no two labels meet (a name too long
  for its column ends in an ellipsis, its marker and cost whole); the
  page as tall as its frame, with no scroll of its own;
  each role one of six CC0 characters of Kenney's Mini Characters, the
  same for the same name, its shirt in the role's color, with its name,
  its state and today's cost over it; the delegations as paths along the aisles, an
  arrow at each delegate.
- **Five states**, each a color and a shape: working, waiting for a
  person, held, queued, idle; a legend says them in words.
- **The header**: the team, its coordinator, today's spend against the
  day's budget, the agents at once, the problems of the block with their
  lines; with no team, the problems alone. With the pipelines off, no
  spend and no waits.
- **The panel** of a role: its fields, its open tasks and its agent note,
  each a button that asks gosidian to open it; a button to refresh.
- **The list** of the roles, the keys (Tab, the arrows, Home, End, Enter,
  Esc), the map's summary for screen readers and a live region for the
  changes of state; Italian and English; light and dark.
- **The bridge `office/1`**: `ready`, `refresh` and `open` to gosidian's
  window at its origin only; `team` and `error` taken only from the parent
  frame at that origin.
- **The server**: the page with its CSP (nothing inline), the references
  at `/app/about` with no script, the manifest on `/mcp` with the token,
  `/health` and the `healthcheck` command; the image runs as 65532,
  read-only, with the licenses under `/licenses`.

### Security
- **The image's Alpine packages at their latest fixes** (`apk upgrade`):
  zlib 1.4-r0 (CVE-2026-4738) and OpenSSL 3.5.9-r1, which `alpine:3.24`
  does not have yet.

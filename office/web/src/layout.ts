// Where each role sits: a desk per role, the coordinator's at the head, the
// others in rows below it, and the delegations as paths on the floor along
// the aisles. Pure: the scene, the keys and the tests read the same plan.
//
// The floor is the plane x (right) and z (down the screen); units are
// metres of the scene. A role's character stands behind its desk (smaller
// z), its chair behind it, all facing +z, the viewer.

import type { Team } from './model';

export const DESK = {
  // Between the centres of two desks of a row, and of two rows.
  dx: 3.3,
  dz: 3.8,
  // From the head desk to the first row: a little more room.
  headGap: 4.1,
  // From a desk's centre: its front edge, where the character stands, its
  // chair, where a delegation's arrow ends (behind the chair, just above
  // the role's label on screen), and the aisle behind the row.
  front: 0.35,
  character: -0.8,
  chair: -1.3,
  back: -2.7,
  aisle: -3.05,
} as const;

export const ROLE_COLORS = [
  '#e0703f', // coral
  '#2f8fd8', // sky
  '#8a5cd0', // violet
  '#1ea493', // teal
  '#d9a21b', // mustard
  '#d9558f', // pink
  '#5a7fd6', // periwinkle
  '#6aa84f', // leaf
] as const;

// The characters a role may get: six people of Kenney's Mini Characters,
// in web/public/models/character-<name>.glb.
export const CHARACTERS = [
  'character-female-b',
  'character-female-c',
  'character-female-d',
  'character-male-a',
  'character-male-b',
  'character-male-d',
] as const;

export type ModelKind = (typeof CHARACTERS)[number];

export interface Desk {
  name: string;
  // The role's place in the block.
  index: number;
  x: number;
  z: number;
  row: number;
  col: number;
  head: boolean;
  color: string;
  model: ModelKind;
  // A room of the team: a meeting table, no one at it.
  room: boolean;
}

export type Point = readonly [number, number];

export interface Link {
  from: string;
  to: string;
  points: Point[];
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface OfficeLayout {
  desks: Desk[];
  links: Link[];
  bounds: Bounds;
  columns: number;
  // The desks in reading order, row by row: the order of the keys.
  order: string[];
}

// VIEW is how the scene looks at the office: the camera's elevation over
// the floor (steep enough to read as a map, tilted enough to show the
// faces), the characters' height and where their labels sit.
export const VIEW = {
  elevation: (46 * Math.PI) / 180,
  character: 1.35,
  label: 1.47,
} as const;

// frame is the size, in the scene's units, of the view that holds the
// whole office: the floor seen at the camera's elevation, the labels above
// the far row, a margin.
export function frame(b: Bounds): { w: number; h: number } {
  const sin = Math.sin(VIEW.elevation);
  const cos = Math.cos(VIEW.elevation);
  return {
    w: 2 * Math.max((b.maxX - b.minX) / 2 + 0.2, 3.2),
    h: (b.maxZ - b.minZ) * sin + VIEW.label * cos + 1.1,
  };
}

// The labels: the space kept between two of them, and the margin a label
// keeps from the map's sides, in CSS pixels.
export const LABEL_GAP = 8;
export const LABEL_MARGIN = 16;
// A layout may draw the office smaller than the biggest one to keep the
// labels whole, down to this share of the biggest; below it, names are
// shortened instead. A single column is often about 60% of the biggest: a
// wide window keeps its rows, and a name a few pixels too long loses a
// letter, rather than the office shrinking to a strip.
export const MIN_SHARE = 0.75;

// scaleFor is how many CSS pixels a unit of the scene takes when a map of
// width × height holds the office laid out in columns.
export function scaleFor(team: Team, columns: number, width: number, height: number): number {
  const f = frame(computeLayout(team, columns).bounds);
  return Math.min(width / f.w, height / f.h);
}

// labelRoom is the width a label of a row may take, in CSS pixels: the
// distance between two desks less the gap, or with a single column the
// map's width less its margins.
export function labelRoom(team: Team, columns: number, width: number, height: number): number {
  if (columns <= 1) {
    return width - 2 * LABEL_MARGIN;
  }
  return scaleFor(team, columns, width, height) * DESK.dx - LABEL_GAP;
}

// What the labels of the rows ask, in CSS pixels, as the page measures
// them: the width of the widest one whole, the width of the widest one
// with its name cut to a few letters (its marker and cost stay whole), and
// the height of one with the space kept between two rows.
export interface LabelSize {
  whole: number;
  least: number;
  height: number;
}

const DEFAULT_LABELS: LabelSize = { whole: 108, least: 108, height: 26 };

// columnsFor is how many desks a row holds on a map of width × height CSS
// pixels. In order, it takes the count that draws the office biggest:
// among those that draw it at least MIN_SHARE of the biggest, with every
// label whole, then with every name at least begun; then among all counts,
// the same two; then the count that leaves the labels the most room. The
// page shortens the names that do not fit their column. A tall phone gets
// few desks a row, a wide and low window many.
export function columnsFor(team: Team, width: number, height: number, labels: LabelSize = DEFAULT_LABELS): number {
  if (width <= 0 || height <= 0) {
    return 4;
  }
  const others = team.roles.length + team.rooms.length - (team.roles.some((r) => r.name === team.coordinator) ? 1 : 0);
  if (others <= 1) {
    return 1;
  }
  const rise = Math.sin(VIEW.elevation);
  const options: Array<{ c: number; scale: number; room: number; tall: boolean }> = [];
  for (let c = 1; c <= Math.min(8, others); c++) {
    const scale = scaleFor(team, c, width, height);
    // Two rows of labels stay apart on screen.
    const tall = scale * DESK.dz * rise >= labels.height;
    options.push({ c, scale, room: labelRoom(team, c, width, height), tall });
  }
  const biggest = Math.max(...options.map((o) => o.scale));
  const big = (o: (typeof options)[number]) => o.scale >= MIN_SHARE * biggest - 1e-9;
  const whole = (o: (typeof options)[number]) => o.tall && o.room >= labels.whole;
  const begun = (o: (typeof options)[number]) => o.tall && o.room >= labels.least;
  const largest = (set: typeof options) => set.reduce((a, o) => (o.scale > a.scale + 1e-9 ? o : a)).c;
  for (const test of [(o: (typeof options)[number]) => big(o) && whole(o), (o: (typeof options)[number]) => big(o) && begun(o), whole, begun]) {
    const set = options.filter(test);
    if (set.length > 0) {
      return largest(set);
    }
  }
  return options.reduce((a, o) => (o.room > a.room + 1e-9 ? o : a)).c;
}

// hash is FNV-1a: a role keeps its character when roles come and go.
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// modelFor is the character of a role, from its name only.
export function modelFor(name: string): ModelKind {
  return CHARACTERS[hash(name) % CHARACTERS.length];
}

// seatOrder is the order of the desks: the coordinator, the roles and
// rooms it delegates to in its order, then the other roles in the block's
// order, then the other rooms.
export function seatOrder(team: Team): { head: string | null; rest: string[] } {
  const names = [...team.roles.map((r) => r.name), ...team.rooms.map((r) => r.name)];
  const head = names.includes(team.coordinator) ? team.coordinator : null;
  const rest: string[] = [];
  if (head !== null) {
    const coord = team.roles.find((r) => r.name === head);
    for (const d of coord?.delegates_to ?? []) {
      if (d !== head && names.includes(d) && !rest.includes(d)) {
        rest.push(d);
      }
    }
  }
  for (const n of names) {
    if (n !== head && !rest.includes(n)) {
      rest.push(n);
    }
  }
  return { head, rest };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function computeLayout(team: Team, columns: number): OfficeLayout {
  const cols = Math.max(1, Math.floor(columns));
  const { head, rest } = seatOrder(team);
  const index = new Map(team.roles.map((r, i) => [r.name, i] as const));
  const rooms = new Set(team.rooms.map((r) => r.name));
  team.rooms.forEach((r, i) => index.set(r.name, team.roles.length + i));
  const desks: Desk[] = [];
  const place = (name: string, x: number, z: number, row: number, col: number, isHead: boolean) => {
    const i = index.get(name) ?? 0;
    desks.push({
      name, index: i, x: round(x), z: round(z), row, col, head: isHead,
      color: ROLE_COLORS[i % ROLE_COLORS.length], model: modelFor(name), room: rooms.has(name),
    });
  };
  let z0 = 0;
  let row = 0;
  if (head !== null) {
    place(head, 0, 0, 0, 0, true);
    z0 = DESK.headGap;
    row = 1;
  }
  for (let start = 0; start < rest.length; start += cols) {
    const names = rest.slice(start, start + cols);
    names.forEach((n, c) => place(n, (c - (names.length - 1) / 2) * DESK.dx, z0, row, c, false));
    z0 += DESK.dz;
    row++;
  }

  const byName = new Map(desks.map((d) => [d.name, d] as const));
  // The gaps between the columns of a full row, where a path may go down
  // past the rows between two desks.
  const full = Math.min(cols, Math.max(rest.length, 1));
  const gaps: number[] = [];
  for (let c = 0; c <= full; c++) {
    gaps.push((c - full / 2) * DESK.dx);
  }
  // The gap nearest x that does not run through the desk at avoid (the
  // head's, which sits alone in its row).
  const nearestGap = (x: number, avoid: number | null) => {
    const ok = gaps.filter((g) => avoid === null || Math.abs(g - avoid) >= DESK.dx / 2 - 1e-6);
    const from = ok.length > 0 ? ok : gaps;
    return from.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a), from[0]);
  };

  const links: Link[] = [];
  const delegators = team.roles.filter((r) => r.delegates_to.some((d) => byName.has(d) && d !== r.name));
  delegators.forEach((r, li) => {
    const from = byName.get(r.name);
    if (!from) {
      return;
    }
    // Each delegator's paths run in a lane of their own along the aisles.
    const lane = (li - (delegators.length - 1) / 2) * 0.14;
    for (const d of r.delegates_to) {
      const to = byName.get(d);
      if (!to || d === r.name || links.some((l) => l.from === r.name && l.to === d)) {
        continue;
      }
      links.push({ from: r.name, to: d, points: route(from, to, lane, nearestGap) });
    }
  });

  const xs = desks.map((d) => d.x);
  const zs = desks.map((d) => d.z);
  const bounds: Bounds = desks.length === 0
    ? { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }
    : {
        minX: round(Math.min(...xs) - DESK.dx / 2 - 0.4),
        maxX: round(Math.max(...xs) + DESK.dx / 2 + 0.4),
        minZ: round(Math.min(...zs) + DESK.aisle - 0.6),
        maxZ: round(Math.max(...zs) + DESK.front + 1.0),
      };
  const order = [...desks].sort((a, b) => a.row - b.row || a.col - b.col).map((d) => d.name);
  return { desks, links, bounds, columns: cols, order };
}

// route is the path of a delegation: out of the delegator's desk to the
// aisle, along it, down a gap between the columns when rows lie between,
// and into the delegate's place from behind its chair.
function route(from: Desk, to: Desk, lane: number, nearestGap: (x: number, avoid: number | null) => number): Point[] {
  const pts: Array<[number, number]> = [];
  const aboveTo = to.z + DESK.aisle + lane;
  const end: [number, number] = [to.x, to.z + DESK.back];
  if (to.z > from.z) {
    // Down: from the front of the delegator's desk.
    const below = from.z + (from.head ? DESK.headGap : DESK.dz) + DESK.aisle + lane;
    pts.push([from.x, from.z + DESK.front], [from.x, below]);
    if (Math.abs(below - aboveTo) > 1e-6) {
      const gx = nearestGap(to.x, null);
      pts.push([gx, below], [gx, aboveTo]);
    }
    pts.push([to.x, aboveTo], end);
  } else {
    // The same row or above: from behind the delegator, along the aisle
    // above its row, up a gap when it is not the delegate's.
    const aboveFrom = from.z + DESK.aisle + lane;
    pts.push([from.x, from.z + DESK.back], [from.x, aboveFrom]);
    if (Math.abs(aboveFrom - aboveTo) > 1e-6) {
      const gx = nearestGap(from.x, to.head ? to.x : null);
      pts.push([gx, aboveFrom], [gx, aboveTo]);
    }
    pts.push([to.x, aboveTo], end);
  }
  return simplify(pts.map(([x, z]) => [round(x), round(z)] as [number, number]));
}

// simplify drops repeated points and the middle of straight runs.
function simplify(pts: Array<[number, number]>): Point[] {
  const out: Array<[number, number]> = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) {
      continue;
    }
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

export type Direction = 'left' | 'right' | 'up' | 'down' | 'first' | 'last';

// neighbor is the desk the arrow keys go to from name: left and right in
// reading order, up and down to the nearest desk of the row above or below.
export function neighbor(layout: OfficeLayout, name: string, dir: Direction): string {
  const order = layout.order;
  if (order.length === 0) {
    return name;
  }
  const i = order.indexOf(name);
  if (i < 0 || dir === 'first') {
    return order[0];
  }
  if (dir === 'last') {
    return order[order.length - 1];
  }
  if (dir === 'left') {
    return order[Math.max(0, i - 1)];
  }
  if (dir === 'right') {
    return order[Math.min(order.length - 1, i + 1)];
  }
  const here = layout.desks.find((d) => d.name === name);
  if (!here) {
    return name;
  }
  const target = here.row + (dir === 'up' ? -1 : 1);
  const row = layout.desks.filter((d) => d.row === target);
  if (row.length === 0) {
    return name;
  }
  return row.reduce((a, b) => (Math.abs(b.x - here.x) < Math.abs(a.x - here.x) ? b : a)).name;
}

// signature changes when the map must be built again: the roles, their
// order, the columns, the delegations. A change of state alone keeps it.
export function signature(layout: OfficeLayout): string {
  return JSON.stringify([layout.columns, layout.desks.map((d) => [d.name, d.x, d.z]), layout.links.map((l) => [l.from, l.to])]);
}

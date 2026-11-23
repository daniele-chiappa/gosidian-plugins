// The office seen in 3D: the team's office, the offices
// of its rooms behind it, the walls around each, and the camera that turns
// around them. Pure: the scene, the page and the tests read the same plan.
//
// The floor is the plane x (right) and z (toward the viewer of the map), as
// in layout.ts; y is up.

import type { Bounds, OfficeLayout } from './layout';
import { computeLayout } from './layout';
import type { Team } from './model';

// ROOM_SEP joins a room's name and one of its roles' into the key of that
// role in the 3D: neither name has one.
export const ROOM_SEP = '/';

export function roomRoleKey(room: string, role: string): string {
  return room + ROOM_SEP + role;
}

// splitKey reads a key of the 3D: a role or room of the team, or a role of
// one of its rooms.
export function splitKey(key: string): { room: string | null; name: string } {
  const i = key.indexOf(ROOM_SEP);
  return i < 0 ? { room: null, name: key } : { room: key.slice(0, i), name: key.slice(i + 1) };
}

// A room's office: its team laid out as the team's is, moved by x and z.
export interface RoomOffice {
  room: string;
  title: string;
  layout: OfficeLayout;
  x: number;
  z: number;
}

export interface World {
  main: OfficeLayout;
  rooms: RoomOffice[];
  // Around every office and the corridor between them.
  bounds: Bounds;
}

// Between the team's office and its rooms', and between two rooms'.
export const CORRIDOR = 2.2;
export const ROOM_GAP = 1.2;
// How far the walls stand outside an office's floor.
export const WALL_MARGIN = 0.15;

// roomColumns is how many desks a row of a room's office holds: a room
// is small, a square is easiest to see from every side.
export function roomColumns(team: Team): number {
  const others = team.roles.length - (team.roles.some((r) => r.name === team.coordinator) ? 1 : 0);
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(Math.max(1, others)))));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function widthOf(b: Bounds): number {
  return b.maxX - b.minX;
}

// worldLayout places the rooms' offices in a row behind the team's, across
// a corridor: their people face the team's office and the camera that
// looks at it. A room whose team is not read has no office.
export function worldLayout(main: OfficeLayout, rooms: ReadonlyArray<{ name: string; title: string; team: Team | null }>): World {
  const offices: RoomOffice[] = [];
  const laid = rooms.filter((r): r is { name: string; title: string; team: Team } => r.team !== null && r.team.roles.length > 0)
    .map((r) => ({ r, layout: computeLayout(r.team, roomColumns(r.team)) }));
  const total = laid.reduce((s, x) => s + widthOf(x.layout.bounds), 0) + ROOM_GAP * Math.max(0, laid.length - 1);
  const mb = main.bounds;
  let left = (mb.minX + mb.maxX) / 2 - total / 2;
  for (const { r, layout } of laid) {
    const b = layout.bounds;
    const x = round(left - b.minX);
    const z = round(mb.minZ - CORRIDOR - b.maxZ);
    offices.push({ room: r.name, title: r.title || r.name, layout, x, z });
    left += widthOf(b) + ROOM_GAP;
  }
  const all = [mb, ...offices.map((o) => moved(o.layout.bounds, o.x, o.z))];
  const m = WALL_MARGIN + 0.2;
  return {
    main,
    rooms: offices,
    bounds: {
      minX: round(Math.min(...all.map((b) => b.minX)) - m),
      maxX: round(Math.max(...all.map((b) => b.maxX)) + m),
      minZ: round(Math.min(...all.map((b) => b.minZ)) - m),
      maxZ: round(Math.max(...all.map((b) => b.maxZ)) + m),
    },
  };
}

export function moved(b: Bounds, x: number, z: number): Bounds {
  return { minX: round(b.minX + x), maxX: round(b.maxX + x), minZ: round(b.minZ + z), maxZ: round(b.maxZ + z) };
}

// worldSignature changes when the 3D must be built again.
export function worldSignature(w: World): string {
  return JSON.stringify(w.rooms.map((o) => [o.room, o.x, o.z, o.layout.desks.map((d) => [d.name, d.x, d.z]), o.layout.links.map((l) => [l.from, l.to])]));
}

export type Side = 'back' | 'front' | 'left' | 'right';

// A wall of an office: from (x0, z0) to (x1, z1), with the direction it
// faces out of the office.
export interface Wall {
  side: Side;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  nx: number;
  nz: number;
}

// wallsOf are the four walls around an office's floor.
export function wallsOf(b: Bounds): Wall[] {
  const m = WALL_MARGIN;
  const x0 = b.minX - m;
  const x1 = b.maxX + m;
  const z0 = b.minZ - m;
  const z1 = b.maxZ + m;
  return [
    { side: 'back', x0, z0, x1, z1: z0, nx: 0, nz: -1 },
    { side: 'front', x0, z0: z1, x1, z1, nx: 0, nz: 1 },
    { side: 'left', x0, z0, x1: x0, z1, nx: -1, nz: 0 },
    { side: 'right', x0: x1, z0, x1, z1, nx: 1, nz: 0 },
  ];
}

// lowered says whether a wall stands between the camera and its office:
// the camera is outside it, on the side it faces. It is then drawn low,
// so that it hides nothing.
export function lowered(w: Wall, camX: number, camZ: number): boolean {
  const mx = (w.x0 + w.x1) / 2;
  const mz = (w.z0 + w.z1) / 2;
  return (camX - mx) * w.nx + (camZ - mz) * w.nz > 0;
}

// windowsOf are where a wall of length len has its windows, as the centres
// along it from its start: one every WINDOW_EVERY, none on a short wall.
export const WINDOW_WIDTH = 1.1;
export const WINDOW_EVERY = 2.6;

export function windowsOf(len: number): number[] {
  const n = Math.floor((len - 0.8) / WINDOW_EVERY);
  if (n <= 0) {
    return [];
  }
  const step = len / n;
  return Array.from({ length: n }, (_, i) => round(step * (i + 0.5)));
}

// The camera of the 3D: around a target on the floor, at a distance, an
// azimuth (0 looks from the side of the map's viewer, +z, positive turns
// toward +x) and a polar angle from straight above.
export interface Orbit {
  target: { x: number; y: number; z: number };
  distance: number;
  azimuth: number;
  polar: number;
}

export const ORBIT = {
  fov: 40,
  azimuth: 0.7,
  polar: 0.98,
  // Never under the floor nor straight down: the polar angle stays inside.
  minPolar: 0.2,
  maxPolar: 1.38,
  minDistance: 3,
  // The farthest is this many times the distance that holds everything.
  farther: 1.8,
  // A turn of the keys and the buttons, and how much nearer a step goes.
  turn: Math.PI / 12,
  tilt: Math.PI / 24,
  zoom: 1.25,
} as const;

// fitOrbit is the camera that holds the whole world in a view of aspect
// width/height, from the side of the map's viewer, turned a little: the
// nearest from which every corner of the offices, up to the top of their
// walls and labels, falls inside the view with a margin.
export function fitOrbit(b: Bounds, aspect: number): Orbit {
  const target = { x: round((b.minX + b.maxX) / 2), y: 0.5, z: round((b.minZ + b.maxZ) / 2) };
  const a = ORBIT.azimuth;
  const p = ORBIT.polar;
  // From the target toward the camera, the camera's right and its up.
  const back = [Math.sin(p) * Math.sin(a), Math.cos(p), Math.sin(p) * Math.cos(a)];
  const right = [Math.cos(a), 0, -Math.sin(a)];
  const up = [
    back[1] * right[2] - back[2] * right[1],
    back[2] * right[0] - back[0] * right[2],
    back[0] * right[1] - back[1] * right[0],
  ];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const tanV = Math.tan((ORBIT.fov * Math.PI) / 360) * FIT_MARGIN;
  const tanH = tanV * Math.max(0.1, aspect);
  let distance: number = ORBIT.minDistance;
  for (const x of [b.minX, b.maxX]) {
    for (const z of [b.minZ, b.maxZ]) {
      for (const y of [0, FIT_TOP]) {
        const q = [x - target.x, y - target.y, z - target.z];
        const along = dot(q, back);
        distance = Math.max(distance, along + Math.abs(dot(q, right)) / tanH, along + Math.abs(dot(q, up)) / tanV);
      }
    }
  }
  return { target, distance: round(distance), azimuth: a, polar: p };
}

// The share of the view the offices may fill, and how high they reach: the
// walls, and the labels over the heads.
const FIT_MARGIN = 0.92;
const FIT_TOP = 2.2;

// orbitPosition is where the camera of an orbit stands.
export function orbitPosition(o: Orbit): { x: number; y: number; z: number } {
  const s = Math.sin(o.polar);
  return {
    x: o.target.x + o.distance * s * Math.sin(o.azimuth),
    y: o.target.y + o.distance * Math.cos(o.polar),
    z: o.target.z + o.distance * s * Math.cos(o.azimuth),
  };
}

// clampTarget keeps the point the camera turns around over the world.
export function clampTarget(t: { x: number; y: number; z: number }, b: Bounds): { x: number; y: number; z: number } {
  return { x: Math.min(b.maxX, Math.max(b.minX, t.x)), y: t.y, z: Math.min(b.maxZ, Math.max(b.minZ, t.z)) };
}

// facing is the turn about y that makes a character at (x, z), facing +z,
// look at a point (px, pz).
export function facing(x: number, z: number, px: number, pz: number): number {
  return Math.atan2(px - x, pz - z);
}

// The page's views, and the one a browser remembers.
export type ViewMode = 'map' | '3d' | 'list';

export const VIEW_KEY = 'gosidian-office.view';

export function readViewMode(v: unknown): ViewMode {
  return v === '3d' || v === 'list' ? v : 'map';
}

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

// rememberedView is the view the browser chose last; the map when it has
// none or keeps nothing.
export function rememberedView(store: () => Store | null): ViewMode {
  try {
    return readViewMode(store()?.getItem(VIEW_KEY));
  } catch {
    return 'map';
  }
}

export function rememberView(store: () => Store | null, mode: ViewMode): void {
  try {
    store()?.setItem(VIEW_KEY, mode);
  } catch {
    // A browser that keeps nothing opens the map.
  }
}

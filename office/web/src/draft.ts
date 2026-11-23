// The draft of the map: the changes of the team the
// page sends over the bridge office/1, which gosidian's window keeps and
// the server checks, and what the window says of them. Nothing here
// touches the DOM.

import type { Problem, Role, RoleLive, TeamView } from './model';
import { readProblems } from './model';

export interface PaletteProfile {
  path: string;
  title: string;
  // The name a role writes: profile: reviewer, or a link.
  name: string;
  description: string;
  fields: Record<string, unknown>;
}

export interface PaletteNote {
  path: string;
  title: string;
}

// Palette is what the server offers to change the team with.
export interface Palette {
  profiles: PaletteProfile[];
  // The teams of the project that may become rooms.
  teams: PaletteNote[];
  // The executors of the accepted plugins.
  runs: string[];
  skills: PaletteNote[];
}

export interface Draft {
  ops: number;
  // The note changed under the draft since it began.
  rebased: boolean;
  block: string;
  line: number;
  creates: string[];
  problems: Problem[];
  palette: Palette;
}

// Op is one change of the team, as the server takes it.
export type Op =
  | { op: 'set'; role?: string; field: string; value: unknown }
  | { op: 'add_role'; role: string; profile?: string; run?: string }
  | { op: 'rename_role'; role: string; to: string }
  | { op: 'remove_role'; role: string }
  | { op: 'add_room'; room: string; path: string }
  | { op: 'create_room'; room: string; coordinator?: string; roles?: string[]; run?: string }
  | { op: 'remove_room'; room: string };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(o: Obj, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

function notes(v: unknown): PaletteNote[] {
  return Array.isArray(v)
    ? v.filter(isObj).map((n) => ({ path: str(field(n, 'path')), title: str(field(n, 'title')) })).filter((n) => n.path !== '')
    : [];
}

export function emptyPalette(): Palette {
  return { profiles: [], teams: [], runs: [], skills: [] };
}

function palette(v: unknown): Palette {
  if (!isObj(v)) {
    return emptyPalette();
  }
  const profiles = field(v, 'profiles');
  return {
    profiles: Array.isArray(profiles)
      ? profiles.filter(isObj).map((p) => {
          const f = field(p, 'fields');
          return {
            path: str(field(p, 'path')),
            title: str(field(p, 'title')),
            name: str(field(p, 'name')),
            description: str(field(p, 'description')),
            fields: isObj(f) ? f : {},
          };
        }).filter((p) => p.path !== '' && p.name !== '')
      : [],
    teams: notes(field(v, 'teams')),
    runs: strs(field(v, 'runs')),
    skills: notes(field(v, 'skills')),
  };
}

// readDraft reads the draft a team message carries; null when the window
// keeps none: the page shows the team as it is.
export function readDraft(v: unknown): Draft | null {
  if (!isObj(v) || field(v, 'editing') !== true) {
    return null;
  }
  const ops = field(v, 'ops');
  const line = field(v, 'line');
  return {
    ops: typeof ops === 'number' && Number.isInteger(ops) && ops >= 0 ? ops : 0,
    rebased: field(v, 'rebased') === true,
    block: str(field(v, 'block')),
    line: typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : 0,
    creates: strs(field(v, 'creates')),
    problems: readProblems(field(v, 'problems')),
    palette: palette(field(v, 'palette')),
  };
}

// listOf reads a list as a person writes it in a field: separated by
// commas or lines, each once.
export function listOf(text: string): string[] {
  const out: string[] = [];
  for (const x of text.split(/[,\n]/)) {
    const s = x.trim();
    if (s !== '' && !out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}

export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

// The fields a person changes on the map, as text, a choice, a flag or a
// list.
export const TEXT_FIELDS = ['run', 'model', 'effort', 'guide'] as const;
export const LIST_FIELDS = ['writes', 'skills', 'delegates_to'] as const;
export type EditField = (typeof TEXT_FIELDS)[number] | (typeof LIST_FIELDS)[number] | 'access' | 'review' | 'tools' | 'profile';

// own says whether the block writes field for the role; a server that
// does not say treats every field as the role's.
export function own(live: RoleLive | undefined, f: string): boolean {
  return live?.fields == null || live.fields.includes(f);
}

// profileOf is the palette's profile the role takes, by its note.
export function profileOf(p: Palette, role: Role): PaletteProfile | null {
  return role.profile === '' ? null : p.profiles.find((x) => x.path === role.profile) ?? null;
}

// fromProfile says whether the role's value of f is its profile's.
export function fromProfile(p: Palette, role: Role, live: RoleLive | undefined, f: string): boolean {
  const prof = profileOf(p, role);
  return !own(live, f) && prof !== null && Object.prototype.hasOwnProperty.call(prof.fields, f);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function current(role: Role, f: EditField): unknown {
  switch (f) {
    case 'review':
      return role.review;
    case 'tools':
      return role.tools;
    case 'profile':
      return role.profile;
    default:
      return (role as unknown as Record<string, unknown>)[f];
  }
}

// setOp is the change that gives the role value for f, as the person
// chose it; null when it changes nothing. An empty text or list takes the
// field away from the block, and the role has its profile's again; tools
// says [] for none, and away from the block every plugin of the project.
// profileHas: the role's profile gives f, so a review taken away is a
// review: false the block writes.
export function setOp(role: Role, live: RoleLive | undefined, f: EditField, value: unknown, profileHas = false): Op | null {
  let v = value;
  if (typeof v === 'string') {
    v = v.trim();
  }
  if (v === '' || v === undefined) {
    v = null;
  }
  if (Array.isArray(v) && v.length === 0 && f !== 'tools') {
    v = null;
  }
  if (f === 'review' && v === false && !profileHas) {
    v = null;
  }
  if (v === null) {
    // Only what the block writes goes away from it.
    return own(live, f) ? { op: 'set', role: role.name, field: f, value: null } : null;
  }
  if (same(v, current(role, f))) {
    return null;
  }
  return { op: 'set', role: role.name, field: f, value: v };
}

// resetOp takes f away from the role's block: it has its profile's again.
export function resetOp(role: Role, f: EditField): Op {
  return { op: 'set', role: role.name, field: f, value: null };
}

// delegateOp makes from delegate to to as well; null when it does already,
// or to is from.
export function delegateOp(view: TeamView, from: string, to: string): Op | null {
  const r = view.team?.roles.find((x) => x.name === from);
  if (!r || from === to || r.delegates_to.includes(to)) {
    return null;
  }
  return { op: 'set', role: from, field: 'delegates_to', value: [...r.delegates_to, to] };
}

// newName is a free name for a role or a room: base, or base-2, base-3…
export function newName(view: TeamView, base: string): string {
  const taken = new Set([...(view.team?.roles ?? []).map((r) => r.name), ...(view.team?.rooms ?? []).map((r) => r.name)]);
  const b = (base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 28) || 'ruolo').replace(/-+$/, '') || 'ruolo';
  if (!taken.has(b)) {
    return b;
  }
  for (let i = 2; ; i++) {
    if (!taken.has(`${b}-${i}`)) {
      return `${b}-${i}`;
    }
  }
}

// nameProblem says why a name cannot be a new role's or room's: a key of
// the page's catalog, or null.
export function nameProblem(view: TeamView, name: string): 'nameInvalid' | 'nameTaken' | null {
  if (!NAME_RE.test(name)) {
    return 'nameInvalid';
  }
  if ((view.team?.roles ?? []).some((r) => r.name === name) || (view.team?.rooms ?? []).some((r) => r.name === name)) {
    return 'nameTaken';
  }
  return null;
}

export interface BlockLine {
  // The line of the note.
  n: number;
  text: string;
  problems: Problem[];
}

// blockLines are the lines of the draft's block, each with its line in the
// note and the problems on it.
export function blockLines(d: Draft): BlockLine[] {
  const lines = d.block.replace(/\n$/, '').split('\n');
  return lines.map((text, i) => {
    const n = d.line + 1 + i;
    return { n, text, problems: d.problems.filter((p) => p.line === n) };
  });
}

// problemsOf are the draft's problems about the role or room name.
export function problemsOf(d: Draft | null, name: string): Problem[] {
  return d ? d.problems.filter((p) => p.role === name || p.room === name) : [];
}

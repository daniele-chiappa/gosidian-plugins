// The team as the window hands it (the answer of GET
// /api/v1/fleet/teams/<path>, docs/plugins.md, "The bridge office/1"),
// read defensively: whatever the message holds, the page gets these shapes
// and never a value of another type.

export type RoleState = 'working' | 'waiting' | 'held' | 'queued' | 'idle';

export const STATES: readonly RoleState[] = ['working', 'waiting', 'held', 'queued', 'idle'];

export interface Spend {
  cost_usd: number;
  tokens: number;
  steps: number;
}

export interface Role {
  name: string;
  agent: string;
  run: string;
  model: string;
  effort: string;
  max_turns: number;
  max_seconds: number;
  max_tokens: number;
  access: string;
  repo: string;
  host: string;
  paths: string[];
  forbid: string[];
  checks: string;
  preview: string;
  writes: string[];
  delegates_to: string[];
  approve: string;
  review: boolean;
  // The role's guide and skills, as the block names them.
  guide: string;
  skills: string[];
  // The profile whose fields it takes; "" for none.
  profile: string;
  // The plugins' tools its agent sees: null for every plugin of the
  // project, [] for none.
  tools: string[] | null;
}

export interface Team {
  path: string;
  coordinator: string;
  split: string;
  budget: { day_usd: number; task_usd: number };
  max_agents: number;
  max_rounds: number;
  reopen_on: string;
  alert: string[];
  approvers: string[];
  // The guide every role follows; "" for none.
  guide: string;
  // The rooms its roles give objectives to: a name, its note.
  rooms: Array<{ name: string; path: string }>;
  roles: Role[];
}

// RoomView is a room of the team: its team as the server reads it, null
// when its note is missing or the person may not read it.
export interface RoomView {
  name: string;
  path: string;
  view: TeamView | null;
}

export interface Task {
  path: string;
  title: string;
  status: string;
  waits: string;
}

export interface AgentNote {
  path: string;
  title: string;
  missing: boolean;
}

// The kinds of the notes a role's agent receives after its agent note.
export type NoteKind = 'profile' | 'team_guide' | 'guide' | 'skill' | 'room';

// RoleNote is a guide or a skill of a role, as the server read it.
export interface RoleNote extends AgentNote {
  kind: NoteKind;
  // A skill whose note is no note type: skill.
  not_skill: boolean;
}

export interface RoleLive {
  state: RoleState;
  agent: AgentNote | null;
  // The guides and skills its agent receives, in their order; empty from
  // a server that does not say them.
  notes: RoleNote[];
  // The tools it names whose plugin is not exposed in the project.
  unexposed_tools: string[];
  tasks: Task[];
  spent_today: Spend | null;
  // The fields the block writes for the role: the others it has are its
  // profile's. null from a server that does not say them.
  fields: string[] | null;
}

export interface Problem {
  line: number;
  message: string;
  // The role or the room it is about, "" for the team's.
  role: string;
  room: string;
}

export interface TeamView {
  path: string;
  title: string;
  line: number;
  team: Team | null;
  problems: Problem[];
  pipelines: boolean;
  spent_today: Spend | null;
  // A Map, not an object: a role named __proto__ is a role like another.
  roles: Map<string, RoleLive>;
  rooms: RoomView[];
  now: string;
  // Whether the person may change the team on the map.
  editable: boolean;
}

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

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function strs(v: unknown): string[] {
  if (typeof v === 'string') {
    return v === '' ? [] : [v];
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

// wikiPath is a vault path from an agent field: the server gives a path,
// a note may still say "[[esempio/agents/capo]]".
function wikiPath(v: unknown): string {
  const s = str(v).trim();
  const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(s);
  if (!m) {
    return s;
  }
  const p = m[1].trim();
  return p.endsWith('.md') ? p : p + '.md';
}

function spend(v: unknown): Spend | null {
  if (!isObj(v)) {
    return null;
  }
  return { cost_usd: num(field(v, 'cost_usd')), tokens: num(field(v, 'tokens')), steps: num(field(v, 'steps')) };
}

export function readState(v: unknown): RoleState {
  return typeof v === 'string' && (STATES as readonly string[]).includes(v) ? (v as RoleState) : 'idle';
}

function role(name: string, o: Obj): Role {
  return {
    name,
    agent: wikiPath(field(o, 'agent')),
    run: str(field(o, 'run')),
    model: str(field(o, 'model')),
    effort: str(field(o, 'effort')),
    max_turns: num(field(o, 'max_turns')),
    max_seconds: num(field(o, 'max_seconds')),
    max_tokens: num(field(o, 'max_tokens')),
    access: str(field(o, 'access')),
    repo: str(field(o, 'repo')),
    host: str(field(o, 'host')),
    paths: strs(field(o, 'paths')),
    forbid: strs(field(o, 'forbid')),
    checks: str(field(o, 'checks')),
    preview: str(field(o, 'preview')),
    writes: strs(field(o, 'writes')),
    delegates_to: strs(field(o, 'delegates_to')),
    approve: str(field(o, 'approve')),
    review: field(o, 'review') === true,
    guide: wikiPath(field(o, 'guide')),
    skills: strs(field(o, 'skills')).map(wikiPath).filter((p) => p !== ''),
    tools: Array.isArray(field(o, 'tools')) ? strs(field(o, 'tools')) : null,
    profile: wikiPath(field(o, 'profile')),
  };
}

// roles reads the roles in the block's order: a list of roles with their
// name, as the server gives them, or a map by name, as the block writes it.
function roles(v: unknown): Role[] {
  const out: Role[] = [];
  const seen = new Set<string>();
  const add = (name: string, o: unknown) => {
    if (name === '' || seen.has(name) || !isObj(o)) {
      return;
    }
    seen.add(name);
    out.push(role(name, o));
  };
  if (Array.isArray(v)) {
    for (const r of v) {
      if (isObj(r)) {
        add(str(field(r, 'name')), r);
      }
    }
  } else if (isObj(v)) {
    for (const [name, r] of Object.entries(v)) {
      add(name, r);
    }
  }
  return out;
}

function team(v: unknown): Team | null {
  if (!isObj(v)) {
    return null;
  }
  const b = field(v, 'budget');
  const budget = isObj(b) ? b : {};
  return {
    path: str(field(v, 'path')),
    coordinator: str(field(v, 'coordinator')),
    split: str(field(v, 'split')),
    budget: { day_usd: num(field(budget, 'day_usd')), task_usd: num(field(budget, 'task_usd')) },
    max_agents: num(field(v, 'max_agents')),
    max_rounds: num(field(v, 'max_rounds')),
    reopen_on: str(field(v, 'reopen_on')),
    alert: strs(field(v, 'alert')),
    approvers: strs(field(v, 'approvers')),
    guide: wikiPath(field(v, 'guide')),
    rooms: (Array.isArray(field(v, 'rooms')) ? (field(v, 'rooms') as unknown[]) : []).filter(isObj)
      .map((r) => ({ name: str(field(r, 'name')), path: wikiPath(field(r, 'path')) }))
      .filter((r) => r.name !== '' && r.path !== ''),
    roles: roles(field(v, 'roles')),
  };
}

function readKind(v: unknown): NoteKind {
  return v === 'profile' || v === 'team_guide' || v === 'skill' ? v : 'guide';
}

function live(v: unknown): RoleLive {
  const o = isObj(v) ? v : {};
  const a = field(o, 'agent');
  const tasks = field(o, 'tasks');
  const notes = field(o, 'notes');
  return {
    state: readState(field(o, 'state')),
    agent: isObj(a)
      ? { path: str(field(a, 'path')), title: str(field(a, 'title')), missing: field(a, 'missing') === true }
      : null,
    notes: Array.isArray(notes)
      ? notes.filter(isObj).map((x) => ({
          path: str(field(x, 'path')),
          title: str(field(x, 'title')),
          missing: field(x, 'missing') === true,
          kind: readKind(field(x, 'kind')),
          not_skill: field(x, 'not_skill') === true,
        })).filter((x) => x.path !== '')
      : [],
    unexposed_tools: strs(field(o, 'unexposed_tools')),
    tasks: Array.isArray(tasks)
      ? tasks.filter(isObj).map((x) => ({
          path: str(field(x, 'path')),
          title: str(field(x, 'title')),
          status: str(field(x, 'status')),
          waits: str(field(x, 'waits')),
        })).filter((x) => x.path !== '')
      : [],
    spent_today: spend(field(o, 'spent_today')),
    fields: Array.isArray(field(o, 'fields')) ? strs(field(o, 'fields')) : null,
  };
}

// readProblems reads the problems of a team, or of a draft.
export function readProblems(v: unknown): Problem[] {
  return Array.isArray(v)
    ? v.filter(isObj).map((p) => ({ line: num(field(p, 'line')), message: str(field(p, 'message')),
        role: str(field(p, 'role')), room: str(field(p, 'room')) }))
        .filter((p) => p.message !== '')
    : [];
}

// normalizeView reads the team of a message; null when it is not one.
export function normalizeView(raw: unknown): TeamView | null {
  if (!isObj(raw)) {
    return null;
  }
  const problems = field(raw, 'problems');
  const rolesLive = new Map<string, RoleLive>();
  const rl = field(raw, 'roles');
  if (isObj(rl)) {
    for (const [name, v] of Object.entries(rl)) {
      rolesLive.set(name, live(v));
    }
  }
  const tm = team(field(raw, 'team'));
  // Every role of the team has its live part, idle when the server said
  // nothing of it.
  for (const r of tm?.roles ?? []) {
    if (!rolesLive.has(r.name)) {
      rolesLive.set(r.name, live({}));
    }
  }
  const rawRooms = field(raw, 'rooms');
  const rooms: RoomView[] = [];
  for (const r of Array.isArray(rawRooms) ? rawRooms.filter(isObj) : []) {
    const name = str(field(r, 'name'));
    if (name === '') {
      continue;
    }
    const rv = field(r, 'view');
    // A room's view has no rooms of its own: a room has none.
    const view = isObj(rv) ? normalizeView({ ...rv, rooms: [] }) : null;
    rooms.push({ name, path: wikiPath(field(r, 'path')), view });
  }
  const pipelines = field(raw, 'pipelines') !== false;
  return {
    path: str(field(raw, 'path')),
    title: str(field(raw, 'title')),
    line: num(field(raw, 'line')),
    team: tm,
    problems: readProblems(problems),
    pipelines,
    spent_today: pipelines ? spend(field(raw, 'spent_today')) : null,
    roles: rolesLive,
    rooms,
    now: str(field(raw, 'now')),
    editable: field(raw, 'editable') === true,
  };
}

// ROOM_ORDER is which state of its roles a room shows: the one that asks
// most of a person first.
const ROOM_ORDER: readonly RoleState[] = ['waiting', 'held', 'working', 'queued', 'idle'];

// roomOf is the room named name of the view, if it is one.
export function roomOf(view: TeamView, name: string): RoomView | null {
  return view.rooms.find((r) => r.name === name) ?? null;
}

// stateOf is a role's state as the page shows it: with the pipelines off
// nothing waits. A room's is the state of its roles that asks most.
export function stateOf(view: TeamView, name: string): RoleState {
  const room = roomOf(view, name);
  if (room) {
    const rv = room.view;
    if (!rv?.team) {
      return 'idle';
    }
    const states = rv.team.roles.map((r) => stateOf(rv, r.name));
    return ROOM_ORDER.find((s) => states.includes(s)) ?? 'idle';
  }
  const s = view.roles.get(name)?.state ?? 'idle';
  if (!view.pipelines && (s === 'waiting' || s === 'held')) {
    return 'idle';
  }
  return s;
}

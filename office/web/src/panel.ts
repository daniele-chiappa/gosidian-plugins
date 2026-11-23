// What the side panel shows of a role: its fields, its open tasks and its
// agent note, in words of the page's language. The DOM is built from this.

import type { Lang } from './i18n';
import { amount, integer, money, t } from './i18n';
import type { AgentNote, NoteKind, Role, RoleNote, RoleState, Team, TeamView } from './model';
import { roomOf, stateOf } from './model';
import { stateLabel } from './states';
import { ROLE_COLORS } from './layout';

export interface PanelField {
  key: string;
  label: string;
  value: string;
}

export interface PanelTask {
  path: string;
  title: string;
  status: string;
  waits: string;
  // The button's accessible name.
  label: string;
}

// PanelNote is a guide or a skill of the role, to open by its path.
export interface PanelNote {
  path: string;
  title: string;
  kind: NoteKind;
  kindLabel: string;
  missing: boolean;
  notSkill: boolean;
  // The button's accessible name.
  label: string;
}

export interface PanelModel {
  // A room of the team, not a role: no agent note.
  room: boolean;
  name: string;
  color: string;
  state: RoleState;
  stateLabel: string;
  coordinator: boolean;
  fields: PanelField[];
  tasks: PanelTask[];
  agent: (AgentNote & { label: string }) | null;
  // The guides and skills its agent receives, in their order.
  notes: PanelNote[];
  // Today's spend in words; null with the pipelines off.
  spent: string | null;
}

function list(v: string[]): string {
  return v.join(', ');
}

function fields(lang: Lang, r: Role, unexposed: string[]): PanelField[] {
  const out: PanelField[] = [];
  const add = (key: string, value: string) => {
    if (value !== '') {
      out.push({ key, label: t(lang, `field.${key}` as Parameters<typeof t>[1]), value });
    }
  };
  add('run', r.run);
  add('model', r.model);
  add('effort', r.effort);
  add('access', r.access);
  add('repo', r.repo);
  add('host', r.host);
  add('paths', list(r.paths));
  add('forbid', list(r.forbid));
  add('writes', list(r.writes));
  add('delegates_to', list(r.delegates_to));
  if (r.tools !== null) {
    let tools = r.tools.length > 0 ? list(r.tools) : t(lang, 'noTools');
    if (unexposed.length > 0) {
      tools += ' · ' + t(lang, 'unexposedTools', { tools: list(unexposed) });
    }
    add('tools', tools);
  }
  add('approve', r.approve);
  add('review', r.review ? t(lang, 'yes') : '');
  add('checks', r.checks);
  add('preview', r.preview);
  const limits: string[] = [];
  if (r.max_turns > 0) {
    limits.push(t(lang, 'limitTurns', { n: integer(lang, r.max_turns) }));
  }
  if (r.max_seconds > 0) {
    limits.push(t(lang, 'limitSeconds', { n: integer(lang, r.max_seconds) }));
  }
  if (r.max_tokens > 0) {
    limits.push(t(lang, 'limitTokens', { n: amount(lang, r.max_tokens) }));
  }
  add('limits', limits.join(' · '));
  return out;
}

// blockNotes are a role's profile, guides and skills as the block names
// them, for a server that does not say them: the profile, the team's
// guide, the role's, its skills, each once.
function blockNotes(team: Team, r: Role): RoleNote[] {
  const out: RoleNote[] = [];
  const add = (path: string, kind: NoteKind) => {
    if (path !== '' && !out.some((n) => n.path === path)) {
      out.push({ path, title: path.replace(/^.*\//, '').replace(/\.md$/, ''), missing: false, kind, not_skill: false });
    }
  };
  add(r.profile, 'profile');
  add(team.guide, 'team_guide');
  add(r.guide, 'guide');
  for (const s of r.skills) {
    add(s, 'skill');
  }
  return out;
}

// roomPanel is the panel of a room: its team, its roles and
// their states, their open tasks, the note that opens its own office.
function roomPanel(view: TeamView, name: string, lang: Lang): PanelModel | null {
  const team = view.team;
  const i = team?.rooms.findIndex((r) => r.name === name) ?? -1;
  const room = roomOf(view, name);
  if (!team || i < 0 || !room) {
    return null;
  }
  const rv = room.view;
  const state = stateOf(view, name);
  const fields: PanelField[] = [{ key: 'room', label: t(lang, 'field.room'), value: room.path }];
  const tasks: PanelTask[] = [];
  if (rv?.team) {
    const roles = rv.team.roles.map((r) => {
      const who = r.name === rv.team?.coordinator ? `${r.name} (${t(lang, 'coordinates')})` : r.name;
      return `${who}: ${stateLabel(lang, stateOf(rv, r.name))}`;
    });
    fields.push({ key: 'roles', label: t(lang, 'field.roles'), value: roles.join(', ') });
    for (const r of rv.team.roles) {
      for (const x of rv.roles.get(r.name)?.tasks ?? []) {
        const title = x.title || x.path;
        tasks.push({ path: x.path, title, status: `${r.name} · ${x.status}`, waits: rv.pipelines ? x.waits : '', label: t(lang, 'openTask', { title }) });
      }
    }
  } else {
    fields.push({ key: 'roles', label: t(lang, 'field.roles'), value: t(lang, 'roomUnreadable') });
  }
  const title = rv?.title || name;
  const notes: PanelNote[] = [{ path: room.path, title, kind: 'room', kindLabel: t(lang, 'kind.room'), missing: rv === null,
    notSkill: false, label: t(lang, 'openRoleNote', { title }) + (rv === null ? ` (${t(lang, 'missing')})` : '') }];
  let spent: string | null = null;
  if (view.pipelines) {
    const s = rv?.spent_today ?? { cost_usd: 0, tokens: 0, steps: 0 };
    spent = t(lang, 'spendDetail', { cost: money(lang, s.cost_usd), tokens: amount(lang, s.tokens), steps: integer(lang, s.steps) });
  }
  return {
    name,
    color: ROLE_COLORS[(team.roles.length + i) % ROLE_COLORS.length],
    state,
    stateLabel: stateLabel(lang, state),
    room: true,
    coordinator: false,
    fields,
    tasks,
    agent: null,
    notes,
    spent,
  };
}

// panelModel is the panel of the role or room name; null when the team has
// none.
export function panelModel(view: TeamView, name: string, lang: Lang): PanelModel | null {
  if (roomOf(view, name)) {
    return roomPanel(view, name, lang);
  }
  const team = view.team;
  const i = team?.roles.findIndex((r) => r.name === name) ?? -1;
  if (!team || i < 0) {
    return null;
  }
  const r = team.roles[i];
  const live = view.roles.get(name);
  const state = stateOf(view, name);
  let note: AgentNote | null = null;
  if (live?.agent && live.agent.path !== '') {
    note = live.agent;
  } else if (r.agent !== '') {
    note = { path: r.agent, title: r.agent.replace(/^.*\//, '').replace(/\.md$/, ''), missing: false };
  }
  let agent: PanelModel['agent'] = null;
  if (note) {
    const title = note.title || note.path;
    agent = { ...note, title, label: t(lang, 'openAgent', { title }) + (note.missing ? ` (${t(lang, 'missing')})` : '') };
  }
  const given = live?.notes ?? [];
  const notes: PanelNote[] = (given.length > 0 ? given : blockNotes(team, r)).map((n) => {
    const title = n.title || n.path;
    let label = t(lang, 'openRoleNote', { title });
    if (n.missing) {
      label += ` (${t(lang, 'missing')})`;
    } else if (n.not_skill) {
      label += ` (${t(lang, 'notSkill')})`;
    }
    return { path: n.path, title, kind: n.kind, kindLabel: t(lang, `kind.${n.kind}`), missing: n.missing, notSkill: n.not_skill, label };
  });
  const tasks: PanelTask[] = (live?.tasks ?? []).map((x) => {
    const title = x.title || x.path;
    const waits = view.pipelines ? x.waits : '';
    return { path: x.path, title, status: x.status, waits, label: t(lang, 'openTask', { title }) };
  });
  let spent: string | null = null;
  if (view.pipelines) {
    const s = live?.spent_today ?? { cost_usd: 0, tokens: 0, steps: 0 };
    spent = t(lang, 'spendDetail', { cost: money(lang, s.cost_usd), tokens: amount(lang, s.tokens), steps: integer(lang, s.steps) });
  }
  return {
    name,
    color: ROLE_COLORS[i % ROLE_COLORS.length],
    state,
    stateLabel: stateLabel(lang, state),
    room: false,
    coordinator: team.coordinator === name,
    fields: fields(lang, r, live?.unexposed_tools ?? []),
    tasks,
    agent,
    notes,
    spent,
  };
}

// roleCost is the short cost under a role's name on the map and in the
// list; empty with the pipelines off.
export function roleCost(view: TeamView, name: string, lang: Lang): string {
  if (!view.pipelines) {
    return '';
  }
  const room = roomOf(view, name);
  if (room) {
    return money(lang, room.view?.spent_today?.cost_usd ?? 0);
  }
  return money(lang, view.roles.get(name)?.spent_today?.cost_usd ?? 0);
}

// roleLabel is the accessible name of a role on the map and in the list.
export function roleLabel(view: TeamView, name: string, lang: Lang): string {
  const parts = [name];
  if (roomOf(view, name)) {
    parts.push(t(lang, 'room'));
  } else if (view.team?.coordinator === name) {
    parts.push(t(lang, 'coordinates'));
  }
  parts.push(stateLabel(lang, stateOf(view, name)));
  const cost = roleCost(view, name, lang);
  if (cost !== '') {
    parts.push(cost);
  }
  return parts.join(', ');
}

// budgetText is the header's budget of the day.
export function budgetText(view: TeamView, lang: Lang): { text: string; ratio: number | null } | null {
  if (!view.pipelines || !view.team) {
    return null;
  }
  const spent = view.spent_today?.cost_usd ?? 0;
  const day = view.team.budget.day_usd;
  if (day <= 0) {
    return { text: t(lang, 'spentNoLimit', { spent: money(lang, spent) }), ratio: null };
  }
  return { text: t(lang, 'spentOf', { spent: money(lang, spent), budget: money(lang, day) }), ratio: Math.min(1, spent / day) };
}

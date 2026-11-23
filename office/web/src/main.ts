// The page of the office: the header with the team's numbers, the map (a
// canvas with a button over each role), the 3D (the same office seen by a
// camera that turns around it, with its rooms' offices) or the
// list of the roles, and the panel of the selected role. It reads what gosidian's window sends over
// the bridge office/1: open and refresh are requests, and the changes of
// the team a draft the window keeps and only the window saves.

import type { Incoming, Outgoing, Theme } from './bridge';
import { accept, edit as editMsg, open as openMsg, post, readParams, ready, refresh as refreshMsg } from './bridge';
import type { Lang } from './i18n';
import { clock, t } from './i18n';
import type { OfficeLayout } from './layout';
import type { LabelSize } from './layout';
import { LABEL_MARGIN, columnsFor, computeLayout, labelRoom, neighbor, signature } from './layout';
import type { RoleState, TeamView } from './model';
import { STATES, normalizeView, roomOf, stateOf } from './model';
import { budgetText, panelModel, roleCost, roleLabel } from './panel';
import type { Draft } from './draft';
import { delegateOp, problemsOf } from './draft';
import type { EditorHost } from './editor';
import {
  DRAG_PROFILE, DRAG_ROLE, TEAM, addProfile, clearEdit, renderDraftBar, renderRoleEdit, renderRoomEdit, renderTeamEdit,
  setStatus, takePending, toggleEditing, wantSelected, wireDraftBar,
} from './editor';
import type { Projected } from './scene';
import { OfficeScene } from './scene';
import type { ViewMode, World } from './world';
import { moved, rememberView, rememberedView, roomRoleKey, splitKey, worldLayout, worldSignature } from './world';
import { countStates, marker, shapeParts, stateHelp, stateLabel } from './states';
import demo from './demo.json';

const SVG = 'http://www.w3.org/2000/svg';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error('missing #' + id);
  }
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

// markerIcon is a state's marker as an SVG, hidden from screen readers:
// the state is always said in words beside it or in the button's name.
function markerIcon(state: RoleState, size = 18): SVGSVGElement {
  const m = marker(state);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('marker', 'marker-' + state);
  shapeParts(m.shape).forEach((p, i) => {
    const node = document.createElementNS(SVG, p.tag);
    for (const [k, v] of Object.entries(p.attrs)) {
      node.setAttribute(k, v);
    }
    if (p.fill === 'color') {
      node.setAttribute('fill', m.color);
    } else if (p.fill === 'mark') {
      node.setAttribute('fill', '#ffffff');
    } else {
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke', m.color);
    }
    if (i === 0) {
      node.classList.add('sil');
    }
    svg.appendChild(node);
  });
  return svg;
}

// --- state of the page ---

const params = readParams(location.search, navigator.language);
const parentWin: Window | null = window.parent !== window ? window.parent : null;
const connected = params.origin !== null && parentWin !== null;
let lang: Lang = params.lang;
let view: TeamView | null = null;
// The window's draft of the team, while the person edits it.
let draft: Draft | null = null;
let layout: OfficeLayout | null = null;
let layoutSig = '';
let selected: string | null = null;
let panelOpen = false;
let mode: ViewMode = 'map';
// The 3D's plan: the team's office and its rooms'.
let world: World | null = null;
let hostTheme: Theme | null = null;
let errorText: string | null = null;
let scene: OfficeScene | null = null;
let sceneReady = false;
let prevStates = new Map<string, RoleState>();
// What the labels of the rows ask, as last measured: the columns are
// chosen so that they fit.
let labelSize: LabelSize = { whole: 108, least: 108, height: 26 };
// A name cut to a few letters and its ellipsis, in CSS pixels.
const NAME_LEAST = 30;
const labels = new Map<string, HTMLButtonElement>();
// The labels of the rooms' people and the rooms' signs, in the 3D.
const roomLabels = new Map<string, HTMLButtonElement>();
const signs = new Map<string, HTMLElement>();
const listButtons = new Map<string, HTMLButtonElement>();
// Where a press on the 3D began: a drag turns the camera, it selects nothing.
let pressAt: { x: number; y: number } | null = null;

// storage is where the browser keeps the view it chose last.
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

const stage = $('stage');
const canvas = $<HTMLCanvasElement>('map');
const labelsBox = $('labels');
const signsBox = $('signs');
const cameraBar = $('camera');
const listBox = $('list');
const listItems = $('list-items');
const panel = $('panel');
const live = $('live');

function send(msg: Outgoing): void {
  if (params.demo) {
    live.textContent = t(lang, 'demoNoop');
    return;
  }
  post(parentWin, params.origin, msg);
}

const host: EditorHost = {
  lang: () => lang,
  view: () => view,
  draft: () => draft,
  send,
  select: (name) => select(name, { open: true }),
  announce: (text) => {
    live.textContent = text;
  },
};

// The fields the panel's form changes: the others the panel still shows.
const EDITED = new Set(['run', 'model', 'effort', 'access', 'writes', 'delegates_to', 'tools', 'review']);

// --- theme and language ---

function applyTheme(): void {
  const theme: Theme = hostTheme ?? (darkScheme.matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  scene?.setTheme(theme);
}

function applyStaticText(): void {
  document.documentElement.lang = lang;
  $('view-map').textContent = t(lang, 'viewMap');
  $('view-3d').textContent = t(lang, 'view3d');
  $('view-list').textContent = t(lang, 'viewList');
  cameraBar.setAttribute('aria-label', t(lang, 'camLabel'));
  for (const [id, key, icon] of [['cam-left', 'camLeft', '⟲'], ['cam-right', 'camRight', '⟳'], ['cam-in', 'camIn', '+'], ['cam-out', 'camOut', '−']] as const) {
    const b = $(id);
    b.textContent = icon;
    b.setAttribute('aria-label', t(lang, key));
    b.title = t(lang, key);
  }
  $('cam-reset').textContent = t(lang, 'camReset');
  $('view-group').setAttribute('aria-label', t(lang, 'viewLabel'));
  $('refresh').textContent = t(lang, 'refresh');
  $('open-note').textContent = t(lang, 'openNote');
  $('delegate-hint').textContent = t(lang, 'delegateHint');
  $('panel-close').textContent = '×';
  $('panel-close').setAttribute('aria-label', t(lang, 'close'));
  $('panel-close').title = t(lang, 'close');
  $('demo-badge').textContent = t(lang, 'demoBadge');
  $('budget-label').textContent = t(lang, 'budgetDay');
  $('agents-label').textContent = t(lang, 'maxAgents');
  $('problems-title').textContent = t(lang, 'problems');
  $('legend-title').textContent = t(lang, 'legend');
  applyKeysHint();
  $('panel-fields-title').textContent = t(lang, 'roleFields');
  $('panel-tasks-title').textContent = t(lang, 'tasks');
  $('panel-agent-title').textContent = t(lang, 'agentNote');
  $('panel-notes-title').textContent = t(lang, 'roleNotes');
  labelsBox.setAttribute('aria-label', t(lang, 'roles'));
  listItems.setAttribute('aria-label', t(lang, 'roles'));
  const legend = $('legend-list');
  legend.replaceChildren();
  for (const s of STATES) {
    const li = el('li');
    li.append(markerIcon(s, 16), el('strong', undefined, stateLabel(lang, s)), el('span', 'muted', stateHelp(lang, s)));
    legend.appendChild(li);
  }
}

function notice(text: string | null, link?: { href: string; text: string }): void {
  const n = $('notice');
  n.replaceChildren();
  n.hidden = text === null;
  if (text !== null) {
    n.append(text);
    if (link) {
      const a = el('a', undefined, link.text);
      a.href = link.href;
      n.append(' ', a);
    }
  }
}

// --- rendering ---

function title(v: TeamView): string {
  return v.title || v.path.replace(/^.*\//, '').replace(/\.md$/, '') || t(lang, 'appTitle');
}

function render(): void {
  if (errorText !== null) {
    notice(t(lang, 'errorPrefix', { message: errorText || t(lang, 'malformed') }));
  } else if (view === null) {
    notice(connected ? t(lang, 'waitingTeam') : t(lang, 'notFramed'),
      connected ? undefined : { href: '?demo&lang=' + lang, text: t(lang, 'demoLink') });
  } else {
    notice(null);
  }
  $('demo-badge').hidden = !params.demo;
  ($('refresh') as HTMLButtonElement).disabled = !connected && !params.demo;
  if (view === null) {
    $('body').hidden = true;
    $('legend').hidden = true;
    $('facts').hidden = true;
    document.title = t(lang, 'appTitle');
    return;
  }
  const v = view;
  const name = title(v);
  $('title').textContent = name;
  document.title = name + ' · ' + t(lang, 'appTitle');
  const openNote = $('open-note');
  openNote.hidden = v.path === '';
  const toggle = $('edit-toggle');
  toggle.hidden = !connected || !v.editable || v.team === null;
  toggle.textContent = t(lang, draft ? 'editEnd' : 'edit');
  toggle.setAttribute('aria-pressed', String(draft !== null));
  // The 3D is for looking: it waits for the end of the changes.
  const view3d = $<HTMLButtonElement>('view-3d');
  view3d.disabled = draft !== null;
  view3d.title = draft !== null ? t(lang, 'view3dEditing') : '';
  document.body.classList.toggle('editing', draft !== null);
  $('delegate-hint').hidden = draft === null;
  renderDraftBar(host);

  const team = v.team;
  const coord = $('coordinator');
  coord.hidden = team === null;
  if (team) {
    const has = team.roles.some((r) => r.name === team.coordinator);
    coord.textContent = t(lang, 'coordinator') + ': ' + (has ? team.coordinator : t(lang, 'noCoordinator'));
  }

  const facts = $('facts');
  facts.hidden = team === null;
  if (team) {
    const b = budgetText(v, lang);
    $('budget-fact').hidden = b === null;
    if (b) {
      $('budget-text').textContent = b.text;
      const bar = $('budget-bar');
      bar.hidden = b.ratio === null;
      const fill = $('budget-fill');
      fill.style.width = `${Math.round((b.ratio ?? 0) * 100)}%`;
      fill.classList.toggle('over', (b.ratio ?? 0) >= 1);
    }
    $('agents-text').textContent = team.max_agents > 0 ? String(team.max_agents) : t(lang, 'noLimit');
  }

  const off = $('pipelines-off');
  off.hidden = v.pipelines || team === null;
  off.textContent = t(lang, 'pipelinesOff');

  // With a draft, what keeps it from being saved: the block's problems,
  // and those of the notes it names, each on its role or room.
  const shown = draft ? draft.problems : v.problems;
  const probs = $('problems');
  probs.hidden = shown.length === 0 && team !== null;
  $('problems-title').textContent = t(lang, draft ? 'draftProblems' : 'problems');
  const plist = $('problems-list');
  plist.replaceChildren();
  if (team === null && shown.length === 0) {
    plist.appendChild(el('li', undefined, t(lang, 'teamUnreadable')));
  }
  for (const p of shown) {
    const li = el('li');
    const who = p.role || p.room;
    if (who !== '' && team && (team.roles.some((r) => r.name === who) || team.rooms.some((r) => r.name === who))) {
      const b = el('button', 'link', who);
      b.type = 'button';
      b.addEventListener('click', () => select(who, { open: true }));
      li.append(b, ' ');
    }
    if (p.line > 0) {
      li.appendChild(el('span', 'line', t(lang, 'problemLine', { line: p.line })));
      li.append(' ');
    }
    li.append(p.message);
    plist.appendChild(li);
  }

  $('body').hidden = team === null;
  $('legend').hidden = team === null;
  $('updated').textContent = v.now ? t(lang, 'updatedAt', { time: clock(lang, v.now) }) : '';
  if (team === null) {
    closePanel(false);
    return;
  }
  if (selected !== null && !(selected === TEAM && draft) && !known(selected)) {
    selected = null;
    closePanel(false);
  }
  relayout(false);
  updateRoles();
  arrange();
  renderPanel();
  // A role the draft added or renamed opens once the team has it.
  const next = takePending(v);
  if (next !== null) {
    select(next, { open: true });
  }
}

// known says whether key is a role or room of the team, or, in the 3D, a
// role of one of its rooms.
function known(key: string): boolean {
  const team = view?.team;
  if (!view || !team) {
    return false;
  }
  const { room, name } = splitKey(key);
  if (room === null) {
    return team.roles.some((r) => r.name === name) || team.rooms.some((r) => r.name === name);
  }
  return mode === '3d' && (roomOf(view, room)?.view?.team?.roles.some((r) => r.name === name) ?? false);
}

// relayout places the desks for the map's width, and the rooms' offices
// behind them for the 3D; the scene is built again only when the plan
// changed.
function relayout(force: boolean): void {
  if (!view?.team) {
    return;
  }
  const width = stage.clientWidth || listBox.clientWidth || window.innerWidth;
  const height = stage.clientHeight || window.innerHeight;
  const next = computeLayout(view.team, columnsFor(view.team, width, height, labelSize));
  const nextWorld = worldLayout(next, view.rooms.map((r) => ({ name: r.name, title: r.view?.title ?? '', team: r.view?.team ?? null })));
  const sig = signature(next) + worldSignature(nextWorld);
  layout = next;
  world = nextWorld;
  if (sig === layoutSig && !force) {
    return;
  }
  layoutSig = sig;
  buildLabels();
  buildList();
  if (scene && sceneReady) {
    scene.build(nextWorld);
    scene.setSelected(selected);
  }
}

function focusTarget(): string | null {
  return selected ?? layout?.order[0] ?? null;
}

function buildLabels(): void {
  labels.clear();
  labelsBox.replaceChildren();
  for (const name of layout?.order ?? []) {
    const b = el('button', 'label');
    b.type = 'button';
    b.dataset.role = name;
    // Shown once a frame placed it over its character; laid out before,
    // so that its width can be measured.
    b.classList.add('unplaced');
    b.addEventListener('click', () => select(name, { open: true }));
    b.addEventListener('keydown', (e) => onRoleKey(e, name));
    dragDelegation(b, name);
    labels.set(name, b);
    labelsBox.appendChild(b);
  }
  roomLabels.clear();
  signs.clear();
  signsBox.replaceChildren();
  for (const o of world?.rooms ?? []) {
    for (const name of o.layout.order) {
      const key = roomRoleKey(o.room, name);
      const b = el('button', 'label in-room unplaced');
      b.type = 'button';
      b.dataset.role = key;
      b.addEventListener('click', () => select(key, { open: true }));
      b.addEventListener('keydown', (e) => onRoleKey(e, key));
      roomLabels.set(key, b);
      labelsBox.appendChild(b);
    }
    const sign = el('div', 'sign unplaced', o.title);
    signs.set(o.room, sign);
    signsBox.appendChild(sign);
  }
}

function buildList(): void {
  listButtons.clear();
  listItems.replaceChildren();
  for (const name of layout?.order ?? []) {
    const li = el('li');
    const b = el('button', 'row');
    b.type = 'button';
    b.dataset.role = name;
    b.addEventListener('click', () => select(name, { open: true }));
    b.addEventListener('keydown', (e) => onRoleKey(e, name));
    dragDelegation(b, name);
    listButtons.set(name, b);
    li.appendChild(b);
    listItems.appendChild(li);
  }
}

// dragDelegation lets a role's button, while the team is edited, be dragged
// onto another's: the one dragged delegates to the other. A profile
// dropped on a role is a role added, as on the map.
function dragDelegation(b: HTMLButtonElement, name: string): void {
  b.addEventListener('dragstart', (e) => {
    if (!draft || !e.dataTransfer) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(DRAG_ROLE, name);
    e.dataTransfer.effectAllowed = 'link';
  });
  b.addEventListener('dragover', (e) => {
    if (draft && e.dataTransfer && (e.dataTransfer.types.includes(DRAG_ROLE) || e.dataTransfer.types.includes(DRAG_PROFILE))) {
      e.preventDefault();
      b.classList.add('drop');
    }
  });
  b.addEventListener('dragleave', () => b.classList.remove('drop'));
  b.addEventListener('drop', (e) => {
    b.classList.remove('drop');
    if (!draft || !view || !e.dataTransfer) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const profile = e.dataTransfer.getData(DRAG_PROFILE);
    if (profile !== '') {
      addProfile(host, profile);
      return;
    }
    const from = e.dataTransfer.getData(DRAG_ROLE);
    const op = from !== '' ? delegateOp(view, from, name) : null;
    if (op) {
      send(editMsg(op));
      live.textContent = t(lang, 'delegated', { from, to: name });
    }
  });
}

// updateRoles writes each role's state and cost in its button on the map
// and in the list, and the map's summary.
function updateRoles(): void {
  if (!view?.team || !layout) {
    return;
  }
  const v = view;
  const team = view.team;
  const target = focusTarget();
  // Every character's state, for the 3D's motion.
  const states = new Map<string, RoleState>();
  for (const d of layout.desks) {
    const state = stateOf(v, d.name);
    states.set(d.name, state);
    const cost = roleCost(v, d.name, lang);
    const bad = problemsOf(draft, d.name).length > 0;
    const label = roleLabel(v, d.name, lang) + (bad ? ', ' + t(lang, 'hasProblems') : '');
    const coordinator = team.coordinator === d.name;

    const b = labels.get(d.name);
    if (b) {
      b.replaceChildren(markerIcon(state));
      b.append(el('span', 'name', d.name));
      if (cost !== '') {
        b.append(el('span', 'cost', cost));
      }
      b.setAttribute('aria-label', label);
      b.style.setProperty('--role', d.color);
      b.classList.toggle('head', coordinator);
      b.classList.toggle('room', d.room);
      b.classList.toggle('problem', bad);
      b.draggable = draft !== null && !d.room;
      b.tabIndex = d.name === target ? 0 : -1;
      b.setAttribute('aria-current', d.name === selected ? 'true' : 'false');
    }

    const r = listButtons.get(d.name);
    if (r) {
      const sw = el('span', 'swatch');
      sw.style.setProperty('--role', d.color);
      sw.setAttribute('aria-hidden', 'true');
      const nameBox = el('span', 'row-name', d.name);
      if (coordinator) {
        nameBox.append(' ', el('span', 'tag', t(lang, 'coordinates')));
      } else if (d.room) {
        nameBox.append(' ', el('span', 'tag', t(lang, 'room')));
      }
      r.replaceChildren(sw, markerIcon(state), nameBox, el('span', 'row-state', stateLabel(lang, state)));
      if (cost !== '') {
        r.append(el('span', 'cost', cost));
      }
      if (bad) {
        r.append(el('span', 'sr-only', ', ' + t(lang, 'hasProblems')));
      }
      r.classList.toggle('problem', bad);
      r.draggable = draft !== null && !d.room;
      r.tabIndex = d.name === target ? 0 : -1;
      r.setAttribute('aria-current', d.name === selected ? 'true' : 'false');
    }
  }
  // The rooms' people, in the 3D.
  for (const o of world?.rooms ?? []) {
    const rv = roomOf(v, o.room)?.view;
    if (!rv?.team) {
      continue;
    }
    for (const d of o.layout.desks) {
      const key = roomRoleKey(o.room, d.name);
      const state = stateOf(rv, d.name);
      states.set(key, state);
      const b = roomLabels.get(key);
      if (!b) {
        continue;
      }
      const cost = roleCost(rv, d.name, lang);
      b.replaceChildren(markerIcon(state));
      b.append(el('span', 'name', d.name));
      if (cost !== '') {
        b.append(el('span', 'cost', cost));
      }
      b.setAttribute('aria-label', roleLabel(rv, d.name, lang) + ', ' + t(lang, 'ofRoom', { room: o.room }));
      b.style.setProperty('--role', d.color);
      b.classList.toggle('head', rv.team.coordinator === d.name);
      b.tabIndex = key === target ? 0 : -1;
      b.setAttribute('aria-current', key === selected ? 'true' : 'false');
    }
  }
  const counts = countStates(v);
  const parts = STATES.filter((s) => counts[s] > 0).map((s) => `${stateLabel(lang, s)}: ${counts[s]}`);
  let summary = t(lang, mode === '3d' ? 'scene3d' : 'mapSummary', { team: title(v), n: team.roles.length, counts: parts.join(', ') });
  if (mode !== '3d' && team.roles.some((r) => r.name === team.coordinator)) {
    summary += ' ' + t(lang, 'mapSummaryCoordinator', { name: team.coordinator });
  }
  canvas.setAttribute('aria-label', summary);
  if (scene && sceneReady) {
    scene.setStates(states);
    scene.requestRender();
  }
}

// place puts a label at a point of the canvas, over what is nearer when
// the 3D draws one thing before another; one behind the camera is hidden.
function place(b: HTMLElement, p: Projected | null): void {
  if (!p || !p.shown) {
    b.classList.add('behind');
    return;
  }
  b.classList.remove('unplaced', 'behind');
  b.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
  b.style.zIndex = mode === '3d' ? String(Math.round((1 - p.depth) * 5000)) : '';
}

// positionLabels puts each role's button over its character's head, and in
// the 3D the rooms' signs over their back walls; after every frame, as the
// scene draws only on demand.
function positionLabels(): void {
  if (!scene || !layout) {
    return;
  }
  for (const d of layout.desks) {
    const b = labels.get(d.name);
    if (b) {
      place(b, scene.project(d.name));
    }
  }
  if (mode !== '3d') {
    return;
  }
  for (const [key, b] of roomLabels) {
    place(b, scene.project(key));
  }
  for (const o of world?.rooms ?? []) {
    const s = signs.get(o.room);
    if (s) {
      const b = moved(o.layout.bounds, o.x, o.z);
      place(s, scene.projectPoint((b.minX + b.maxX) / 2, 2.4, b.minZ - 0.15));
    }
  }
}

// --- selection, keys and the panel ---

// buttonOf is the button of a role in the view shown.
function buttonOf(key: string): HTMLButtonElement | undefined {
  return mode === 'list' ? listButtons.get(key) : labels.get(key) ?? roomLabels.get(key);
}

function select(name: string, how: { open?: boolean; focus?: boolean } = {}): void {
  selected = name;
  scene?.setSelected(name);
  updateRoles();
  if (how.focus) {
    buttonOf(name)?.focus();
  }
  if (how.open) {
    panelOpen = true;
    renderPanel();
    // Below the map on a narrow window: brought up whole, not just its title.
    $('panel-title').focus({ preventScroll: true });
    panel.scrollIntoView({ block: 'start' });
  } else if (panelOpen) {
    renderPanel();
  }
}

function onRoleKey(e: KeyboardEvent, name: string): void {
  if (!layout) {
    return;
  }
  if (mode === '3d') {
    // In the 3D the keys go through the team's people, then the rooms'.
    const order = [...layout.order, ...(world?.rooms ?? []).flatMap((o) => o.layout.order.map((n) => roomRoleKey(o.room, n)))];
    const i = Math.max(0, order.indexOf(name));
    const steps: Record<string, number> = { ArrowLeft: i - 1, ArrowUp: i - 1, ArrowRight: i + 1, ArrowDown: i + 1, Home: 0, End: order.length - 1 };
    const to = steps[e.key];
    if (to === undefined) {
      return;
    }
    e.preventDefault();
    select(order[Math.min(order.length - 1, Math.max(0, to))], { focus: true });
    return;
  }
  const keys: Record<string, Parameters<typeof neighbor>[2]> = mode === 'map'
    ? { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'first', End: 'last' }
    : { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'left', ArrowDown: 'right', Home: 'first', End: 'last' };
  const dir = keys[e.key];
  if (!dir) {
    return;
  }
  e.preventDefault();
  select(neighbor(layout, name, dir), { focus: true });
}

function closePanel(restoreFocus: boolean): void {
  if (!panelOpen) {
    return;
  }
  panelOpen = false;
  panel.hidden = true;
  if (restoreFocus && selected) {
    buttonOf(selected)?.focus();
  }
}

// renderTeamPanel is the panel of the team's own fields, while it is
// edited.
function renderTeamPanel(): void {
  panel.hidden = false;
  $('panel-swatch').style.removeProperty('--role');
  $('panel-title').textContent = t(lang, 'teamPanel');
  $('panel-state').replaceChildren();
  $('panel-spent').hidden = true;
  for (const id of ['panel-fields-title', 'panel-fields', 'panel-tasks-title', 'panel-tasks', 'panel-agent-title', 'panel-agent', 'panel-notes-title', 'panel-notes']) {
    $(id).hidden = true;
  }
  const box = $('panel-edit');
  box.hidden = false;
  renderTeamEdit(box, host);
}

function renderPanel(): void {
  if (!panelOpen || !view || selected === null) {
    panel.hidden = true;
    return;
  }
  if (selected === TEAM) {
    if (draft) {
      renderTeamPanel();
    } else {
      closePanel(false);
    }
    return;
  }
  for (const id of ['panel-fields-title', 'panel-fields', 'panel-tasks-title', 'panel-tasks']) {
    $(id).hidden = false;
  }
  // A role of a room, in the 3D: its panel read from the room's team.
  const { room, name: roleName } = splitKey(selected);
  const pv = room === null ? view : roomOf(view, room)?.view ?? null;
  const m = pv ? panelModel(pv, roleName, lang) : null;
  if (!m) {
    closePanel(false);
    return;
  }
  panel.hidden = false;
  $('panel-swatch').style.setProperty('--role', m.color);
  $('panel-title').textContent = m.name;
  const st = $('panel-state');
  st.replaceChildren(markerIcon(m.state), el('span', undefined, m.stateLabel));
  if (m.coordinator) {
    st.append(' ', el('span', 'tag', t(lang, 'coordinates')));
  }
  if (room !== null) {
    st.append(' ', el('span', 'tag', t(lang, 'ofRoom', { room })));
  }
  const spent = $('panel-spent');
  spent.hidden = m.spent === null;
  spent.textContent = m.spent === null ? '' : t(lang, 'spentToday') + ': ' + m.spent;

  // While the team is edited, the form changes the fields it knows; the
  // others are still shown, to change in the note.
  const editBox = $('panel-edit');
  const editing = draft !== null && room === null;
  editBox.hidden = !editing;
  if (editing) {
    if (m.room) {
      renderRoomEdit(editBox, host, m.name);
    } else {
      renderRoleEdit(editBox, host, m.name);
    }
  } else {
    clearEdit(editBox);
  }
  const dl = $('panel-fields');
  dl.replaceChildren();
  const fields = editing && !m.room ? m.fields.filter((f) => !EDITED.has(f.key)) : m.fields;
  for (const f of fields) {
    const row = el('div');
    row.append(el('dt', undefined, f.label), el('dd', undefined, f.value));
    dl.appendChild(row);
  }
  dl.hidden = fields.length === 0;
  $('panel-fields-title').hidden = fields.length === 0;

  const tasks = $('panel-tasks');
  tasks.replaceChildren();
  if (m.tasks.length === 0) {
    tasks.appendChild(el('li', 'muted', t(lang, 'noTasks')));
  }
  for (const task of m.tasks) {
    const li = el('li');
    const b = el('button', 'link');
    b.type = 'button';
    b.textContent = task.title;
    b.setAttribute('aria-label', task.label);
    b.addEventListener('click', () => send(openMsg(task.path)));
    li.appendChild(b);
    const meta = el('span', 'muted', task.status);
    if (task.waits !== '') {
      meta.append(' · ' + t(lang, 'waits', { why: task.waits }));
    }
    li.append(' ', meta);
    tasks.appendChild(li);
  }

  $('panel-fields-title').textContent = t(lang, m.room ? 'roomFields' : 'roleFields');
  const agent = $('panel-agent');
  agent.replaceChildren();
  agent.hidden = m.room;
  $('panel-agent-title').hidden = m.room;
  if (m.agent) {
    const a = m.agent;
    const b = el('button', 'link');
    b.type = 'button';
    b.textContent = a.title;
    b.setAttribute('aria-label', a.label);
    b.addEventListener('click', () => send(openMsg(a.path)));
    agent.appendChild(b);
    if (a.missing) {
      agent.append(' ', el('span', 'tag warn', t(lang, 'missing')));
    }
  } else {
    agent.appendChild(el('span', 'muted', '—'));
  }

  // The guides and skills, only for a role that has some.
  const notes = $('panel-notes');
  notes.replaceChildren();
  notes.hidden = m.notes.length === 0;
  $('panel-notes-title').hidden = m.notes.length === 0;
  for (const n of m.notes) {
    const li = el('li');
    const b = el('button', 'link');
    b.type = 'button';
    b.textContent = n.title;
    b.setAttribute('aria-label', n.label);
    b.addEventListener('click', () => send(openMsg(n.path)));
    li.append(b, ' ', el('span', 'muted', n.kindLabel));
    if (n.missing) {
      li.append(' ', el('span', 'tag warn', t(lang, 'missing')));
    } else if (n.notSkill) {
      li.append(' ', el('span', 'tag warn', t(lang, 'notSkill')));
    }
    notes.appendChild(li);
  }
}

function applyKeysHint(): void {
  $('keys-hint').textContent = t(lang, mode === '3d' ? 'keysHint3d' : 'keysHint');
}

// setMode shows the map, the 3D or the list; the browser remembers the view
// the person chose, not one the page went to by itself.
function setMode(next: ViewMode, remember = true): void {
  if (next !== 'list' && !scene) {
    next = 'list';
  }
  if (next === '3d' && draft !== null) {
    next = 'map';
  }
  const left3d = mode === '3d' && next !== '3d';
  mode = next;
  if (remember) {
    rememberView(storage, mode);
  }
  for (const [id, m] of [['view-map', 'map'], ['view-3d', '3d'], ['view-list', 'list']] as const) {
    $(id).setAttribute('aria-pressed', String(mode === m));
  }
  stage.hidden = mode === 'list';
  listBox.hidden = mode !== 'list';
  stage.dataset.camera = mode === '3d' ? '3d' : 'map';
  cameraBar.hidden = mode !== '3d';
  scene?.setCamera(mode === '3d' ? '3d' : 'map');
  // The 3D's canvas takes the keys of the camera.
  canvas.setAttribute('role', mode === '3d' ? 'application' : 'img');
  if (mode === '3d') {
    canvas.tabIndex = 0;
  } else {
    canvas.removeAttribute('tabindex');
  }
  if (left3d && selected !== null && splitKey(selected).room !== null) {
    selected = null;
    scene?.setSelected(null);
    closePanel(false);
  }
  applyKeysHint();
  if (mode !== 'list' && scene) {
    resize();
  }
  updateRoles();
}

// --- messages ---

function announce(next: TeamView): void {
  const changes: string[] = [];
  for (const r of next.team?.roles ?? []) {
    const before = prevStates.get(r.name);
    const now = stateOf(next, r.name);
    if (before !== undefined && before !== now) {
      changes.push(t(lang, 'stateChanged', { name: r.name, state: stateLabel(lang, now) }));
      if (now === 'waiting') {
        scene?.gesture(r.name, 'Ask');
      } else if (before === 'working' && now === 'idle') {
        scene?.gesture(r.name, 'Yes');
      }
    }
  }
  prevStates = new Map((next.team?.roles ?? []).map((r) => [r.name, stateOf(next, r.name)] as const));
  if (changes.length > 0) {
    live.textContent = changes.join('; ');
  }
}

function handle(m: Incoming): void {
  if (m.type === 'malformed') {
    errorText = '';
    render();
    return;
  }
  if (m.type === 'error') {
    errorText = m.message;
    render();
    return;
  }
  if (m.type === 'refused') {
    setStatus(t(lang, 'refused', { message: m.message }));
    // A rename refused: the panel stays on the role's name.
    const op = m.op as { op?: unknown; role?: unknown; to?: unknown } | null;
    if (op && op.op === 'rename_role' && typeof op.role === 'string' && selected === op.to) {
      selected = op.role;
    }
    // The form is built again from the team: a name refused does not stay.
    clearEdit($('panel-edit'));
    wantSelected(null);
    render();
    return;
  }
  if (m.type === 'saved') {
    if (m.ok) {
      setStatus(t(lang, 'savedOk') + (m.creates.length > 0 ? ' ' + t(lang, 'savedCreates', { notes: m.creates.join(', ') }) : ''));
    } else {
      setStatus(m.error === 'conflict' ? t(lang, 'savedConflict') : t(lang, 'savedError', { message: m.error }));
    }
    render();
    return;
  }
  errorText = null;
  draft = m.draft;
  // The team is changed on the map: the 3D gives way to it.
  if (draft !== null && mode === '3d') {
    setMode('map', false);
  }
  if (m.lang && m.lang !== lang) {
    lang = m.lang;
    applyStaticText();
    layoutSig = '';
  }
  if (m.theme) {
    hostTheme = m.theme;
    applyTheme();
  }
  view = m.view;
  render();
  announce(m.view);
}

// --- start ---

function resize(): void {
  if (!scene || stage.hidden) {
    return;
  }
  const r = stage.getBoundingClientRect();
  scene.resize(r.width, r.height);
  arrange();
}

// arrange fits the labels to the map: it measures the widest label of the
// rows, lays the desks out again when that or the map's size asks for
// other columns, and caps each label at the room of its column, where a
// longer name ends in an ellipsis (its marker and cost stay whole; the
// button's accessible name and the panel keep the whole name).
function arrange(): void {
  if (!view?.team || !layout || stage.hidden) {
    return;
  }
  const team = view.team;
  labelsBox.style.setProperty('--label-max', 'none');
  labelsBox.style.setProperty('--head-label-max', 'none');
  let whole = 0;
  let least = 0;
  let tall = 0;
  for (const [name, b] of labels) {
    if (name === team.coordinator) {
      continue;
    }
    const nameWidth = (b.querySelector('.name') as HTMLElement | null)?.offsetWidth ?? 0;
    whole = Math.max(whole, b.offsetWidth);
    least = Math.max(least, b.offsetWidth - nameWidth + Math.min(nameWidth, NAME_LEAST));
    tall = Math.max(tall, b.offsetHeight);
  }
  if (whole > 0) {
    labelSize = { whole: Math.ceil(whole), least: Math.ceil(least), height: Math.ceil(tall) + 4 };
  }
  const before = layoutSig;
  relayout(false);
  if (layoutSig !== before) {
    updateRoles();
  }
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const room = Math.floor(labelRoom(team, layout.columns, w, h));
  labelsBox.style.setProperty('--label-max', `${Math.max(56, room)}px`);
  labelsBox.style.setProperty('--head-label-max', `${Math.max(56, Math.floor(w - 2 * LABEL_MARGIN))}px`);
  scene?.requestRender();
}

function start(): void {
  applyStaticText();
  try {
    scene = new OfficeScene(canvas, { reducedMotion: () => reduced.matches });
    scene.onRender = positionLabels;
  } catch {
    scene = null;
    $('view-map').hidden = true;
    $('view-3d').hidden = true;
    $('view-list').hidden = true;
    const note = el('p', 'notice quiet', t(lang, 'noWebGL'));
    listBox.prepend(note);
  }
  applyTheme();
  darkScheme.addEventListener('change', applyTheme);
  setMode(scene ? rememberedView(storage) : 'list', false);

  $('edit-toggle').addEventListener('click', () => {
    // «Modifica» in the 3D goes back to the map, where the team changes.
    if (mode === '3d' && draft === null) {
      setMode('map', false);
    }
    toggleEditing(host);
  });
  wireDraftBar(host);
  // A profile dropped on the map is a role added with it.
  for (const target of [stage, listBox]) {
    target.addEventListener('dragover', (e) => {
      if (draft && e.dataTransfer?.types.includes(DRAG_PROFILE)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    target.addEventListener('drop', (e) => {
      const profile = e.dataTransfer?.getData(DRAG_PROFILE) ?? '';
      if (draft && profile !== '') {
        e.preventDefault();
        addProfile(host, profile);
      }
    });
  }
  $('view-map').addEventListener('click', () => setMode('map'));
  $('view-3d').addEventListener('click', () => setMode('3d'));
  $('view-list').addEventListener('click', () => setMode('list'));
  $('cam-left').addEventListener('click', () => scene?.turn(-1));
  $('cam-right').addEventListener('click', () => scene?.turn(1));
  $('cam-in').addEventListener('click', () => scene?.zoom(1));
  $('cam-out').addEventListener('click', () => scene?.zoom(-1));
  $('cam-reset').addEventListener('click', () => scene?.resetView());
  canvas.addEventListener('keydown', (e) => {
    if (mode !== '3d' || !scene || e.altKey || e.ctrlKey || e.metaKey) {
      return;
    }
    const moves: Record<string, () => void> = {
      ArrowLeft: () => scene?.turn(-1),
      ArrowRight: () => scene?.turn(1),
      ArrowUp: () => scene?.tiltBy(1),
      ArrowDown: () => scene?.tiltBy(-1),
      '+': () => scene?.zoom(1),
      '=': () => scene?.zoom(1),
      '-': () => scene?.zoom(-1),
      '0': () => scene?.resetView(),
      Home: () => scene?.resetView(),
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      move();
    }
  });
  $('refresh').addEventListener('click', () => send(refreshMsg()));
  $('open-note').addEventListener('click', () => {
    if (view?.path) {
      send(openMsg(view.path));
    }
  });
  $('panel-close').addEventListener('click', () => closePanel(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) {
      e.preventDefault();
      closePanel(true);
    }
  });

  // In the 3D the wheel nears the camera over a label too, as over the
  // office it stands on.
  labelsBox.addEventListener('wheel', (e) => {
    if (mode !== '3d') {
      return;
    }
    e.preventDefault();
    canvas.dispatchEvent(new WheelEvent('wheel', e));
  }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => {
    pressAt = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('click', (e) => {
    const from = pressAt;
    pressAt = null;
    if (mode === '3d' && from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 5) {
      return;
    }
    const r = canvas.getBoundingClientRect();
    const name = scene?.pick(e.clientX - r.left, e.clientY - r.top) ?? null;
    if (name) {
      select(name, { open: true });
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const over = scene?.pick(e.clientX - r.left, e.clientY - r.top) ? 'pointer' : null;
    canvas.style.cursor = over ?? (mode === '3d' ? (e.buttons !== 0 ? 'grabbing' : 'grab') : 'default');
  });
  new ResizeObserver(() => resize()).observe(stage);

  if (scene) {
    scene.load().then(() => {
      sceneReady = true;
      relayout(true);
      updateRoles();
      resize();
    }).catch(() => undefined);
  }

  if (params.demo) {
    const v = normalizeView(demo);
    if (v) {
      handle({ type: 'team', view: v, theme: null, lang: null, draft: null });
    }
    return;
  }
  if (connected) {
    window.addEventListener('message', (ev: MessageEvent) => {
      const m = accept({ source: ev.source, origin: ev.origin, data: ev.data }, parentWin, params.origin);
      if (m) {
        handle(m);
      }
    });
    post(parentWin, params.origin, ready());
  }
  render();
}

start();

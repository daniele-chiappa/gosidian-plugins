// The team changed on the map: the draft's bar, the
// palette of the profiles, and the forms of the panel. Every change goes to
// gosidian's window as one op; the window keeps the draft, the server
// checks it and the window hands back the team as the draft makes it,
// which the page draws as it draws any team. Only the window saves.

import type { Outgoing } from './bridge';
import { discard as discardMsg, edit as editMsg, editing as editingMsg, undo as undoMsg } from './bridge';
import type { Draft, EditField, Op, Palette } from './draft';
import { blockLines, fromProfile, listOf, nameProblem, newName, own, problemsOf, profileOf, resetOp, setOp } from './draft';
import type { Lang } from './i18n';
import { t } from './i18n';
import type { Role, TeamView } from './model';

// TEAM is the panel of the team's own fields: no role is named so.
export const TEAM = ':team';

// The keys a drag carries: a profile onto the map, a role onto another.
export const DRAG_PROFILE = 'application/x-office-profile';
export const DRAG_ROLE = 'application/x-office-role';

export interface EditorHost {
  lang(): Lang;
  view(): TeamView | null;
  draft(): Draft | null;
  send(msg: Outgoing): void;
  // select opens the panel of a role, a room or the team.
  select(name: string): void;
  announce(text: string): void;
}

// What the page waits for: a role it added or renamed, to open once the
// team has it; and what the bar says of the last change.
let pending: string | null = null;
let status = '';
let confirmDiscard = false;
let confirmRemove: string | null = null;
let addError = '';

function $(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) {
    throw new Error('missing #' + id);
  }
  return e;
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

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

// change sends op to the window, when there is one.
function change(host: EditorHost, op: Op | null): void {
  if (op === null) {
    return;
  }
  status = '';
  host.send(editMsg(op));
}

export function setStatus(text: string): void {
  status = text;
}

export function wantSelected(name: string | null): void {
  pending = name;
}

// takePending is the role the page waits for, once the team has it.
export function takePending(view: TeamView): string | null {
  if (pending === null) {
    return null;
  }
  const has = view.team?.roles.some((r) => r.name === pending) || view.team?.rooms.some((r) => r.name === pending);
  if (!has) {
    return null;
  }
  const p = pending;
  pending = null;
  return p;
}

// sigs are what each box was last built from: a box built again only when
// that changed, so a team handed again as it was leaves the forms as they
// are, a press and what is being typed among them.
const sigs = new WeakMap<HTMLElement, string>();

function unchanged(box: HTMLElement, sig: string): boolean {
  if (sigs.get(box) === sig) {
    return true;
  }
  sigs.set(box, sig);
  return false;
}

// clearEdit empties box, so that it is built whole the next time.
export function clearEdit(box: HTMLElement): void {
  sigs.delete(box);
  box.replaceChildren();
}

// keep builds box again with what the person typed and did not send yet,
// in every field whose value is still the one it was built with, and the
// focus where it was.
function keep(box: HTMLElement, build: () => void): void {
  const a = document.activeElement;
  const key = a instanceof HTMLElement && box.contains(a) ? a.dataset.edit ?? null : null;
  const sel = a instanceof HTMLInputElement && key !== null && (a.type === 'text' || a.type === 'search') ? [a.selectionStart, a.selectionEnd] : null;
  const typed = new Map<string, { value: string; was: string }>();
  for (const i of box.querySelectorAll<HTMLInputElement>('input[data-edit]')) {
    if ((i.type === 'text' || i.type === 'number') && i.value !== i.defaultValue && i.dataset.edit) {
      typed.set(i.dataset.edit, { value: i.value, was: i.defaultValue });
    }
  }
  build();
  for (const i of box.querySelectorAll<HTMLInputElement>('input[data-edit]')) {
    const t = i.dataset.edit ? typed.get(i.dataset.edit) : undefined;
    if (t && i.defaultValue === t.was) {
      i.value = t.value;
      if (i.disabled && i.dataset.edit === 'role-tools') {
        i.disabled = false;
      }
    }
  }
  if (key === null) {
    return;
  }
  const next = box.querySelector<HTMLElement>(`[data-edit="${CSS.escape(key)}"]`);
  if (!next) {
    return;
  }
  next.focus({ preventScroll: true });
  if (sel && next instanceof HTMLInputElement && sel[0] !== null) {
    next.setSelectionRange(sel[0], sel[1]);
  }
}

// --- the draft's bar and the palette ---

export function startEditing(host: EditorHost): void {
  status = '';
  host.send(editingMsg(true));
}

// toggle starts the draft, or ends one without changes.
export function toggleEditing(host: EditorHost): void {
  const d = host.draft();
  if (d === null) {
    startEditing(host);
    return;
  }
  if (d.ops > 0) {
    status = t(host.lang(), 'editEndBlocked');
    renderDraftBar(host);
    return;
  }
  status = '';
  confirmDiscard = false;
  host.send(editingMsg(false));
}

function opsText(lang: Lang, n: number): string {
  if (n === 0) {
    return t(lang, 'draftNone');
  }
  return n === 1 ? t(lang, 'draftOne') : t(lang, 'draftMany', { n });
}

function datalist(id: string, values: string[]): HTMLDataListElement {
  const dl = el('datalist');
  dl.id = id;
  for (const v of values) {
    const o = el('option');
    o.value = v;
    dl.appendChild(o);
  }
  return dl;
}

// addProfile adds a role taking the profile, with a free name of its own,
// and opens it: a drop on the map, a press on the profile's card.
export function addProfile(host: EditorHost, profileName: string): void {
  const view = host.view();
  if (!view?.team) {
    return;
  }
  const base = profileName.startsWith('[[') ? profileName.replace(/^.*\//, '').replace(/[\]|#].*$/, '') : profileName;
  const name = newName(view, base);
  pending = name;
  change(host, { op: 'add_role', role: name, profile: profileName });
  host.announce(t(host.lang(), 'added', { name }));
}

export function renderDraftBar(host: EditorHost): void {
  const lang = host.lang();
  const d = host.draft();
  const bar = $('draft');
  bar.hidden = d === null;
  if (d === null) {
    confirmDiscard = false;
    return;
  }
  $('draft-title').textContent = t(lang, 'draftTitle');
  $('draft-count').textContent = opsText(lang, d.ops);
  $('draft-hint').textContent = t(lang, 'draftSaveHint');
  $('draft-hint').hidden = d.ops === 0;
  const st = $('draft-status');
  st.textContent = status;
  st.hidden = status === '';
  const rebased = $('draft-rebased');
  rebased.textContent = t(lang, 'rebased');
  rebased.hidden = !d.rebased;
  const creates = $('draft-creates');
  creates.hidden = d.creates.length === 0;
  creates.textContent = d.creates.length > 0 ? t(lang, 'creates', { notes: d.creates.join(', ') }) : '';

  const undo = $('draft-undo') as HTMLButtonElement;
  undo.textContent = t(lang, 'undo');
  undo.disabled = d.ops === 0;
  const dis = $('draft-discard') as HTMLButtonElement;
  dis.disabled = d.ops === 0;
  if (d.ops === 0) {
    confirmDiscard = false;
  }
  dis.textContent = t(lang, confirmDiscard ? 'discardConfirm' : 'discard');
  dis.classList.toggle('danger', confirmDiscard);
  $('team-fields').textContent = t(lang, 'teamButton');

  renderPalette(host, d.palette);

  const pre = $('block-pre');
  $('block-title').textContent = t(lang, 'blockTitle');
  pre.replaceChildren();
  for (const line of blockLines(d)) {
    const row = el('span', 'bline' + (line.problems.length > 0 ? ' bad' : ''));
    row.append(el('span', 'bnum', String(line.n)), el('span', 'btext', line.text === '' ? ' ' : line.text));
    if (line.problems.length > 0) {
      row.title = line.problems.map((p) => p.message).join('\n');
    }
    pre.append(row, '\n');
  }
}

function renderPalette(host: EditorHost, p: Palette): void {
  const lang = host.lang();
  $('palette-title').textContent = t(lang, 'addRole');
  $('palette-hint').textContent = t(lang, 'addRoleHint');
  const cards = $('palette-cards');
  if (unchanged(cards, JSON.stringify([lang, p.profiles]))) {
    renderAddRole(host, p);
    return;
  }
  cards.replaceChildren();
  for (const prof of p.profiles) {
    const li = el('li');
    const b = el('button', 'card');
    b.type = 'button';
    b.draggable = true;
    b.dataset.profile = prof.name;
    b.setAttribute('aria-label', t(lang, 'profileCard', { name: prof.title || prof.name }));
    b.append(el('strong', undefined, prof.title || prof.name));
    const facts = ['run', 'model', 'access'].map((k) => prof.fields[k]).filter((v) => typeof v === 'string' && v !== '');
    if (prof.fields.review === true) {
      facts.push(t(lang, 'field.review').toLowerCase());
    }
    if (prof.description !== '' || facts.length > 0) {
      b.append(el('span', 'muted', [prof.description, facts.join(' · ')].filter((x) => x !== '').join(' — ')));
    }
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(DRAG_PROFILE, prof.name);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copy';
      }
    });
    b.addEventListener('click', () => addProfile(host, prof.name));
    li.appendChild(b);
    cards.appendChild(li);
  }
  cards.hidden = p.profiles.length === 0;
  renderAddRole(host, p);
}

function renderAddRole(host: EditorHost, p: Palette): void {
  const lang = host.lang();
  const form = $('add-role');
  if (unchanged(form, JSON.stringify([lang, p.profiles.map((x) => [x.name, x.title]), addError]))) {
    return;
  }
  keep(form, () => {
    const name = el('input');
    name.type = 'text';
    name.id = 'add-role-name';
    name.dataset.edit = 'add-name';
    name.autocomplete = 'off';
    name.spellcheck = false;
    const nameLabel = el('label', undefined, t(lang, 'nameLabel'));
    nameLabel.htmlFor = name.id;
    const prof = el('select');
    prof.id = 'add-role-profile';
    prof.dataset.edit = 'add-profile';
    prof.append(new Option(t(lang, 'noProfile'), ''));
    for (const x of p.profiles) {
      prof.append(new Option(x.title || x.name, x.name));
    }
    const profLabel = el('label', undefined, t(lang, 'field.profile'));
    profLabel.htmlFor = prof.id;
    const submit = el('button', undefined, t(lang, 'addRoleSubmit'));
    const err = el('p', 'error', addError);
    err.id = 'add-role-error';
    err.hidden = addError === '';
    err.setAttribute('role', 'alert');
    name.setAttribute('aria-describedby', err.id);
    action(submit, [name], () => addNamed(host));
    form.replaceChildren(nameLabel, name, profLabel, prof, submit, err);
  });
}

// addNamed adds the role the palette's fields name.
function addNamed(host: EditorHost): void {
  const lang = host.lang();
  const view = host.view();
  const name = ($('add-role-name') as HTMLInputElement).value.trim();
  const profile = ($('add-role-profile') as HTMLSelectElement).value;
  const why = view ? nameProblem(view, name) : 'nameInvalid';
  if (why) {
    addError = t(lang, why);
    renderDraftBar(host);
    ($('add-role-name') as HTMLInputElement).focus();
    return;
  }
  addError = '';
  pending = name;
  change(host, profile ? { op: 'add_role', role: name, profile } : { op: 'add_role', role: name });
  host.announce(t(lang, 'added', { name }));
  ($('add-role-name') as HTMLInputElement).value = '';
}

export function wireDraftBar(host: EditorHost): void {
  $('draft-undo').addEventListener('click', () => {
    status = '';
    host.send(undoMsg());
  });
  $('draft-discard').addEventListener('click', () => {
    if (!confirmDiscard) {
      confirmDiscard = true;
      renderDraftBar(host);
      return;
    }
    confirmDiscard = false;
    status = '';
    host.send(discardMsg());
  });
  $('team-fields').addEventListener('click', () => host.select(TEAM));
}

// --- the forms of the panel ---

interface Row {
  box: HTMLElement;
  control: HTMLElement;
}

// action makes button do run, and Enter in each of fields too: the app's
// frame takes no form submission (its sandbox has no allow-forms).
function action(button: HTMLButtonElement, fields: HTMLElement[], run: () => void): void {
  button.type = 'button';
  button.addEventListener('click', run);
  for (const f of fields) {
    f.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
  }
}

function row(label: string, control: HTMLElement, extra: (HTMLElement | string)[] = []): Row {
  const box = el('div', 'erow');
  const l = el('label', undefined, label);
  if (!control.id) {
    control.id = uid('f');
  }
  l.htmlFor = control.id;
  box.append(l, control, ...extra);
  return { box, control };
}

function group(label: string, children: HTMLElement[], cls = 'egroup'): HTMLFieldSetElement {
  const fs = el('fieldset', cls);
  fs.append(el('legend', undefined, label), ...children);
  return fs;
}

function check(label: string, checked: boolean, key: string, onChange: (on: boolean) => void): HTMLLabelElement {
  const l = el('label', 'check');
  const c = el('input');
  c.type = 'checkbox';
  c.checked = checked;
  c.dataset.edit = key;
  c.addEventListener('change', () => onChange(c.checked));
  l.append(c, ' ', label);
  return l;
}

// profileBits are the hint that a value is the profile's, and the button
// that gives the role its profile's again.
function profileBits(host: EditorHost, role: Role, f: EditField): HTMLElement[] {
  const lang = host.lang();
  const view = host.view();
  const d = host.draft();
  if (!view || !d) {
    return [];
  }
  const live = view.roles.get(role.name);
  const prof = profileOf(d.palette, role);
  const has = prof !== null && Object.prototype.hasOwnProperty.call(prof.fields, f);
  if (fromProfile(d.palette, role, live, f)) {
    return [el('span', 'muted from', t(lang, 'fromProfile'))];
  }
  if (has && own(live, f)) {
    const b = el('button', 'small', t(lang, 'useProfile'));
    b.type = 'button';
    b.addEventListener('click', () => change(host, resetOp(role, f)));
    return [b];
  }
  return [];
}

function textField(host: EditorHost, role: Role, f: 'run' | 'model' | 'effort' | 'guide', value: string, list?: string): Row {
  const lang = host.lang();
  const input = el('input');
  input.type = 'text';
  input.defaultValue = value;
  input.dataset.edit = 'role-' + f;
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (list) {
    input.setAttribute('list', list);
  }
  input.addEventListener('change', () => {
    const live = host.view()?.roles.get(role.name);
    change(host, setOp(role, live, f, input.value));
  });
  return row(t(lang, `field.${f}`), input, profileBits(host, role, f));
}

function listField(host: EditorHost, role: Role, f: 'writes', value: string[]): Row {
  const lang = host.lang();
  const input = el('input');
  input.type = 'text';
  input.defaultValue = value.join(', ');
  input.dataset.edit = 'role-' + f;
  input.placeholder = t(lang, 'listHint');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.addEventListener('change', () => {
    const live = host.view()?.roles.get(role.name);
    change(host, setOp(role, live, f, listOf(input.value)));
  });
  return row(t(lang, `field.${f}`), input, profileBits(host, role, f));
}

// renderRoleEdit fills box with the form of the role name.
export function renderRoleEdit(box: HTMLElement, host: EditorHost, name: string): void {
  const view = host.view();
  const d = host.draft();
  const role = view?.team?.roles.find((r) => r.name === name);
  if (!view?.team || !d || !role) {
    clearEdit(box);
    return;
  }
  const team = view.team;
  const lang = host.lang();
  const live = view.roles.get(name);
  const sig = JSON.stringify(['role', lang, name, role, live?.fields ?? null, team.roles.map((r) => r.name), team.rooms.map((r) => r.name),
    d.palette, problemsOf(d, name), confirmRemove === name]);
  if (unchanged(box, sig)) {
    return;
  }
  keep(box, () => {
    const parts: HTMLElement[] = [];
    const listId = uid('runs');
    parts.push(datalist(listId, d.palette.runs));

    // Its name.
    const nameInput = el('input');
    nameInput.type = 'text';
    nameInput.defaultValue = name;
    nameInput.dataset.edit = 'role-name';
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    const renameBtn = el('button', 'small', t(lang, 'rename'));
    renameBtn.type = 'button';
    const nameErr = el('p', 'error');
    nameErr.id = uid('err');
    nameErr.hidden = true;
    nameErr.setAttribute('role', 'alert');
    nameInput.setAttribute('aria-describedby', nameErr.id);
    const rename = () => {
      const to = nameInput.value.trim();
      if (to === name) {
        return;
      }
      const why = nameProblem(view, to);
      if (why) {
        nameErr.textContent = t(lang, why);
        nameErr.hidden = false;
        return;
      }
      pending = to;
      change(host, { op: 'rename_role', role: name, to });
    };
    renameBtn.addEventListener('click', rename);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        rename();
      }
    });
    parts.push(row(t(lang, 'nameLabel'), nameInput, [renameBtn]).box, nameErr);

    // Its profile.
    const prof = el('select');
    prof.dataset.edit = 'role-profile';
    prof.append(new Option(t(lang, 'noProfile'), ''));
    let found = role.profile === '';
    for (const x of d.palette.profiles) {
      const o = new Option(x.title || x.name, x.name);
      if (x.path === role.profile) {
        o.selected = true;
        found = true;
      }
      prof.append(o);
    }
    if (!found) {
      const o = new Option(role.profile, role.profile);
      o.selected = true;
      prof.append(o);
    }
    prof.addEventListener('change', () => {
      const chosen = d.palette.profiles.find((x) => x.name === prof.value);
      if ((chosen?.path ?? (prof.value === '' ? '' : prof.value)) === role.profile) {
        return;
      }
      change(host, { op: 'set', role: name, field: 'profile', value: prof.value === '' ? null : prof.value });
    });
    parts.push(row(t(lang, 'field.profile'), prof).box);

    parts.push(textField(host, role, 'run', role.run, listId).box);
    parts.push(textField(host, role, 'model', role.model).box);
    parts.push(textField(host, role, 'effort', role.effort).box);

    // Its access and whether it reviews.
    const access = el('select');
    access.dataset.edit = 'role-access';
    for (const [v, label] of [['', t(lang, 'accessDefault')], ['read', 'read'], ['edit', 'edit'], ['exec', 'exec']] as const) {
      const o = new Option(label, v);
      o.selected = role.access === v;
      access.append(o);
    }
    access.addEventListener('change', () => change(host, setOp(role, live, 'access', access.value)));
    parts.push(row(t(lang, 'field.access'), access, profileBits(host, role, 'access')).box);
    const reviewBox = el('div', 'erow');
    const prv = profileOf(d.palette, role);
    reviewBox.append(check(t(lang, 'field.review'), role.review, 'role-review', (on) =>
      change(host, setOp(role, live, 'review', on, prv !== null && Object.prototype.hasOwnProperty.call(prv.fields, 'review')))),
    ...profileBits(host, role, 'review'));
    parts.push(reviewBox);

    // Whom it delegates to: the other roles and the rooms.
    const others = [...team.roles.map((r) => r.name).filter((n) => n !== name), ...team.rooms.map((r) => r.name)];
    const delegates = others.length === 0
      ? [el('p', 'muted', t(lang, 'noOthers'))]
      : others.map((o) => check(team.rooms.some((r) => r.name === o) ? `${o} (${t(lang, 'room')})` : o, role.delegates_to.includes(o), 'role-delegate-' + o, (on) => {
          const next = on ? [...role.delegates_to, o] : role.delegates_to.filter((x) => x !== o);
          change(host, setOp(role, live, 'delegates_to', next));
        }));
    parts.push(group(t(lang, 'field.delegates_to'), delegates));

    parts.push(listField(host, role, 'writes', role.writes).box);

    // Its plugins' tools: every one of the project, none, or these.
    const mode = role.tools === null ? 'all' : role.tools.length === 0 ? 'none' : 'some';
    const toolsName = uid('tools');
    const toolsInput = el('input');
    toolsInput.type = 'text';
    toolsInput.defaultValue = (role.tools ?? []).join(', ');
    toolsInput.dataset.edit = 'role-tools';
    toolsInput.placeholder = t(lang, 'listHint');
    toolsInput.disabled = mode !== 'some';
    toolsInput.setAttribute('aria-label', t(lang, 'toolsSome'));
    const radio = (value: 'all' | 'none' | 'some', label: string) => {
      const l = el('label', 'check');
      const r = el('input');
      r.type = 'radio';
      r.name = toolsName;
      r.value = value;
      r.checked = mode === value;
      r.dataset.edit = 'role-tools-' + value;
      r.addEventListener('change', () => {
        if (value === 'all') {
          change(host, setOp(role, live, 'tools', null));
        } else if (value === 'none') {
          change(host, setOp(role, live, 'tools', []));
        } else {
          toolsInput.disabled = false;
          toolsInput.focus();
        }
      });
      l.append(r, ' ', label);
      return l;
    };
    toolsInput.addEventListener('change', () => {
      const list = listOf(toolsInput.value);
      if (list.length > 0) {
        change(host, setOp(role, live, 'tools', list));
      }
    });
    parts.push(group(t(lang, 'field.tools'), [radio('all', t(lang, 'toolsAll')), radio('none', t(lang, 'noTools')),
      radio('some', t(lang, 'toolsSome')), toolsInput, ...profileBits(host, role, 'tools')]));

    // Its skills: those of the project, and those it names.
    const skills = [...d.palette.skills];
    for (const s of role.skills) {
      if (!skills.some((x) => x.path === s)) {
        skills.push({ path: s, title: s.replace(/^.*\//, '').replace(/\.md$/, '') });
      }
    }
    if (skills.length > 0) {
      const items: HTMLElement[] = skills.map((s) => check(s.title || s.path, role.skills.includes(s.path), 'role-skill-' + s.path, (on) => {
        const next = on ? [...role.skills, s.path] : role.skills.filter((x) => x !== s.path);
        change(host, setOp(role, live, 'skills', next));
      }));
      items.push(...profileBits(host, role, 'skills'));
      parts.push(group(t(lang, 'field.skills'), items));
    }

    parts.push(textField(host, role, 'guide', role.guide).box);

    // Taken away, after a second press.
    const remove = el('button', 'danger', confirmRemove === name ? t(lang, 'removeConfirm', { name }) : t(lang, 'removeRole'));
    remove.type = 'button';
    remove.dataset.edit = 'role-remove';
    remove.addEventListener('click', () => {
      if (confirmRemove !== name) {
        confirmRemove = name;
        renderRoleEdit(box, host, name);
        return;
      }
      confirmRemove = null;
      change(host, { op: 'remove_role', role: name });
    });
    parts.push(el('div', 'erow end'));
    parts[parts.length - 1].append(remove);

    const probs = problemsOf(d, name);
    if (probs.length > 0) {
      const ul = el('ul', 'eproblems');
      for (const p of probs) {
        ul.appendChild(el('li', undefined, (p.line > 0 ? t(lang, 'problemLine', { line: p.line }) + ' ' : '') + p.message));
      }
      parts.unshift(ul);
    }
    box.replaceChildren(...parts);
  });
}

// renderRoomEdit fills box with what the panel of a room changes: it
// unlinks it.
export function renderRoomEdit(box: HTMLElement, host: EditorHost, name: string): void {
  const lang = host.lang();
  const d = host.draft();
  if (unchanged(box, JSON.stringify(['room', lang, name, problemsOf(d, name)]))) {
    return;
  }
  keep(box, () => {
    const parts: HTMLElement[] = [];
    for (const p of problemsOf(d, name)) {
      parts.push(el('p', 'error', p.message));
    }
    const b = el('button', 'danger', t(lang, 'unlinkRoom', { name }));
    b.type = 'button';
    b.dataset.edit = 'room-unlink';
    b.addEventListener('click', () => {
      change(host, { op: 'remove_room', room: name });
      host.announce(t(lang, 'roomUnlinked', { name }));
    });
    const r = el('div', 'erow end');
    r.append(b);
    parts.push(r);
    box.replaceChildren(...parts);
  });
}

function teamNumber(host: EditorHost, label: string, key: string, value: number, step: string): Row {
  const input = el('input');
  input.type = 'number';
  input.min = '0';
  input.step = step;
  input.defaultValue = value > 0 ? String(value) : '';
  input.dataset.edit = 'team-' + key;
  input.addEventListener('change', () => {
    const v = input.value.trim() === '' ? null : Number(input.value);
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      return;
    }
    if ((v ?? 0) === value) {
      return;
    }
    change(host, { op: 'set', field: key, value: v === 0 ? null : v });
  });
  return row(label, input);
}

// renderTeamEdit fills box with the team's own fields and its rooms.
export function renderTeamEdit(box: HTMLElement, host: EditorHost): void {
  const view = host.view();
  const d = host.draft();
  if (!view?.team || !d) {
    clearEdit(box);
    return;
  }
  const team = view.team;
  const lang = host.lang();
  const sig = JSON.stringify(['team', lang, { ...team, roles: team.roles.map((r) => [r.name, r.run]) }, d.palette.teams, d.palette.runs,
    d.problems.filter((x) => x.role === '' && x.room === '')]);
  if (unchanged(box, sig)) {
    return;
  }
  keep(box, () => {
    const parts: HTMLElement[] = [];
    for (const p of d.problems.filter((x) => x.role === '' && x.room === '')) {
      parts.push(el('p', 'error', (p.line > 0 ? t(lang, 'problemLine', { line: p.line }) + ' ' : '') + p.message));
    }
    const coord = el('select');
    coord.dataset.edit = 'team-coordinator';
    coord.append(new Option(t(lang, 'noneOption'), ''));
    for (const r of team.roles) {
      const o = new Option(r.name, r.name);
      o.selected = team.coordinator === r.name;
      coord.append(o);
    }
    coord.addEventListener('change', () => {
      if (coord.value !== team.coordinator) {
        change(host, { op: 'set', field: 'coordinator', value: coord.value === '' ? null : coord.value });
      }
    });
    parts.push(row(t(lang, 'field.coordinator'), coord).box);
    parts.push(teamNumber(host, t(lang, 'budgetDayField'), 'budget.day_usd', team.budget.day_usd, '0.5').box);
    parts.push(teamNumber(host, t(lang, 'budgetTaskField'), 'budget.task_usd', team.budget.task_usd, '0.5').box);
    parts.push(teamNumber(host, t(lang, 'field.max_agents'), 'max_agents', team.max_agents, '1').box);
    const guide = el('input');
    guide.type = 'text';
    guide.defaultValue = team.guide;
    guide.dataset.edit = 'team-guide';
    guide.autocomplete = 'off';
    guide.addEventListener('change', () => {
      if (guide.value.trim() !== team.guide) {
        change(host, { op: 'set', field: 'guide', value: guide.value.trim() === '' ? null : guide.value.trim() });
      }
    });
    parts.push(row(t(lang, 'field.guide'), guide).box);

    // The rooms: unlinked, linked, created.
    const rooms: HTMLElement[] = [];
    if (team.rooms.length === 0) {
      rooms.push(el('p', 'muted', t(lang, 'noRooms')));
    }
    for (const r of team.rooms) {
      const line = el('div', 'erow');
      const b = el('button', 'small danger', t(lang, 'unlinkRoom', { name: r.name }));
      b.type = 'button';
      b.dataset.edit = 'team-unlink-' + r.name;
      b.addEventListener('click', () => {
        change(host, { op: 'remove_room', room: r.name });
        host.announce(t(lang, 'roomUnlinked', { name: r.name }));
      });
      line.append(el('span', undefined, `${r.name} · ${r.path}`), b);
      rooms.push(line);
    }
    // A team of the project, as a room.
    const linkErr = el('p', 'error');
    linkErr.hidden = true;
    linkErr.setAttribute('role', 'alert');
    if (d.palette.teams.length === 0) {
      rooms.push(el('p', 'muted', t(lang, 'noTeams')));
    } else {
      const form = el('div', 'row-form');
      const pick = el('select');
      pick.dataset.edit = 'link-team';
      for (const x of d.palette.teams) {
        pick.append(new Option(x.title || x.path, x.path));
      }
      const name = el('input');
      name.type = 'text';
      name.dataset.edit = 'link-name';
      name.autocomplete = 'off';
      name.spellcheck = false;
      const submit = el('button', undefined, t(lang, 'linkRoomSubmit'));
      const pr = row(t(lang, 'teamLabel'), pick);
      const nr = row(t(lang, 'nameLabel'), name);
      form.append(pr.box, nr.box, submit);
      action(submit, [name], () => {
        const n = name.value.trim() || pick.value.replace(/^.*\//, '').replace(/\.md$/, '');
        const why = nameProblem(view, n);
        if (why) {
          linkErr.textContent = t(lang, why);
          linkErr.hidden = false;
          return;
        }
        change(host, { op: 'add_room', room: n, path: pick.value });
      });
      rooms.push(group(t(lang, 'linkRoom'), [form]));
    }
    // A new team, as a room.
    const nf = el('div', 'row-form');
    const rn = el('input');
    rn.type = 'text';
    rn.dataset.edit = 'new-room-name';
    rn.autocomplete = 'off';
    rn.spellcheck = false;
    const rc = el('input');
    rc.type = 'text';
    rc.defaultValue = 'lead';
    rc.dataset.edit = 'new-room-coordinator';
    rc.autocomplete = 'off';
    const rr = el('input');
    rr.type = 'text';
    rr.defaultValue = 'lead, dev';
    rr.dataset.edit = 'new-room-roles';
    rr.placeholder = t(lang, 'listHint');
    rr.autocomplete = 'off';
    const listId = uid('runs');
    const run = el('input');
    run.type = 'text';
    run.dataset.edit = 'new-room-run';
    run.setAttribute('list', listId);
    run.placeholder = team.roles[0]?.run ?? '';
    run.autocomplete = 'off';
    const create = el('button', undefined, t(lang, 'newRoomSubmit'));
    nf.append(datalist(listId, d.palette.runs), row(t(lang, 'nameLabel'), rn).box, row(t(lang, 'newRoomCoordinator'), rc).box,
      row(t(lang, 'newRoomRoles'), rr).box, row(t(lang, 'field.run'), run).box, create);
    action(create, [rn, rc, rr, run], () => {
      const n = rn.value.trim();
      const why = nameProblem(view, n);
      if (why) {
        linkErr.textContent = t(lang, why);
        linkErr.hidden = false;
        return;
      }
      const op: Op = { op: 'create_room', room: n, coordinator: rc.value.trim() || 'lead', roles: listOf(rr.value) };
      if (run.value.trim() !== '') {
        op.run = run.value.trim();
      }
      change(host, op);
    });
    rooms.push(group(t(lang, 'newRoom'), [nf]), linkErr);
    parts.push(group(t(lang, 'rooms'), rooms, 'egroup rooms'));
    box.replaceChildren(...parts);
  });
}

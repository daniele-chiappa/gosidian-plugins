import { describe, expect, it } from 'vitest';
import { accept, discard, edit, editing, undo } from '../src/bridge';
import { blockLines, delegateOp, listOf, nameProblem, newName, problemsOf, readDraft, setOp } from '../src/draft';
import type { RoleLive } from '../src/model';
import { normalizeView } from '../src/model';

// The draft of the map: what the window says of it,
// and the changes the page sends.

const team = normalizeView({
  path: 'esempio/squadra.md',
  title: 'squadra',
  line: 6,
  team: {
    coordinator: 'capo',
    rooms: [{ name: 'front', path: 'esempio/front.md' }],
    roles: [
      { name: 'capo', run: 'pi.run', delegates_to: ['dev'] },
      { name: 'dev', run: 'pi.run', model: 'qwen3', writes: ['esempio/app/'], tools: null },
      { name: 'rev', run: 'claude.run', review: true, access: 'read', profile: 'esempio/profiles/reviewer.md', tools: [] },
    ],
  },
  roles: {
    capo: { state: 'idle', fields: ['run', 'delegates_to'] },
    dev: { state: 'idle', fields: ['run', 'model', 'writes'] },
    rev: { state: 'idle', fields: ['profile', 'tools'] },
  },
  editable: true,
})!;

const live = (name: string): RoleLive => team.roles.get(name)!;
const role = (name: string) => team.team!.roles.find((r) => r.name === name)!;

describe('readDraft', () => {
  it('reads what the window keeps, and nothing without editing', () => {
    expect(readDraft(undefined)).toBeNull();
    expect(readDraft({ editing: false })).toBeNull();
    const d = readDraft({
      editing: true, ops: 2, rebased: true, block: 'roles:\n  a: {run: pi.run}\n', line: 6, creates: ['esempio/agents/a.md', 3],
      problems: [{ line: 8, message: 'role a: x', role: 'a' }, { message: '' }],
      palette: { profiles: [{ path: 'esempio/profiles/reviewer.md', name: 'reviewer', title: 'Chi rivede', fields: { access: 'read' } }, { path: 'x' }],
        teams: [{ path: 'esempio/front.md', title: 'Il front' }], runs: ['pi.run', 1], skills: 'no' },
    })!;
    expect(d).toMatchObject({ ops: 2, rebased: true, line: 6, creates: ['esempio/agents/a.md'] });
    expect(d.problems).toEqual([{ line: 8, message: 'role a: x', role: 'a', room: '' }]);
    expect(d.palette.profiles).toEqual([{ path: 'esempio/profiles/reviewer.md', name: 'reviewer', title: 'Chi rivede', description: '', fields: { access: 'read' } }]);
    expect(d.palette.runs).toEqual(['pi.run']);
    expect(d.palette.skills).toEqual([]);
    expect(readDraft({ editing: true, ops: -1, line: 'x' })).toMatchObject({ ops: 0, line: 0, palette: { profiles: [] } });
  });

  it('gives each line of the block its line in the note and its problems', () => {
    const d = readDraft({ editing: true, block: 'roles:\n  a: {run: x}\n', line: 6, problems: [{ line: 8, message: 'run' }] })!;
    expect(blockLines(d)).toEqual([
      { n: 7, text: 'roles:', problems: [] },
      { n: 8, text: '  a: {run: x}', problems: [{ line: 8, message: 'run', role: '', room: '' }] },
    ]);
    expect(problemsOf(readDraft({ editing: true, problems: [{ message: 'm', role: 'a' }, { message: 'n', room: 'front' }] }), 'front')).toEqual([
      { line: 0, message: 'n', role: '', room: 'front' },
    ]);
    expect(problemsOf(null, 'a')).toEqual([]);
  });
});

describe('the changes of a role', () => {
  it('sets what changes, and nothing else', () => {
    expect(setOp(role('dev'), live('dev'), 'model', ' sonnet ')).toEqual({ op: 'set', role: 'dev', field: 'model', value: 'sonnet' });
    expect(setOp(role('dev'), live('dev'), 'model', 'qwen3')).toBeNull();
    expect(setOp(role('dev'), live('dev'), 'writes', listOf('esempio/app/, esempio/doc/'))).toEqual({
      op: 'set', role: 'dev', field: 'writes', value: ['esempio/app/', 'esempio/doc/'] });
    expect(setOp(role('dev'), live('dev'), 'writes', listOf('esempio/app/'))).toBeNull();
  });

  it('takes away from the block only what it writes: the profile gives the rest', () => {
    expect(setOp(role('dev'), live('dev'), 'model', '')).toEqual({ op: 'set', role: 'dev', field: 'model', value: null });
    expect(setOp(role('dev'), live('dev'), 'writes', [])).toEqual({ op: 'set', role: 'dev', field: 'writes', value: null });
    // rev's access is its profile's: nothing to take away.
    expect(setOp(role('rev'), live('rev'), 'access', '')).toBeNull();
    // Its review is its profile's too: unticked, the block says false.
    expect(setOp(role('rev'), live('rev'), 'review', false, true)).toEqual({ op: 'set', role: 'rev', field: 'review', value: false });
    expect(setOp(role('dev'), live('dev'), 'review', false)).toBeNull();
  });

  it('says every plugin of the project, none, or these', () => {
    expect(setOp(role('rev'), live('rev'), 'tools', null)).toEqual({ op: 'set', role: 'rev', field: 'tools', value: null });
    expect(setOp(role('rev'), live('rev'), 'tools', [])).toBeNull();
    expect(setOp(role('dev'), live('dev'), 'tools', [])).toEqual({ op: 'set', role: 'dev', field: 'tools', value: [] });
    expect(setOp(role('dev'), live('dev'), 'tools', null)).toBeNull();
  });

  it('delegates once, never to itself', () => {
    expect(delegateOp(team, 'capo', 'rev')).toEqual({ op: 'set', role: 'capo', field: 'delegates_to', value: ['dev', 'rev'] });
    expect(delegateOp(team, 'capo', 'dev')).toBeNull();
    expect(delegateOp(team, 'capo', 'capo')).toBeNull();
    expect(delegateOp(team, 'nessuno', 'dev')).toBeNull();
  });

  it('finds a free name, and says why one is not', () => {
    expect(newName(team, 'reviewer')).toBe('reviewer');
    expect(newName(team, 'dev')).toBe('dev-2');
    expect(newName(team, 'front')).toBe('front-2');
    expect(newName(team, 'Data Analyst!')).toBe('data-analyst');
    expect(newName(team, '42')).toBe('ruolo');
    expect(nameProblem(team, 'dev')).toBe('nameTaken');
    expect(nameProblem(team, 'front')).toBe('nameTaken');
    expect(nameProblem(team, 'Dev')).toBe('nameInvalid');
    expect(nameProblem(team, 'verifica')).toBeNull();
  });

  it('reads a list as a person writes it', () => {
    expect(listOf(' a, b\nc,, a ')).toEqual(['a', 'b', 'c']);
    expect(listOf('')).toEqual([]);
  });
});

describe('the draft over the bridge', () => {
  const parent = {};
  const ORIGIN = 'https://gosidian.example';
  const from = (data: unknown) => accept({ source: parent, origin: ORIGIN, data: { bridge: 'office/1', ...(data as object) } }, parent, ORIGIN);

  it('reads the team with its draft, a change refused, a save', () => {
    const m = from({ type: 'team', team: { path: 'a.md', team: { roles: [] } }, draft: { editing: true, ops: 1 } });
    expect(m?.type === 'team' && m.draft?.ops).toBe(1);
    expect(from({ type: 'team', team: { path: 'a.md' } })).toMatchObject({ draft: null });
    expect(from({ type: 'refused', index: 2, op: { op: 'rename_role' }, message: 'open tasks' })).toEqual({
      type: 'refused', index: 2, op: { op: 'rename_role' }, message: 'open tasks' });
    expect(from({ type: 'saved', ok: false, error: 'conflict' })).toEqual({ type: 'saved', ok: false, error: 'conflict', creates: [] });
    expect(from({ type: 'saved', ok: true, creates: ['a/agents/x.md', 1] })).toEqual({ type: 'saved', ok: true, error: '', creates: ['a/agents/x.md'] });
  });

  it('sends the changes, and has no message that saves', () => {
    expect(editing(true)).toEqual({ bridge: 'office/1', type: 'editing', on: true });
    expect(edit({ op: 'remove_role', role: 'dev' })).toEqual({ bridge: 'office/1', type: 'edit', op: { op: 'remove_role', role: 'dev' } });
    expect(undo()).toEqual({ bridge: 'office/1', type: 'undo' });
    expect(discard()).toEqual({ bridge: 'office/1', type: 'discard' });
  });
});

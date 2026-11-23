import { describe, expect, it } from 'vitest';

import { normalizeView, readState, stateOf } from '../src/model';
import demo from '../src/demo.json';
import small from './fixtures/small.json';
import unreadable from './fixtures/unreadable.json';

describe('normalizeView', () => {
  it('reads the team the server answers', () => {
    const v = normalizeView(demo);
    expect(v).not.toBeNull();
    if (!v || !v.team) {
      return;
    }
    expect(v.path).toBe('esempio/squadra.md');
    expect(v.team.coordinator).toBe('coordinatore');
    expect(v.team.budget).toEqual({ day_usd: 5, task_usd: 1 });
    expect(v.team.max_agents).toBe(2);
    expect(v.team.roles.map((r) => r.name)).toEqual(['coordinatore', 'ricerca', 'sviluppo', 'revisione', 'archivio']);
    const dev = v.team.roles[2];
    expect(dev).toMatchObject({ access: 'exec', repo: 'agents-example', paths: ['web/', 'test/'], forbid: ['package.json'], approve: 'merge', review: false });
    expect(v.team.roles[3].review).toBe(true);
    expect(v.roles.get('sviluppo')?.state).toBe('waiting');
    expect(v.roles.get('archivio')?.agent).toEqual({ path: 'esempio/agents/archivio.md', title: 'archivio', missing: true });
    expect(v.roles.get('revisione')?.tasks[0].waits).toBe('the tasks it depends on');
    expect(v.spent_today).toEqual({ cost_usd: 1.84, tokens: 5120000, steps: 11 });
    expect(v.pipelines).toBe(true);
    expect(v.team.guide).toBe('esempio/regole.md');
    expect(dev).toMatchObject({ guide: '', skills: ['esempio/skills/test-vitest.md'] });
    expect(v.roles.get('sviluppo')?.notes.map((n) => [n.kind, n.path, n.not_skill])).toEqual([
      ['team_guide', 'esempio/regole.md', false], ['skill', 'esempio/skills/test-vitest.md', false]]);
    expect(v.roles.get('ricerca')?.notes).toEqual([]);
  });

  it('reads the guides and skills as links, and a kind it does not know as a guide', () => {
    const v = normalizeView({ team: { guide: '[[esempio/regole|le regole]]', roles: [{ name: 'a', run: 'pi.run', guide: '[[esempio/g]]', skills: ['[[esempio/s]]', 7, ''] }] },
      roles: { a: { notes: [{ path: 'esempio/g.md', kind: 'odd' }, { kind: 'skill' }] } } });
    expect(v?.team?.guide).toBe('esempio/regole.md');
    expect(v?.team?.roles[0]).toMatchObject({ guide: 'esempio/g.md', skills: ['esempio/s.md'], tools: null, profile: '' });
    expect(v?.roles.get('a')?.notes).toEqual([{ path: 'esempio/g.md', title: '', missing: false, kind: 'guide', not_skill: false }]);
  });

  it('reads a team whose block does not read', () => {
    const v = normalizeView(unreadable);
    expect(v?.team).toBeNull();
    expect(v?.problems).toEqual([{ line: 11, message: expect.stringContaining('does not read'), role: '', room: '' }]);
  });

  it('drops the spend while the pipelines are off', () => {
    const v = normalizeView({ ...small, spent_today: { cost_usd: 9, tokens: 1, steps: 1 } });
    expect(v?.pipelines).toBe(false);
    expect(v?.spent_today).toBeNull();
    // Nothing waits with the pipelines off.
    expect(v && stateOf(v, 'capo')).toBe('idle');
  });

  it('reads roles written as a map, and agents as links', () => {
    const v = normalizeView({
      team: { coordinator: 'a', roles: { a: { agent: '[[p/agents/a]]', delegates_to: 'b' }, b: { agent: '[[p/agents/b.md|B]]' } } },
    });
    expect(v?.team?.roles.map((r) => [r.name, r.agent, r.delegates_to])).toEqual([
      ['a', 'p/agents/a.md', ['b']],
      ['b', 'p/agents/b.md', []],
    ]);
    // A role the server said nothing of is idle.
    expect(v?.roles.get('b')).toEqual({ state: 'idle', agent: null, notes: [], unexposed_tools: [], tasks: [], spent_today: null, fields: null });
  });

  it('gives every value its type, whatever the message holds', () => {
    const v = normalizeView({
      path: 3,
      line: 'x',
      team: { coordinator: ['a'], budget: 'many', max_agents: Number.NaN, roles: [{ name: 'a', paths: [1, 'web/', null], review: 'yes' }, { name: 7 }, 'b'] },
      problems: [{ line: 2 }, 'x', { line: 'a', message: 'm' }],
      roles: { a: { state: 'dancing', tasks: [{ title: 'no path' }, { path: 'p/t.md' }], spent_today: 'lots' } },
    });
    expect(v?.path).toBe('');
    expect(v?.line).toBe(0);
    expect(v?.team?.coordinator).toBe('');
    expect(v?.team?.budget).toEqual({ day_usd: 0, task_usd: 0 });
    expect(v?.team?.max_agents).toBe(0);
    expect(v?.team?.roles).toHaveLength(1);
    expect(v?.team?.roles[0].paths).toEqual(['web/']);
    expect(v?.team?.roles[0].review).toBe(false);
    expect(v?.problems).toEqual([{ line: 0, message: 'm', role: '', room: '' }]);
    expect(v?.roles.get('a')?.state).toBe('idle');
    expect(v?.roles.get('a')?.tasks).toEqual([{ path: 'p/t.md', title: '', status: '', waits: '' }]);
    expect(v?.roles.get('a')?.spent_today).toBeNull();
  });

  it('keeps a role named __proto__ a role like another', () => {
    const raw = JSON.parse('{"team":{"roles":[{"name":"__proto__","run":"pi.run"}]},"roles":{"__proto__":{"state":"working"}}}');
    const v = normalizeView(raw);
    expect(v?.team?.roles[0].name).toBe('__proto__');
    expect(v?.roles.get('__proto__')?.state).toBe('working');
    expect(({} as Record<string, unknown>).state).toBeUndefined();
  });

  it('is null for what is not a team', () => {
    for (const raw of [null, undefined, 'team', 3, [demo]]) {
      expect(normalizeView(raw)).toBeNull();
    }
  });

  it('reads the five states and nothing else', () => {
    for (const s of ['working', 'waiting', 'held', 'queued', 'idle']) {
      expect(readState(s)).toBe(s);
    }
    expect(readState('done')).toBe('idle');
    expect(readState(undefined)).toBe('idle');
  });
});

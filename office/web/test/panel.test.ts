import { describe, expect, it } from 'vitest';

import { normalizeView } from '../src/model';
import type { TeamView } from '../src/model';
import { budgetText, panelModel, roleCost, roleLabel } from '../src/panel';
import { ROLE_COLORS } from '../src/layout';
import demo from '../src/demo.json';
import small from './fixtures/small.json';
import unreadable from './fixtures/unreadable.json';

function viewOf(raw: unknown): TeamView {
  const v = normalizeView(raw);
  if (!v) {
    throw new Error('no view');
  }
  return v;
}

const fieldsOf = (v: TeamView, name: string, lang: 'it' | 'en') =>
  Object.fromEntries((panelModel(v, name, lang)?.fields ?? []).map((f) => [f.key, [f.label, f.value]]));

describe('panelModel', () => {
  it('shows a role’s fields in words', () => {
    const f = fieldsOf(viewOf(demo), 'sviluppo', 'it');
    expect(f).toEqual({
      run: ['Esecutore', 'pi.run'],
      model: ['Modello', 'small-model'],
      access: ['Accesso', 'exec'],
      repo: ['Repository', 'agents-example'],
      paths: ['Percorsi', 'web/, test/'],
      forbid: ['Vietati', 'package.json'],
      approve: ['Approvazione', 'merge'],
      checks: ['Controlli', 'npm test && npm run build'],
      preview: ['Anteprima', 'dist'],
      limits: ['Limiti', '60 turni'],
    });
  });

  it('says review, effort, writes and delegations', () => {
    const v = viewOf(demo);
    expect(fieldsOf(v, 'revisione', 'en')).toMatchObject({ review: ['Review', 'yes'], effort: ['Effort', 'high'] });
    expect(fieldsOf(v, 'ricerca', 'en')).toMatchObject({ writes: ['Writes to', 'esempio/ricerca'], limits: ['Limits', '30 turns · 3M tokens'] });
    expect(fieldsOf(v, 'coordinatore', 'it')).toMatchObject({ delegates_to: ['Delega a', 'ricerca, sviluppo, revisione'], limits: ['Limiti', '20 turni · 600 s'] });
    expect(fieldsOf(v, 'sviluppo', 'it').review).toBeUndefined();
  });

  it('says a role’s tools: none, the list, those not exposed', () => {
    const raw = structuredClone(demo) as { team: { roles: Array<{ name: string; tools?: unknown }> }; roles: Record<string, { unexposed_tools?: string[] }> };
    raw.team.roles.find((r) => r.name === 'ricerca')!.tools = ['vec-pg', 'layout_render'];
    raw.team.roles.find((r) => r.name === 'revisione')!.tools = [];
    raw.roles.ricerca.unexposed_tools = ['layout_render'];
    const v = viewOf(raw);
    expect(fieldsOf(v, 'ricerca', 'it').tools).toEqual(['Tool', 'vec-pg, layout_render · non esposti nel progetto: layout_render']);
    expect(fieldsOf(v, 'revisione', 'en').tools).toEqual(['Tools', 'none']);
    expect(fieldsOf(v, 'sviluppo', 'it').tools).toBeUndefined();
  });

  it('lists the guides and skills, each to open by its path', () => {
    const m = panelModel(viewOf(demo), 'sviluppo', 'it');
    expect(m?.notes).toEqual([
      { path: 'esempio/regole.md', title: 'Le regole della squadra', kind: 'team_guide', kindLabel: 'linea guida della squadra',
        missing: false, notSkill: false, label: 'Apri la nota Le regole della squadra' },
      { path: 'esempio/skills/test-vitest.md', title: 'I test con vitest', kind: 'skill', kindLabel: 'skill',
        missing: false, notSkill: false, label: 'Apri la nota I test con vitest' },
    ]);
    // A role whose live part says none: the block's, the team's guide too.
    expect(panelModel(viewOf(demo), 'ricerca', 'en')?.notes.map((n) => [n.title, n.kindLabel])).toEqual([['regole', 'the team’s guide']]);
  });

  it('puts the role’s profile first, from the block when the server says nothing', () => {
    const raw = structuredClone(demo) as { team: { roles: Array<{ name: string; profile?: string }> } };
    raw.team.roles.find((r) => r.name === 'ricerca')!.profile = 'esempio/profiles/analyst.md';
    expect(panelModel(viewOf(raw), 'ricerca', 'it')?.notes.map((n) => [n.title, n.kindLabel])).toEqual([['analyst', 'profilo'], ['regole', 'linea guida della squadra']]);
  });

  it('says a guide that is missing and a skill that is none', () => {
    const raw = structuredClone(demo) as { roles: Record<string, { notes?: unknown[] }> };
    raw.roles.revisione.notes = [
      { path: 'esempio/guide/rev.md', title: 'rev', missing: true, kind: 'guide' },
      { path: 'esempio/skills/piana.md', title: 'Piana', missing: false, kind: 'skill', not_skill: true },
    ];
    const notes = panelModel(viewOf(raw), 'revisione', 'en')?.notes ?? [];
    expect(notes.map((n) => [n.kindLabel, n.missing, n.notSkill, n.label])).toEqual([
      ['the role’s guide', true, false, 'Open the note rev (missing)'],
      ['skill', false, true, 'Open the note Piana (not a skill)'],
    ]);
  });

  it('lists the open tasks, each to open by its path', () => {
    const m = panelModel(viewOf(demo), 'revisione', 'it');
    expect(m?.tasks).toEqual([{
      path: 'esempio/tasks/20261118-090030-revisione.md',
      title: 'La revisione delle pagine',
      status: 'submitted',
      waits: 'the tasks it depends on',
      label: 'Apri il task La revisione delle pagine',
    }]);
    expect(m?.state).toBe('held');
    expect(m?.stateLabel).toBe('Fermo');
    expect(m?.color).toBe(ROLE_COLORS[3]);
    expect(panelModel(viewOf(demo), 'archivio', 'it')?.tasks).toEqual([]);
  });

  it('marks a missing agent note', () => {
    const m = panelModel(viewOf(demo), 'archivio', 'it');
    expect(m?.agent).toEqual({ path: 'esempio/agents/archivio.md', title: 'archivio', missing: true, label: 'Apri la nota dell’agente archivio (manca)' });
    expect(panelModel(viewOf(demo), 'ricerca', 'en')?.agent?.label).toBe('Open the agent note ricerca');
  });

  it('takes the agent from the block when the server names none', () => {
    const v = viewOf({ team: { roles: [{ name: 'a', agent: 'p/agents/a.md' }] } });
    expect(panelModel(v, 'a', 'it')?.agent).toMatchObject({ path: 'p/agents/a.md', title: 'a', missing: false });
  });

  it('says today’s spend with the pipelines on, and no spend nor waits with them off', () => {
    expect(panelModel(viewOf(demo), 'sviluppo', 'en')?.spent).toBe('$0.96 · 2.7M tokens · 5 steps');
    const off = viewOf(small);
    const m = panelModel(off, 'capo', 'it');
    expect(m?.spent).toBeNull();
    expect(m?.tasks[0].waits).toBe('');
    expect(m?.state).toBe('idle');
    expect(m?.coordinator).toBe(true);
  });

  it('is null for a role that is not there', () => {
    expect(panelModel(viewOf(demo), 'nessuno', 'it')).toBeNull();
    expect(panelModel(viewOf(unreadable), 'capo', 'it')).toBeNull();
  });
});

describe('a role’s label and cost', () => {
  it('names the role, its part, its state and its cost', () => {
    const v = viewOf(demo);
    expect(roleLabel(v, 'coordinatore', 'it')).toBe('coordinatore, coordina, Al lavoro, 0,42\u00a0$');
    expect(roleLabel(v, 'archivio', 'en')).toBe('archivio, Idle, $0.00');
    expect(roleCost(v, 'sviluppo', 'en')).toBe('$0.96');
  });

  it('has no cost with the pipelines off', () => {
    const v = viewOf(small);
    expect(roleCost(v, 'dev', 'it')).toBe('');
    expect(roleLabel(v, 'dev', 'it')).toBe('dev, Libero');
  });
});

describe('budgetText', () => {
  it('says what the team spent of its day', () => {
    expect(budgetText(viewOf(demo), 'it')).toEqual({ text: '1,84\u00a0$ di 5,00\u00a0$', ratio: 1.84 / 5 });
    expect(budgetText(viewOf(demo), 'en')?.text).toBe('$1.84 of $5.00');
  });

  it('knows no limit, and no spend with the pipelines off', () => {
    const noLimit = viewOf({ ...demo, team: { ...demo.team, budget: { day_usd: 0, task_usd: 0 } } });
    expect(budgetText(noLimit, 'en')).toEqual({ text: '$1.84, no limit', ratio: null });
    expect(budgetText(viewOf(small), 'it')).toBeNull();
    expect(budgetText(viewOf(unreadable), 'it')).toBeNull();
  });
});

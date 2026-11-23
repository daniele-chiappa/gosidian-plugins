import { describe, expect, it } from 'vitest';

import { normalizeView, roomOf, stateOf } from '../src/model';
import type { TeamView } from '../src/model';
import { computeLayout, seatOrder } from '../src/layout';
import { panelModel, roleCost, roleLabel } from '../src/panel';
import { money } from '../src/i18n';
import rooms from './fixtures/rooms.json';

function viewOf(raw: unknown): TeamView {
  const v = normalizeView(raw);
  if (!v || !v.team) {
    throw new Error('no view');
  }
  return v;
}

describe('the rooms of a team', () => {
  it('reads each room with its view, none for one that cannot be read', () => {
    const v = viewOf(rooms);
    expect(v.team?.rooms).toEqual([{ name: 'front', path: 'esempio/front.md' }, { name: 'chiusa', path: 'esempio/chiusa.md' }]);
    expect(roomOf(v, 'front')?.view?.team?.coordinator).toBe('lead');
    expect(roomOf(v, 'front')?.view?.rooms).toEqual([]);
    expect(roomOf(v, 'chiusa')?.view).toBeNull();
    expect(roomOf(v, 'dev')).toBeNull();
  });

  it('shows the state of its roles that asks most of a person', () => {
    const v = viewOf(rooms);
    expect(stateOf(v, 'front')).toBe('waiting');
    expect(stateOf(v, 'chiusa')).toBe('idle');
  });

  it('seats a room where its coordinator delegates, with the arrow, as a room', () => {
    const v = viewOf(rooms);
    const team = v.team!;
    expect(seatOrder(team)).toEqual({ head: 'capo', rest: ['front', 'dev', 'chiusa'] });
    const l = computeLayout(team, 3);
    const front = l.desks.find((d) => d.name === 'front');
    expect(front?.room).toBe(true);
    expect(l.desks.find((d) => d.name === 'dev')?.room).toBe(false);
    expect(l.links.map((k) => `${k.from}>${k.to}`)).toEqual(['capo>front', 'capo>dev']);
  });

  it('says a room on the map: its name, room, state and spend', () => {
    const v = viewOf(rooms);
    expect(roleLabel(v, 'front', 'it')).toBe(`front, stanza, Aspetta una persona, ${money('it', 0.75)}`);
    expect(roleCost(v, 'chiusa', 'en')).toBe('$0.00');
  });

  it('gives a room a panel: its team, its roles, their tasks, its note', () => {
    const m = panelModel(viewOf(rooms), 'front', 'it');
    expect(m?.room).toBe(true);
    expect(m?.fields).toEqual([
      { key: 'room', label: 'Stanza', value: 'esempio/front.md' },
      { key: 'roles', label: 'Ruoli', value: 'lead (coordina): Al lavoro, ui: Aspetta una persona' },
    ]);
    expect(m?.tasks.map((x) => [x.title, x.status])).toEqual([['La pagina', 'lead · working'], ['Il bottone', 'ui · review']]);
    expect(m?.notes.map((n) => [n.path, n.title, n.kindLabel, n.missing])).toEqual([['esempio/front.md', 'Il front', 'la squadra della stanza', false]]);
    expect(m?.agent).toBeNull();
    const closed = panelModel(viewOf(rooms), 'chiusa', 'en');
    expect(closed?.fields[1].value).toBe('its note is missing or cannot be read');
    expect(closed?.notes[0].label).toBe('Open the note chiusa (missing)');
  });
});

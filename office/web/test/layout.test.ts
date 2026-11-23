import { describe, expect, it } from 'vitest';

import type { Desk, OfficeLayout } from '../src/layout';
import {
  CHARACTERS, DESK, LABEL_GAP, LABEL_MARGIN, MIN_SHARE, ROLE_COLORS, VIEW, columnsFor, computeLayout, labelRoom, modelFor, neighbor,
  scaleFor, seatOrder, signature,
} from '../src/layout';
import type { Team } from '../src/model';
import { normalizeView } from '../src/model';
import demo from '../src/demo.json';
import small from './fixtures/small.json';

function teamOf(raw: unknown): Team {
  const t = normalizeView(raw)?.team;
  if (!t) {
    throw new Error('no team');
  }
  return t;
}

// big is a team of eight: a coordinator who gives to five, one of them
// giving on to another, and a role nobody gives to.
function big(): Team {
  const r = (name: string, delegates_to: string[] = []) => ({ name, run: 'pi.run', delegates_to });
  return teamOf({
    team: {
      coordinator: 'capo',
      roles: [r('a'), r('capo', ['a', 'b', 'c', 'd', 'e']), r('b'), r('c', ['f']), r('d'), r('e'), r('f'), r('g')],
    },
  });
}

const desk = (l: OfficeLayout, name: string): Desk => {
  const d = l.desks.find((x) => x.name === name);
  if (!d) {
    throw new Error('no desk ' + name);
  }
  return d;
};

describe('computeLayout', () => {
  it('puts the coordinator at the head and the others in rows below', () => {
    const l = computeLayout(teamOf(demo), 3);
    const head = desk(l, 'coordinatore');
    expect(head).toMatchObject({ x: 0, z: 0, row: 0, head: true });
    // Its delegates first, in its order, then the rest of the block.
    expect(l.order).toEqual(['coordinatore', 'ricerca', 'sviluppo', 'revisione', 'archivio']);
    expect(l.desks.filter((d) => d.row === 1).map((d) => [d.name, d.x])).toEqual([['ricerca', -DESK.dx], ['sviluppo', 0], ['revisione', DESK.dx]]);
    expect(desk(l, 'archivio')).toMatchObject({ row: 2, x: 0 });
    expect(desk(l, 'archivio').z).toBeCloseTo(DESK.headGap + DESK.dz, 6);
    for (const d of l.desks.filter((x) => !x.head)) {
      expect(d.z).toBeGreaterThan(head.z);
    }
  });

  it('wraps the rows at the columns it is given', () => {
    const t = big();
    expect(seatOrder(t)).toEqual({ head: 'capo', rest: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    for (const cols of [2, 3, 4]) {
      const l = computeLayout(t, cols);
      const rows = new Map<number, number>();
      for (const d of l.desks) {
        rows.set(d.row, (rows.get(d.row) ?? 0) + 1);
      }
      expect(rows.get(0)).toBe(1);
      for (const [row, n] of rows) {
        if (row > 0) {
          expect(n).toBeLessThanOrEqual(cols);
        }
      }
      expect(l.columns).toBe(cols);
      expect(l.desks).toHaveLength(8);
    }
  });

  it('has no head without a coordinator among the roles', () => {
    const t = teamOf({ team: { coordinator: 'nobody', roles: [{ name: 'a' }, { name: 'b' }] } });
    const l = computeLayout(t, 4);
    expect(l.desks.every((d) => !d.head && d.row === 0)).toBe(true);
    expect(l.desks.map((d) => d.x)).toEqual([-DESK.dx / 2, DESK.dx / 2]);
  });

  it('draws a path for each delegation to a role of the team', () => {
    const l = computeLayout(teamOf(small), 4);
    // "nessuno" is no role: no path to it.
    expect(l.links.map((x) => [x.from, x.to])).toEqual([['capo', 'dev']]);
    const t = big();
    const lb = computeLayout(t, 3);
    expect(lb.links.map((x) => `${x.from}>${x.to}`)).toEqual(['capo>a', 'capo>b', 'capo>c', 'capo>d', 'capo>e', 'c>f']);
  });

  it('runs the paths along the aisles, into the delegate from behind', () => {
    for (const cols of [2, 3, 4]) {
      const l = computeLayout(big(), cols);
      for (const link of l.links) {
        const from = desk(l, link.from);
        const to = desk(l, link.to);
        const pts = link.points;
        const end = pts[pts.length - 1];
        expect(end).toEqual([to.x, Math.round((to.z + DESK.back) * 1000) / 1000]);
        // The last stretch goes down into the delegate's place.
        expect(pts[pts.length - 2][0]).toBe(to.x);
        expect(pts[pts.length - 2][1]).toBeLessThan(end[1]);
        if (to.z > from.z) {
          expect(pts[0]).toEqual([from.x, Math.round((from.z + DESK.front) * 1000) / 1000]);
        }
        for (let i = 0; i + 1 < pts.length; i++) {
          const [a, b] = [pts[i], pts[i + 1]];
          // Square turns only.
          expect(a[0] === b[0] || a[1] === b[1], `${link.from}>${link.to} ${JSON.stringify(pts)}`).toBe(true);
          // A stretch down past a row runs between its desks.
          if (a[0] === b[0]) {
            const lo = Math.min(a[1], b[1]);
            const hi = Math.max(a[1], b[1]);
            for (const d of l.desks) {
              if (d.name === link.from || d.name === link.to) {
                continue;
              }
              if (d.z > lo && d.z < hi) {
                expect(Math.abs(d.x - a[0]), `${link.from}>${link.to} past ${d.name}`).toBeGreaterThanOrEqual(DESK.dx / 2 - 1e-6);
              }
            }
          }
        }
      }
    }
  });

  it('routes up and sideways too', () => {
    const t = teamOf({
      team: {
        coordinator: 'capo',
        roles: [{ name: 'capo' }, { name: 'a', delegates_to: ['b', 'capo'] }, { name: 'b' }, { name: 'c' }, { name: 'd', delegates_to: ['a'] }],
      },
    });
    const l = computeLayout(t, 3);
    const byPair = new Map(l.links.map((x) => [`${x.from}>${x.to}`, x.points] as const));
    // a and b share a row: along the aisle behind it, in a's lane (the
    // first of two delegators).
    expect(byPair.get('a>b')?.[1][1]).toBeCloseTo(DESK.headGap + DESK.aisle - 0.07, 3);
    // To the head from below: up a gap, never through the head's desk.
    const up = byPair.get('a>capo') ?? [];
    for (let i = 0; i + 1 < up.length; i++) {
      const [a, b] = [up[i], up[i + 1]];
      if (a[0] === b[0] && Math.min(a[1], b[1]) < 0 && Math.max(a[1], b[1]) > 0) {
        expect(Math.abs(a[0])).toBeGreaterThanOrEqual(DESK.dx / 2 - 1e-6);
      }
    }
    expect(up[up.length - 1]).toEqual([0, DESK.back]);
    expect(byPair.has('d>a')).toBe(true);
  });

  it('gives each role a color of the palette and a character that stays its own', () => {
    const l = computeLayout(teamOf(demo), 4);
    expect(l.desks.map((d) => d.color)).toEqual(l.desks.map((d) => ROLE_COLORS[d.index]));
    expect(new Set(l.desks.map((d) => d.color)).size).toBe(5);
    expect(modelFor('sviluppo')).toBe(modelFor('sviluppo'));
    expect(l.desks.map((d) => d.model)).toEqual(l.desks.map((d) => modelFor(d.name)));
    // Many names reach every character, and nothing else.
    const names = Array.from({ length: 60 }, (_, i) => `role-${i}`);
    expect(new Set(names.map(modelFor))).toEqual(new Set(CHARACTERS));
  });

  it('frames the desks in its bounds', () => {
    const l = computeLayout(big(), 3);
    for (const d of l.desks) {
      expect(d.x).toBeGreaterThan(l.bounds.minX);
      expect(d.x).toBeLessThan(l.bounds.maxX);
      expect(d.z + DESK.aisle).toBeGreaterThanOrEqual(l.bounds.minZ);
      expect(d.z + DESK.front).toBeLessThan(l.bounds.maxZ);
    }
  });

  it('builds again for new columns or roles, not for new states', () => {
    const t = teamOf(demo);
    const a = signature(computeLayout(t, 3));
    expect(signature(computeLayout(teamOf({ ...demo, roles: {} }), 3))).toBe(a);
    expect(signature(computeLayout(t, 2))).not.toBe(a);
    const fewer = teamOf({ ...demo, team: { ...demo.team, roles: demo.team.roles.slice(0, 3) } });
    expect(signature(computeLayout(fewer, 3))).not.toBe(a);
  });
});

describe('columnsFor', () => {
  // A team like a lab's: a coordinator and three roles.
  const squadra = () => teamOf({
    team: { coordinator: 'coordinatore', roles: [
      { name: 'coordinatore', delegates_to: ['conoscenza', 'sviluppo', 'revisore'] },
      { name: 'conoscenza' }, { name: 'sviluppo' }, { name: 'revisore' }] },
  });
  // Long names, as people write them.
  const long = () => teamOf({
    team: { coordinator: 'coordinamento-tecnico', roles: [
      { name: 'coordinamento-tecnico', delegates_to: ['documentazione', 'analisi-dei-requisiti', 'sviluppo', 'revisione'] },
      { name: 'documentazione' }, { name: 'analisi-dei-requisiti' }, { name: 'sviluppo' }, { name: 'revisione' }] },
  });

  it('fits the desks to the shape of the map', () => {
    const t = teamOf(demo);
    // A wide window: the four delegates in one row.
    expect(columnsFor(t, 1100, 620)).toBe(4);
    // A phone: two a row.
    expect(columnsFor(t, 358, 560)).toBe(2);
    const many = big();
    expect(columnsFor(many, 1100, 380)).toBeGreaterThan(columnsFor(many, 1100, 900));
    // A lone delegate sits under the head.
    expect(columnsFor(teamOf(small), 1100, 600)).toBe(1);
  });

  it('keeps the labels whole when the office can stay big enough', () => {
    // At a phone's map, «conoscenza 0,00 $» (about 150 px) does not fit
    // three or two a row: one column, every label whole.
    const t = squadra();
    const c = columnsFor(t, 363, 520, { whole: 150, least: 110, height: 26 });
    expect(labelRoom(t, c, 363, 520)).toBeGreaterThanOrEqual(150);
    expect(c).toBe(1);
    // Short labels keep two a row on the same map.
    expect(columnsFor(t, 363, 520, { whole: 100, least: 90, height: 26 })).toBe(2);
  });

  it('keeps a wide window in rows for a label a few pixels too long', () => {
    // As measured in gosidian at 1100×800: the map 810×377, «conoscenza
    // 0,00 $» 140 px, three a row leave it 136. One column would keep it
    // whole at about 61% of the size: the office stays in a row of three.
    const t = squadra();
    const labels = { whole: 140, least: 100, height: 28 };
    expect(columnsFor(t, 810, 377, labels)).toBe(3);
    expect(labelRoom(t, 3, 810, 377)).toBeGreaterThanOrEqual(labels.least);
    // A phone's map keeps one column, every label whole.
    expect(columnsFor(t, 364, 382, labels)).toBe(1);
  });

  it('shortens the names rather than shrink the office past its share', () => {
    // A wide and low map with long names: four a row, the names shortened.
    const t = long();
    const labels = { whole: 230, least: 112, height: 26 };
    const c = columnsFor(t, 810, 377, labels);
    expect(c).toBeGreaterThanOrEqual(3);
    expect(labelRoom(t, c, 810, 377)).toBeLessThan(labels.whole);
    expect(labelRoom(t, c, 810, 377)).toBeGreaterThanOrEqual(labels.least);
    expect(scaleFor(t, c, 810, 377)).toBeGreaterThanOrEqual(MIN_SHARE * scaleFor(t, 4, 810, 377) - 1e-9);
  });

  it('keeps every name begun, even on a map too small for the rest', () => {
    // 363×239: no layout big enough leaves room for a few letters of the
    // long names; one column keeps them whole.
    const t = long();
    const c = columnsFor(t, 363, 239, { whole: 180, least: 112, height: 26 });
    expect(labelRoom(t, c, 363, 239)).toBeGreaterThanOrEqual(112);
    // And two rows of labels never meet.
    expect(scaleFor(t, c, 363, 239) * DESK.dz * Math.sin(VIEW.elevation)).toBeGreaterThanOrEqual(26);
  });

  it('never lets two labels of a row overlap', () => {
    // A label is capped at the room of its column: two neighbours, each at
    // most that wide and centred on its desk, keep the gap between them.
    for (const t of [teamOf(demo), big(), squadra(), long()]) {
      for (const [w, h] of [[363, 520], [810, 377], [390, 663], [1100, 622]]) {
        for (const need of [90, 150, 230]) {
          const c = columnsFor(t, w, h, { whole: need, least: need, height: 1 });
          const room = labelRoom(t, c, w, h);
          if (c > 1) {
            expect(scaleFor(t, c, w, h) * DESK.dx - room).toBeCloseTo(LABEL_GAP, 6);
          } else {
            expect(room).toBe(w - 2 * LABEL_MARGIN);
          }
          // The order of preference: big enough with whole labels, big
          // enough with names begun, then any with whole labels, any with
          // names begun, else the most room.
          const all = Array.from({ length: Math.min(8, t.roles.length - 1) }, (_, i) => i + 1)
            .map((o) => ({ o, scale: scaleFor(t, o, w, h), room: labelRoom(t, o, w, h) }));
          const top = Math.max(...all.map((x) => x.scale));
          const bigEnough = (x: (typeof all)[number]) => x.scale >= MIN_SHARE * top - 1e-9;
          const fits = (x: (typeof all)[number]) => x.room >= need;
          const tier = [all.filter((x) => bigEnough(x) && fits(x)), all.filter(fits)].find((set) => set.length > 0);
          const expected = tier
            ? tier.reduce((m, x) => (x.scale > m.scale + 1e-9 ? x : m)).o
            : all.reduce((m, x) => (x.room > m.room + 1e-9 ? x : m)).o;
          expect(c, `${w}×${h} ${need}`).toBe(expected);
        }
      }
    }
  });

  it('keeps a default while the map has no size', () => {
    expect(columnsFor(teamOf(demo), 0, 0)).toBe(4);
  });
});

describe('neighbor', () => {
  const l = computeLayout(teamOf(demo), 3);

  it('moves in reading order with left and right', () => {
    expect(neighbor(l, 'coordinatore', 'right')).toBe('ricerca');
    expect(neighbor(l, 'revisione', 'right')).toBe('archivio');
    expect(neighbor(l, 'archivio', 'right')).toBe('archivio');
    expect(neighbor(l, 'ricerca', 'left')).toBe('coordinatore');
    expect(neighbor(l, 'coordinatore', 'left')).toBe('coordinatore');
  });

  it('moves to the nearest desk above or below', () => {
    expect(neighbor(l, 'coordinatore', 'down')).toBe('sviluppo');
    expect(neighbor(l, 'revisione', 'up')).toBe('coordinatore');
    expect(neighbor(l, 'revisione', 'down')).toBe('archivio');
    expect(neighbor(l, 'archivio', 'down')).toBe('archivio');
  });

  it('goes to the first and the last', () => {
    expect(neighbor(l, 'sviluppo', 'first')).toBe('coordinatore');
    expect(neighbor(l, 'sviluppo', 'last')).toBe('archivio');
    expect(neighbor(l, 'gone', 'right')).toBe('coordinatore');
  });
});

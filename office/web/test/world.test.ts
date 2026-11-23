import { AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
import { describe, expect, it } from 'vitest';

import { computeLayout } from '../src/layout';
import type { Team } from '../src/model';
import { workClip } from '../src/scene';
import {
  CORRIDOR, ORBIT, VIEW_KEY, clampTarget, facing, fitOrbit, lowered, orbitPosition, readViewMode, rememberView, rememberedView,
  roomColumns, roomRoleKey, splitKey, wallsOf, windowsOf, worldLayout, worldSignature,
} from '../src/world';

// The 3D of the office: the rooms' offices behind the
// team's, the walls, the camera, the view a browser remembers.

function team(coordinator: string, names: string[], rooms: string[] = []): Team {
  return {
    path: 'esempio/squadra.md', coordinator, split: '', budget: { day_usd: 0, task_usd: 0 }, max_agents: 0, max_rounds: 0,
    reopen_on: '', alert: [], approvers: [], guide: '', rooms: rooms.map((name) => ({ name, path: `esempio/${name}.md` })),
    roles: names.map((name) => ({
      name, agent: '', run: 'pi.run', model: '', effort: '', max_turns: 0, max_seconds: 0, max_tokens: 0, access: '', repo: '',
      host: '', paths: [], forbid: [], checks: '', preview: '', writes: [], approve: '', review: false, guide: '', skills: [],
      profile: '', tools: null, delegates_to: name === coordinator ? [...names.filter((n) => n !== name), ...rooms] : [],
    })),
  };
}

describe('the keys of the 3D', () => {
  it('names a role of a room after the room, and reads it back', () => {
    expect(roomRoleKey('front', 'lead')).toBe('front/lead');
    expect(splitKey('front/lead')).toEqual({ room: 'front', name: 'lead' });
    expect(splitKey('capo')).toEqual({ room: null, name: 'capo' });
  });
});

describe('worldLayout', () => {
  const main = computeLayout(team('capo', ['capo', 'dev', 'ui'], ['front', 'back']), 3);

  it('puts the rooms behind the team, across the corridor, side by side', () => {
    const w = worldLayout(main, [
      { name: 'front', title: 'Il front', team: team('lead', ['lead', 'a', 'b']) },
      { name: 'back', title: '', team: team('boss', ['boss']) },
    ]);
    expect(w.rooms.map((o) => [o.room, o.title])).toEqual([['front', 'Il front'], ['back', 'back']]);
    for (const o of w.rooms) {
      // Its front edge faces the team's back across the corridor.
      expect(o.layout.bounds.maxZ + o.z).toBeCloseTo(main.bounds.minZ - CORRIDOR, 6);
    }
    const [a, b] = w.rooms;
    expect(a.layout.bounds.maxX + a.x).toBeLessThan(b.layout.bounds.minX + b.x);
    // The row is centred on the team's office.
    const left = a.layout.bounds.minX + a.x;
    const right = b.layout.bounds.maxX + b.x;
    expect((left + right) / 2).toBeCloseTo((main.bounds.minX + main.bounds.maxX) / 2, 6);
    expect(w.bounds.minZ).toBeLessThan(a.layout.bounds.minZ + a.z);
    expect(w.bounds.maxZ).toBeGreaterThan(main.bounds.maxZ);
  });

  it('leaves out a room whose team is not read, and has no room without rooms', () => {
    const w = worldLayout(main, [{ name: 'front', title: '', team: null }, { name: 'back', title: '', team: team('boss', []) }]);
    expect(w.rooms).toEqual([]);
    expect(worldSignature(w)).toBe('[]');
  });

  it('lays a room in a square', () => {
    expect(roomColumns(team('lead', ['lead', 'a']))).toBe(1);
    expect(roomColumns(team('lead', ['lead', 'a', 'b', 'c', 'd']))).toBe(2);
    expect(roomColumns(team('', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r']))).toBe(4);
  });

  it('changes its signature when the people of a room change, not otherwise', () => {
    const one = worldLayout(main, [{ name: 'front', title: '', team: team('lead', ['lead', 'a']) }]);
    const same = worldLayout(main, [{ name: 'front', title: 'Altro titolo', team: team('lead', ['lead', 'a']) }]);
    const other = worldLayout(main, [{ name: 'front', title: '', team: team('lead', ['lead', 'a', 'b']) }]);
    expect(worldSignature(same)).toBe(worldSignature(one));
    expect(worldSignature(other)).not.toBe(worldSignature(one));
  });
});

describe('the walls', () => {
  const b = { minX: -4, maxX: 4, minZ: -3, maxZ: 5 };

  it('stand around the floor, each facing out', () => {
    const w = wallsOf(b);
    expect(w.map((x) => [x.side, x.nx, x.nz])).toEqual([['back', 0, -1], ['front', 0, 1], ['left', -1, 0], ['right', 1, 0]]);
    expect(w[0].z0).toBeLessThan(b.minZ);
    expect(w[3].x0).toBeGreaterThan(b.maxX);
  });

  it('come down between the camera and the office', () => {
    const down = (x: number, z: number) => wallsOf(b).filter((w) => lowered(w, x, z)).map((w) => w.side);
    expect(down(0, 30)).toEqual(['front']);
    expect(down(20, 25)).toEqual(['front', 'right']);
    expect(down(-20, -20)).toEqual(['back', 'left']);
    // From above the office, none.
    expect(down(0, 1)).toEqual([]);
  });

  it('have windows along them, none on a short one', () => {
    expect(windowsOf(2)).toEqual([]);
    expect(windowsOf(5.6)).toEqual([2.8]);
    expect(windowsOf(6)).toEqual([1.5, 4.5]);
    const w = windowsOf(13);
    expect(w).toHaveLength(4);
    expect(w[1] - w[0]).toBeCloseTo(w[2] - w[1], 6);
  });
});

describe('the camera of the 3D', () => {
  const b = { minX: -6, maxX: 6, minZ: -12, maxZ: 5 };

  it('holds every corner of the offices, walls and labels, inside the view', () => {
    for (const aspect of [990 / 458, 1, 390 / 500]) {
      const o = fitOrbit(b, aspect);
      expect(o.target).toEqual({ x: 0, y: 0.5, z: -3.5 });
      const cam = orbitPosition(o);
      // The camera's axes, as the scene's camera has them.
      const f = [o.target.x - cam.x, o.target.y - cam.y, o.target.z - cam.z];
      const n = Math.hypot(...f);
      const fwd = f.map((v) => v / n);
      const right = [Math.cos(o.azimuth), 0, -Math.sin(o.azimuth)];
      const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
      const tan = Math.tan((ORBIT.fov * Math.PI) / 360);
      let widest = 0;
      for (const x of [b.minX, b.maxX]) {
        for (const z of [b.minZ, b.maxZ]) {
          for (const y of [0, 2.2]) {
            const q = [x - cam.x, y - cam.y, z - cam.z];
            const depth = q[0] * fwd[0] + q[1] * fwd[1] + q[2] * fwd[2];
            const sx = (q[0] * right[0] + q[1] * right[1] + q[2] * right[2]) / (depth * tan * aspect);
            const sy = (q[0] * up[0] + q[1] * up[1] + q[2] * up[2]) / (depth * tan);
            expect(Math.abs(sx)).toBeLessThanOrEqual(0.93);
            expect(Math.abs(sy)).toBeLessThanOrEqual(0.93);
            widest = Math.max(widest, Math.abs(sx), Math.abs(sy));
          }
        }
      }
      // And no farther than it needs.
      expect(widest).toBeGreaterThan(0.9);
    }
  });

  it('starts from the side of the map viewer, turned a little, above the floor', () => {
    const o = fitOrbit(b, 2);
    const p = orbitPosition(o);
    expect(p.z).toBeGreaterThan(o.target.z);
    expect(p.x).toBeGreaterThan(o.target.x);
    expect(p.y).toBeGreaterThan(o.target.y);
    expect(o.polar).toBeGreaterThan(ORBIT.minPolar);
    expect(o.polar).toBeLessThan(ORBIT.maxPolar);
    expect(orbitPosition({ target: { x: 0, y: 0, z: 0 }, distance: 10, azimuth: 0, polar: Math.PI / 2 })).toMatchObject({ x: 0, z: 10 });
  });

  it('keeps the point it turns around over the offices', () => {
    expect(clampTarget({ x: 20, y: 0.5, z: -40 }, b)).toEqual({ x: 6, y: 0.5, z: -12 });
    expect(clampTarget({ x: 1, y: 0.5, z: 1 }, b)).toEqual({ x: 1, y: 0.5, z: 1 });
  });

  it('turns a character toward a point', () => {
    expect(facing(0, 0, 0, 10)).toBeCloseTo(0, 6);
    expect(facing(0, 0, 10, 0)).toBeCloseTo(Math.PI / 2, 6);
    expect(Math.abs(facing(0, 0, 0, -10))).toBeCloseTo(Math.PI, 6);
  });
});

describe('the view a browser remembers', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('is the map at first, then the last one chosen', () => {
    const s = store();
    expect(rememberedView(() => s)).toBe('map');
    rememberView(() => s, '3d');
    expect(s.m.get(VIEW_KEY)).toBe('3d');
    expect(rememberedView(() => s)).toBe('3d');
    rememberView(() => s, 'list');
    expect(rememberedView(() => s)).toBe('list');
  });

  it('is the map for a browser that keeps nothing or something else', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(rememberedView(() => broken)).toBe('map');
    expect(() => rememberView(() => broken, '3d')).not.toThrow();
    expect(rememberedView(() => null)).toBe('map');
    expect(readViewMode('globo')).toBe('map');
  });
});

describe('workClip', () => {
  const clip = (name: string, d: number) => new AnimationClip(name, d, [
    new QuaternionKeyframeTrack('arm.quaternion', [0, d], [0, 0, 0, 1, 0, 0, 0.1, 0.99]),
    new VectorKeyframeTrack('hips.position', [0, d], [0, 0, 0, 0, 0.1, 0]),
  ]);

  it('is a reach of the left hand, then of the right', () => {
    const w = workClip([clip('Idle', 1), clip('Left', 0.6), clip('Ask', 0.6)])!;
    expect(w.name).toBe('Work');
    expect(w.duration).toBeCloseTo(0.6 + 1 / 30 + 0.6, 6);
    const t = w.tracks[0];
    expect(t).toBeInstanceOf(QuaternionKeyframeTrack);
    expect(Array.from(t.times).map((x) => Math.round(x * 1000) / 1000)).toEqual([0, 0.6, 0.633, 1.233]);
    expect(t.values.length).toBe(16);
    expect(w.tracks[1]).toBeInstanceOf(VectorKeyframeTrack);
  });

  it('is none for a model without both reaches', () => {
    expect(workClip([clip('Idle', 1), clip('Ask', 0.6)])).toBeNull();
  });
});

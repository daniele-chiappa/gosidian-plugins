import { describe, expect, it } from 'vitest';

import { STATES, normalizeView } from '../src/model';
import { MARKERS, countStates, marker, shapeParts, stateHelp, stateLabel } from '../src/states';
import demo from '../src/demo.json';
import small from './fixtures/small.json';

// The WCAG relative luminance of a #rrggbb color.
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('markers', () => {
  it('give each of the five states a color and a shape of its own', () => {
    expect(Object.keys(MARKERS).sort()).toEqual([...STATES].sort());
    expect(new Set(STATES.map((s) => MARKERS[s].color)).size).toBe(5);
    expect(new Set(STATES.map((s) => MARKERS[s].shape)).size).toBe(5);
    // Not even the silhouettes repeat: the first part of each shape.
    const silhouettes = STATES.map((s) => JSON.stringify(shapeParts(MARKERS[s].shape)[0]));
    expect(new Set(silhouettes).size).toBe(5);
  });

  it('carry white marks that read on their color, and read on both floors', () => {
    for (const s of STATES) {
      expect(contrast(MARKERS[s].color, '#ffffff'), s).toBeGreaterThanOrEqual(4.5);
      // The light floor and the dark one (scene.ts, PALETTES): 3:1 for a
      // graphic object.
      expect(contrast(MARKERS[s].color, '#efe9df'), s).toBeGreaterThanOrEqual(3);
      expect(contrast(MARKERS[s].color, '#15181c'), s).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('draw only paths, circles and rectangles', () => {
    for (const s of STATES) {
      const parts = shapeParts(MARKERS[s].shape);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      for (const p of parts) {
        expect(['path', 'circle', 'rect']).toContain(p.tag);
        expect(Object.keys(p.attrs).every((k) => !k.startsWith('on'))).toBe(true);
      }
    }
  });

  it('say an unknown state as idle', () => {
    expect(marker('dancing')).toBe(MARKERS.idle);
    expect(marker('held')).toBe(MARKERS.held);
  });

  it('name each state in both languages', () => {
    for (const s of STATES) {
      for (const lang of ['it', 'en'] as const) {
        expect(stateLabel(lang, s)).not.toMatch(/^state\./);
        expect(stateHelp(lang, s)).not.toMatch(/^stateHelp\./);
      }
    }
    expect(stateLabel('it', 'waiting')).toBe('Aspetta una persona');
    expect(stateLabel('en', 'held')).toBe('Held');
  });
});

describe('countStates', () => {
  it('counts the roles in each state', () => {
    const v = normalizeView(demo);
    expect(v && countStates(v)).toEqual({ working: 1, waiting: 1, held: 1, queued: 1, idle: 1 });
  });

  it('counts nothing waiting with the pipelines off', () => {
    const v = normalizeView(small);
    expect(v && countStates(v)).toEqual({ working: 0, waiting: 0, held: 0, queued: 0, idle: 2 });
  });
});

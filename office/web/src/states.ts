// The markers of the five states: each a color and a shape of its own, so
// that no state is told by its color alone, and its name in words.

import type { RoleState, TeamView } from './model';
import { STATES, stateOf } from './model';
import type { Lang } from './i18n';
import { t } from './i18n';

export type Shape = 'circle-play' | 'bubble' | 'octagon' | 'diamond' | 'ring';

export interface Marker {
  state: RoleState;
  // A color that reads on the light and on the dark floor, with white
  // marks inside (contrast 4.5:1 or more against white).
  color: string;
  shape: Shape;
}

export const MARKERS: Readonly<Record<RoleState, Marker>> = {
  working: { state: 'working', color: '#1f7a45', shape: 'circle-play' },
  waiting: { state: 'waiting', color: '#a35c00', shape: 'bubble' },
  held: { state: 'held', color: '#c0322f', shape: 'octagon' },
  queued: { state: 'queued', color: '#2f63c4', shape: 'diamond' },
  idle: { state: 'idle', color: '#5f6672', shape: 'ring' },
};

export function marker(state: string): Marker {
  return (STATES as readonly string[]).includes(state) ? MARKERS[state as RoleState] : MARKERS.idle;
}

export function stateLabel(lang: Lang, state: RoleState): string {
  return t(lang, `state.${state}`);
}

export function stateHelp(lang: Lang, state: RoleState): string {
  return t(lang, `stateHelp.${state}`);
}

// An SVG element of the marker, 20×20: the silhouette in the state's
// color, the mark inside in white. Paths only, built with the DOM.
export interface ShapePart {
  tag: 'path' | 'circle' | 'rect';
  attrs: Record<string, string>;
  fill: 'color' | 'mark' | 'none';
}

export function shapeParts(shape: Shape): ShapePart[] {
  switch (shape) {
    case 'circle-play':
      return [
        { tag: 'circle', attrs: { cx: '10', cy: '10', r: '9' }, fill: 'color' },
        { tag: 'path', attrs: { d: 'M8 5.5 L14.5 10 L8 14.5 Z' }, fill: 'mark' },
      ];
    case 'bubble':
      return [
        { tag: 'path', attrs: { d: 'M3.5 2 H16.5 A2.5 2.5 0 0 1 19 4.5 V12 A2.5 2.5 0 0 1 16.5 14.5 H9.5 L5 18.5 V14.5 H3.5 A2.5 2.5 0 0 1 1 12 V4.5 A2.5 2.5 0 0 1 3.5 2 Z' }, fill: 'color' },
        { tag: 'circle', attrs: { cx: '6', cy: '8.3', r: '1.5' }, fill: 'mark' },
        { tag: 'circle', attrs: { cx: '10', cy: '8.3', r: '1.5' }, fill: 'mark' },
        { tag: 'circle', attrs: { cx: '14', cy: '8.3', r: '1.5' }, fill: 'mark' },
      ];
    case 'octagon':
      return [
        { tag: 'path', attrs: { d: 'M6.3 1 H13.7 L19 6.3 V13.7 L13.7 19 H6.3 L1 13.7 V6.3 Z' }, fill: 'color' },
        { tag: 'rect', attrs: { x: '6.5', y: '5.5', width: '2.4', height: '9' }, fill: 'mark' },
        { tag: 'rect', attrs: { x: '11.1', y: '5.5', width: '2.4', height: '9' }, fill: 'mark' },
      ];
    case 'diamond':
      return [
        { tag: 'path', attrs: { d: 'M10 0.6 L19.4 10 L10 19.4 L0.6 10 Z' }, fill: 'color' },
        { tag: 'path', attrs: { d: 'M7 5.5 H13 L10 10 L13 14.5 H7 L10 10 Z' }, fill: 'mark' },
      ];
    case 'ring':
      return [
        { tag: 'circle', attrs: { cx: '10', cy: '10', r: '9' }, fill: 'mark' },
        { tag: 'circle', attrs: { cx: '10', cy: '10', r: '7.6', 'stroke-width': '2.8' }, fill: 'none' },
        { tag: 'rect', attrs: { x: '6', y: '8.8', width: '8', height: '2.4' }, fill: 'color' },
      ];
  }
}

// countStates counts the roles in each state, as the page shows them.
export function countStates(view: TeamView): Record<RoleState, number> {
  const out: Record<RoleState, number> = { working: 0, waiting: 0, held: 0, queued: 0, idle: 0 };
  for (const r of view.team?.roles ?? []) {
    out[stateOf(view, r.name)]++;
  }
  return out;
}

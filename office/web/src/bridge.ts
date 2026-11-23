// The bridge office/1 (docs/plugins.md): the page and gosidian's window
// talk with postMessage. The page takes a message only from its parent
// frame and from gosidian's origin, as ?origin= names it, and writes only
// to that origin.

import type { Lang } from './i18n';
import { pickLang } from './i18n';
import type { Draft, Op } from './draft';
import { readDraft } from './draft';
import type { TeamView } from './model';
import { normalizeView } from './model';

export const BRIDGE = 'office/1';

export interface Params {
  // gosidian's origin, or null when the page was not opened by it.
  origin: string | null;
  lang: Lang;
  demo: boolean;
}

// validOrigin is an http(s) origin and nothing more: no path, no query,
// no credentials.
export function validOrigin(o: string | null): string | null {
  if (!o) {
    return null;
  }
  try {
    const u = new URL(o);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== o) {
      return null;
    }
    return o;
  } catch {
    return null;
  }
}

// readParams reads the page's address: the window adds
// host=gosidian&origin=<gosidian's origin>&lang=<it|en>.
export function readParams(search: string, browserLang?: string): Params {
  const q = new URLSearchParams(search);
  return {
    origin: validOrigin(q.get('origin')),
    lang: pickLang(q.get('lang') ?? browserLang, 'it'),
    demo: q.has('demo'),
  };
}

export type Theme = 'light' | 'dark';

export type Incoming =
  | { type: 'team'; view: TeamView; theme: Theme | null; lang: Lang | null; draft: Draft | null }
  | { type: 'error'; message: string }
  | { type: 'refused'; index: number; op: unknown; message: string }
  | { type: 'saved'; ok: boolean; error: string; creates: string[] }
  | { type: 'malformed' };

export interface MessageLike {
  source: unknown;
  origin: string;
  data: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// accept reads a message of the window: null for any message that is not
// one, from another frame, another origin or another bridge.
export function accept(ev: MessageLike, parent: unknown, origin: string | null): Incoming | null {
  if (origin === null || ev.source !== parent || ev.source === null || ev.origin !== origin) {
    return null;
  }
  const d = ev.data;
  if (!isObj(d) || d.bridge !== BRIDGE || typeof d.type !== 'string') {
    return null;
  }
  switch (d.type) {
    case 'team': {
      const view = normalizeView(d.team);
      if (view === null) {
        return { type: 'malformed' };
      }
      const theme = d.theme === 'light' || d.theme === 'dark' ? d.theme : null;
      const lang = typeof d.lang === 'string' && d.lang !== '' ? pickLang(d.lang, 'it') : null;
      return { type: 'team', view, theme, lang, draft: readDraft(d.draft) };
    }
    case 'error':
      return { type: 'error', message: typeof d.message === 'string' ? d.message : '' };
    case 'refused':
      return {
        type: 'refused',
        index: typeof d.index === 'number' ? d.index : -1,
        op: d.op,
        message: typeof d.message === 'string' ? d.message : '',
      };
    case 'saved':
      return {
        type: 'saved',
        ok: d.ok === true,
        error: typeof d.error === 'string' ? d.error : '',
        creates: Array.isArray(d.creates) ? d.creates.filter((x): x is string => typeof x === 'string') : [],
      };
    default:
      return null;
  }
}

export type Outgoing =
  | { bridge: typeof BRIDGE; type: 'ready' }
  | { bridge: typeof BRIDGE; type: 'refresh' }
  | { bridge: typeof BRIDGE; type: 'open'; path: string }
  | { bridge: typeof BRIDGE; type: 'editing'; on: boolean }
  | { bridge: typeof BRIDGE; type: 'edit'; op: Op }
  | { bridge: typeof BRIDGE; type: 'undo' }
  | { bridge: typeof BRIDGE; type: 'discard' };

export const ready = (): Outgoing => ({ bridge: BRIDGE, type: 'ready' });
export const refresh = (): Outgoing => ({ bridge: BRIDGE, type: 'refresh' });
export const open = (path: string): Outgoing => ({ bridge: BRIDGE, type: 'open', path });
// The draft: the window keeps it and saves it from its own bar;
// the page has no message that writes the team.
export const editing = (on: boolean): Outgoing => ({ bridge: BRIDGE, type: 'editing', on });
export const edit = (op: Op): Outgoing => ({ bridge: BRIDGE, type: 'edit', op });
export const undo = (): Outgoing => ({ bridge: BRIDGE, type: 'undo' });
export const discard = (): Outgoing => ({ bridge: BRIDGE, type: 'discard' });

export interface Target {
  postMessage(message: unknown, targetOrigin: string): void;
}

// post writes to gosidian's window, at its origin only: never '*'.
export function post(target: Target | null, origin: string | null, msg: Outgoing): boolean {
  if (target === null || origin === null) {
    return false;
  }
  target.postMessage(msg, origin);
  return true;
}

import { describe, expect, it } from 'vitest';

import { BRIDGE, accept, open, post, readParams, ready, refresh, validOrigin } from '../src/bridge';
import demo from '../src/demo.json';

const parent = { frame: 'gosidian' };
const origin = 'https://vault.example.com';
const msg = (data: unknown, over: { source?: unknown; origin?: string } = {}) => ({
  source: 'source' in over ? over.source : parent,
  origin: over.origin ?? origin,
  data,
});

describe('readParams', () => {
  it('reads what the window adds to the address', () => {
    const p = readParams('?host=gosidian&origin=' + encodeURIComponent(origin) + '&lang=en', 'it-IT');
    expect(p).toEqual({ origin, lang: 'en', demo: false });
  });

  it('takes the browser language, then Italian', () => {
    expect(readParams('?origin=' + encodeURIComponent(origin), 'en-GB').lang).toBe('en');
    expect(readParams('', 'fr-FR').lang).toBe('it');
    expect(readParams('?lang=de').lang).toBe('it');
  });

  it('refuses an origin that is not one', () => {
    for (const bad of ['', '*', 'null', 'javascript:alert(1)', 'https://vault.example.com/', 'https://vault.example.com/notes',
      'https://user:pw@vault.example.com', 'ftp://vault.example.com', 'vault.example.com']) {
      expect(validOrigin(bad), bad).toBeNull();
      expect(readParams('?origin=' + encodeURIComponent(bad)).origin, bad).toBeNull();
    }
    expect(validOrigin('http://127.0.0.1:8084')).toBe('http://127.0.0.1:8084');
  });

  it('knows the example', () => {
    expect(readParams('?demo').demo).toBe(true);
  });
});

describe('accept', () => {
  const team = { bridge: BRIDGE, type: 'team', team: demo, theme: 'dark', lang: 'en' };

  it('takes a team from the parent frame at gosidian’s origin', () => {
    const m = accept(msg(team), parent, origin);
    expect(m?.type).toBe('team');
    if (m?.type !== 'team') {
      return;
    }
    expect(m.theme).toBe('dark');
    expect(m.lang).toBe('en');
    expect(m.view.team?.roles.map((r) => r.name)).toEqual(['coordinatore', 'ricerca', 'sviluppo', 'revisione', 'archivio']);
  });

  it('ignores another frame, another origin, another bridge', () => {
    expect(accept(msg(team, { source: { frame: 'other' } }), parent, origin)).toBeNull();
    expect(accept(msg(team, { source: null }), null, origin)).toBeNull();
    expect(accept(msg(team, { origin: 'https://evil.example.com' }), parent, origin)).toBeNull();
    expect(accept(msg(team, { origin: 'https://vault.example.com:444' }), parent, origin)).toBeNull();
    expect(accept(msg({ ...team, bridge: 'layout/2' }), parent, origin)).toBeNull();
    expect(accept(msg({ ...team, bridge: undefined }), parent, origin)).toBeNull();
    expect(accept(msg(team), parent, null)).toBeNull();
  });

  it('ignores what is not a message of the bridge', () => {
    for (const data of [null, 'team', 42, [team], { bridge: BRIDGE }, { bridge: BRIDGE, type: 'save', team: demo }, { bridge: BRIDGE, type: 7 }]) {
      expect(accept(msg(data), parent, origin), JSON.stringify(data)).toBeNull();
    }
  });

  it('reads an error', () => {
    expect(accept(msg({ bridge: BRIDGE, type: 'error', message: 'the note is gone' }), parent, origin))
      .toEqual({ type: 'error', message: 'the note is gone' });
    expect(accept(msg({ bridge: BRIDGE, type: 'error', message: 3 }), parent, origin)).toEqual({ type: 'error', message: '' });
  });

  it('says when a team is not one', () => {
    expect(accept(msg({ bridge: BRIDGE, type: 'team', team: 'squadra' }), parent, origin)).toEqual({ type: 'malformed' });
  });

  it('takes no theme or language it does not know', () => {
    const m = accept(msg({ ...team, theme: 'blue', lang: '' }), parent, origin);
    expect(m?.type === 'team' && m.theme).toBeNull();
    expect(m?.type === 'team' && m.lang).toBeNull();
  });
});

describe('post', () => {
  it('writes to gosidian’s origin only', () => {
    const sent: Array<[unknown, string]> = [];
    const target = { postMessage: (m: unknown, o: string) => sent.push([m, o]) };
    expect(post(target, origin, ready())).toBe(true);
    expect(post(target, origin, refresh())).toBe(true);
    expect(post(target, origin, open('esempio/tasks/a.md'))).toBe(true);
    expect(sent).toEqual([
      [{ bridge: 'office/1', type: 'ready' }, origin],
      [{ bridge: 'office/1', type: 'refresh' }, origin],
      [{ bridge: 'office/1', type: 'open', path: 'esempio/tasks/a.md' }, origin],
    ]);
    expect(post(target, null, ready())).toBe(false);
    expect(post(null, origin, ready())).toBe(false);
    expect(sent).toHaveLength(3);
  });
});

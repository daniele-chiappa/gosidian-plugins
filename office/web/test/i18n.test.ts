import { describe, expect, it } from 'vitest';

import { CATALOG, amount, money, pickLang, t } from '../src/i18n';

describe('the catalog', () => {
  it('has every string in both languages', () => {
    expect(Object.keys(CATALOG.en).sort()).toEqual(Object.keys(CATALOG.it).sort());
    for (const lang of ['it', 'en'] as const) {
      for (const [k, v] of Object.entries(CATALOG[lang])) {
        expect(v.trim(), `${lang}.${k}`).not.toBe('');
      }
    }
  });

  it('keeps the same placeholders in both languages', () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(CATALOG.it) as Array<keyof typeof CATALOG.it>) {
      expect(holes(CATALOG.en[k]), k).toEqual(holes(CATALOG.it[k]));
    }
  });

  it('fills the placeholders', () => {
    expect(t('it', 'problemLine', { line: 14 })).toBe('riga 14');
    expect(t('en', 'spentOf', { spent: '$1', budget: '$2' })).toBe('$1 of $2');
    expect(t('en', 'problemLine')).toBe('line {line}');
  });
});

describe('pickLang', () => {
  it('reads a language tag', () => {
    expect(pickLang('it-IT')).toBe('it');
    expect(pickLang('EN_us')).toBe('en');
    expect(pickLang('de')).toBe('it');
    expect(pickLang('de', 'en')).toBe('en');
    expect(pickLang(null)).toBe('it');
  });
});

describe('numbers', () => {
  it('writes dollars in each language', () => {
    expect(money('en', 0.4)).toBe('$0.40');
    // Intl keeps the amount and its sign together with a no-break space.
    expect(money('it', 0.4)).toBe('0,40\u00a0$');
    expect(money('en', 0)).toBe('$0.00');
    expect(money('en', 0.001)).toBe('< $0.01');
    expect(money('en', 1234.5)).toBe('$1,234.50');
  });

  it('writes big counts short', () => {
    expect(amount('en', 3076168)).toBe('3.1M');
    expect(amount('en', 950)).toBe('950');
  });
});

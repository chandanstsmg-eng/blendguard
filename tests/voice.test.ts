/**
 * Spoken instructions with a number are put together from recorded clips, so
 * nothing is sent to an online voice. Every piece a phrase needs must exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { phraseClipKeys } from '../src/lib/audio.js';
import { ROOT } from '../server/config.js';

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'audio', 'manifest.json'), 'utf8')) as Record<'en' | 'hi' | 'ml', string[]>;

describe('offline voice', () => {
  it('says weights as words: whole, decimal, hundreds and thousands', () => {
    expect(phraseClipKeys('en', 'say.pour', { g: '12.5' })).toEqual(['say.pour.0', 'num.12', 'num.point', 'num.5', 'say.pour.1']);
    expect(phraseClipKeys('en', 'say.addMore', { g: '250.00' })).toEqual(['say.addMore.0', 'num.200', 'num.50', 'say.addMore.1']);
    expect(phraseClipKeys('en', 'say.over', { g: '1234.05' })).toEqual(['say.over.0', 'num.1', 'num.thousand', 'num.200', 'num.34', 'num.point', 'num.0', 'num.5', 'say.over.1']);
    expect(phraseClipKeys('en', 'say.pour', { g: '100' })).toEqual(['say.pour.0', 'num.100', 'say.pour.1']);
  });

  it('says rack letters and bin numbers', () => {
    expect(phraseClipKeys('en', 'say.goTo', { rack: 'B', bin: 14 })).toEqual(['say.goTo.0', 'chr.B', 'say.goTo.1', 'num.14', 'say.goTo.2']);
  });

  it('greets without the name (a name cannot be pre-recorded)', () => {
    expect(phraseClipKeys('en', 'say.hello', { name: 'Suresh' })).toEqual(['say.hello.0']);
  });

  it('has every clip the number phrases need, in all three languages', () => {
    for (const lang of ['en', 'hi', 'ml'] as const) {
      const have = new Set(manifest[lang]);
      for (const [key, vars] of [
        ['say.pour', { g: '987.65' }],
        ['say.addMore', { g: '3204.5' }],
        ['say.nearly', { g: '0.25' }],
        ['say.over', { g: '15.3' }],
        ['say.goTo', { rack: 'D', bin: 12 }],
      ] as const) {
        const keys = phraseClipKeys(lang, key, vars)!;
        expect(keys, `${lang} ${key}`).not.toBeNull();
        expect(keys.filter((k) => !have.has(k)), `${lang} ${key}`).toEqual([]);
      }
    }
  });
});

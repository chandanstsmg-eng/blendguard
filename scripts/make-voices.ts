/**
 * Records the spoken instructions as MP3 clips in public/audio/<lang>/, using
 * Microsoft's natural Indian voices, and updates public/audio/manifest.json.
 * Needs the internet ONCE, on the PC that prepares the release. The plant never
 * goes online for voice, and no formula data is ever sent anywhere:
 *
 *   say.<key>          fixed phrases ("Now scan the barcode.")
 *   say.<key>.<n>      the fixed pieces of a phrase with a number, e.g. say.pour
 *                      "Pour slowly. You need {g} grams." → say.pour.0 + say.pour.1
 *   num.<n>            number words 0–100 and 200…900, num.thousand, num.point
 *   chr.<A–Z>          letters, for rack codes
 *
 * The station plays the pieces one after another (src/lib/audio.ts).
 *
 *   npm run voices              only phrases whose text changed or have no clip
 *   npm run voices -- --all     re-record everything
 *
 * Run it after correcting any say.* translation in src/lib/i18n.ts, so the
 * spoken words match the screen. public/audio/voices.lock.json remembers which
 * text each clip was recorded from.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { ROOT } from '../server/config.js';

const LANGS = { en: 'en-IN-NeerjaNeural', hi: 'hi-IN-SwaraNeural', ml: 'ml-IN-SobhanaNeural' } as const;
type Lang = keyof typeof LANGS;

const AUDIO = path.join(ROOT, 'public', 'audio');
const LOCK = path.join(AUDIO, 'voices.lock.json');
const src = readFileSync(path.join(ROOT, 'src', 'lib', 'i18n.ts'), 'utf8');
const all = process.argv.includes('--all');
/** First run on clips recorded before this script existed: accept them as they are. */
const adopt = process.argv.includes('--adopt');

function phrases(name: Lang): Record<string, string> {
  const start = src.indexOf(`const ${name}`);
  const body = src.slice(start, src.indexOf('\n};', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s+'(say\.[\w.]+)':\s*'((?:[^'\\]|\\.)*)',/gm)) out[m[1]] = m[2].replace(/\\'/g, "'");
  return out;
}

async function record(lang: Lang, text: string, file: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(LANGS[lang], OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), { rate: '-8%' });
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        audioStream.on('data', (c: Buffer) => chunks.push(c));
        audioStream.on('error', reject);
        audioStream.on('close', () => resolve());
      });
      const audio = Buffer.concat(chunks);
      if (!audio.length) throw new Error('no audio');
      writeFileSync(file, audio);
      return true;
    } catch (err) {
      console.warn(`  retry ${attempt}/3 (${(err as Error).message})`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    } finally {
      tts.close();
    }
  }
  return false;
}

/** Words that join numbers, per language. */
const WORDS: Record<Lang, { thousand: string; point: string }> = {
  en: { thousand: 'thousand', point: 'point' },
  hi: { thousand: 'हज़ार', point: 'दशमलव' },
  ml: { thousand: 'ആയിരം', point: 'ദശാംശം' },
};
const NUMBERS = [...Array.from({ length: 101 }, (_, n) => n), 200, 300, 400, 500, 600, 700, 800, 900];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const hasWords = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** Every clip a language needs: key → text to say. */
function clips(lang: Lang): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, text] of Object.entries(phrases(lang))) {
    if (!text.includes('{')) {
      out.push([key, text]);
      continue;
    }
    // "A {x} B {y} C" → pieces A, B, C (index = position among the text pieces). Pure punctuation is skipped.
    text.split(/\{\w+\}/).forEach((piece, i) => hasWords(piece) && out.push([`${key}.${i}`, piece.trim()]));
  }
  for (const n of NUMBERS) out.push([`num.${n}`, String(n)]);
  out.push(['num.thousand', WORDS[lang].thousand], ['num.point', WORDS[lang].point]);
  for (const c of LETTERS) out.push([`chr.${c}`, `${c}.`]);
  return out;
}

const lock: Record<string, string> = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : {};
const manifest: Record<string, string[]> = {};
let made = 0;
let failed = 0;

for (const lang of Object.keys(LANGS) as Lang[]) {
  mkdirSync(path.join(AUDIO, lang), { recursive: true });
  manifest[lang] = [];
  for (const [key, text] of clips(lang)) {
    const file = path.join(AUDIO, lang, `${key}.mp3`);
    const hash = createHash('sha1').update(`${LANGS[lang]}|${text}`).digest('hex');
    const id = `${lang}/${key}`;
    if (!all && existsSync(file) && (lock[id] === hash || (adopt && !lock[id]))) {
      lock[id] = hash;
      manifest[lang].push(key);
      continue;
    }
    process.stdout.write(`${id} … `);
    if (await record(lang, text, file)) {
      lock[id] = hash;
      manifest[lang].push(key);
      made++;
      console.log('ok');
    } else {
      failed++;
      console.log('FAILED');
    }
    await new Promise((r) => setTimeout(r, 400)); // gentle on the voice service
  }
  manifest[lang].sort();
}

writeFileSync(path.join(AUDIO, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
console.log(`\nVoices: ${made} recorded, ${Object.values(manifest).flat().length} clips in total${failed ? `, ${failed} FAILED (run again later)` : ''}.`);
console.log('Restart BlendGuard (or rebuild with `npm run build`) so the screens use the new clips.');
if (failed) process.exitCode = 1;

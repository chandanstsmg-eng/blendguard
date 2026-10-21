/**
 * Natural spoken instructions in English, Hindi and Malayalam, made by
 * Microsoft's online neural voices (the same ones Edge uses for Read Aloud).
 *
 * Used for phrases that carry a number ("Pour 12.5 grams", "Go to rack B,
 * number 14"), which cannot be pre-recorded. Fixed phrases are played from the
 * recorded clips in public/audio. Needs the internet the first time a
 * sentence is said; after that it is kept in data/tts-cache and works offline.
 * When neither is available the screen falls back to the computer's own voice.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { ROOT } from '../config.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { Lang } from '../../shared/types.js';

const VOICES: Record<Lang, string> = { en: 'en-IN-NeerjaNeural', hi: 'hi-IN-SwaraNeural', ml: 'ml-IN-SobhanaNeural' };
const TIMEOUT_MS = 8000;
const MAX_CACHED = 500;
const CACHE_DIR = path.join(ROOT, 'data', 'tts-cache');

/** Most phrases repeat (same bottle, same weight), so the audio is kept in memory. */
const cache = new Map<string, Buffer>();

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function remember(id: string, audio: Buffer) {
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(id, audio);
  return audio;
}

export async function speech(lang: Lang, text: string): Promise<Buffer> {
  const id = `${lang}|${text}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const file = path.join(CACHE_DIR, `${createHash('sha1').update(`${VOICES[lang]}|${text}`).digest('hex')}.mp3`);
  const saved = await readFile(file).catch(() => null);
  if (saved?.length) return remember(id, saved);

  const tts = new MsEdgeTTS();
  try {
    const audio = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS);
      tts
        .setMetadata(VOICES[lang], OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
        .then(() => {
          const { audioStream } = tts.toStream(escapeXml(text), { rate: '-8%' });
          const chunks: Buffer[] = [];
          audioStream.on('data', (c: Buffer) => chunks.push(c));
          audioStream.on('error', (e: Error) => (clearTimeout(timer), reject(e)));
          audioStream.on('close', () => {
            clearTimeout(timer);
            const buf = Buffer.concat(chunks);
            if (buf.length) resolve(buf);
            else reject(new Error('no audio'));
          });
        })
        .catch((e: unknown) => (clearTimeout(timer), reject(e)));
    });
    await mkdir(CACHE_DIR, { recursive: true })
      .then(() => writeFile(file, audio))
      .catch((err: Error) => logger.warn(`Could not keep voice clip: ${err.message}`));
    return remember(id, audio);
  } catch (err) {
    logger.warn(`Online voice unavailable (${lang}): ${(err as Error).message}`);
    throw new AppError(503, 'Online voice unavailable.', 'TTS_UNAVAILABLE');
  } finally {
    try {
      tts.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Sound for operators who find reading hard: short tones for success /
 * warning / error, and every instruction spoken in the operator's language.
 *
 * Everything is spoken OFFLINE, from recorded clips that ship with BlendGuard
 * (public/audio/<lang>/, listed in manifest.json; see docs/AUDIO.md):
 *   1. a fixed phrase is one clip ("say.scanNow");
 *   2. a phrase with a number is put together from pieces: "say.pour.0"
 *      ("Pour slowly. You need") + the number ("num.12", "num.point", "num.5")
 *      + "say.pour.1" ("grams.");
 *   3. if a piece is missing, the computer's own voice reads the phrase
 *      (in English when the PC has no voice for the language).
 * Nothing is sent over the internet, so formula quantities stay in the plant.
 */
import { usePrefs } from '@/stores/prefs';
import { translate, type TKey } from './i18n';
import type { Lang } from '@shared/types';

type Cue = 'success' | 'warning' | 'error' | 'tap';

let ctx: AudioContext | null = null;
function audio() {
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

const PATTERNS: Record<Cue, [number, number, OscillatorType][]> = {
  // [frequency Hz, duration ms, wave]
  success: [[660, 110, 'sine'], [990, 160, 'sine']],
  warning: [[520, 160, 'triangle'], [520, 160, 'triangle']],
  error: [[200, 220, 'square'], [160, 300, 'square']],
  tap: [[880, 40, 'sine']],
};

export function cue(kind: Cue) {
  const { sound, volume } = usePrefs.getState();
  if (!sound) return;
  const a = audio();
  if (!a) return;
  let t = a.currentTime;
  const peak = Math.max(0.0001, (volume / 100) * (kind === 'error' ? 0.18 : 0.3));
  for (const [freq, ms, type] of PATTERNS[kind]) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
    t += ms / 1000 + 0.05;
  }
}

// ─────────────────────────── over-weight alarm ───────────────────────────

/** How long the alarm sounds when too much has been poured. */
export const OVER_ALARM_MS = 7500;

let stopCurrentAlarm: (() => void) | null = null;

/**
 * A loud two-tone siren for `ms`: too much was poured (wrong amount added).
 * It is a safety signal, so it sounds even when the station's sound switch is
 * off, and never quieter than 40 % of full volume.
 */
export function alarm(ms = OVER_ALARM_MS) {
  const a = audio();
  if (!a) return;
  stopAlarm();
  stopSpeaking();
  const { volume } = usePrefs.getState();
  const peak = 0.22 * Math.max(0.4, volume / 100);
  const t0 = a.currentTime + 0.02;
  const end = t0 + ms / 1000;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = 'square';
  // High / low every quarter second, in short bursts so it cannot be mistaken for the normal beeps.
  for (let t = t0; t < end; t += 0.5) {
    osc.frequency.setValueAtTime(960, t);
    osc.frequency.setValueAtTime(700, t + 0.25);
    gain.gain.setValueAtTime(peak, t);
    gain.gain.setValueAtTime(peak * 0.15, t + 0.22);
    gain.gain.setValueAtTime(peak, t + 0.25);
    gain.gain.setValueAtTime(peak * 0.15, t + 0.47);
  }
  gain.gain.setValueAtTime(peak, end - 0.05);
  gain.gain.linearRampToValueAtTime(0.0001, end);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(end + 0.02);
  const stop = () => {
    try {
      osc.stop();
    } catch {
      // already stopped
    }
    gain.disconnect();
    if (stopCurrentAlarm === stop) stopCurrentAlarm = null;
  };
  osc.onended = stop;
  stopCurrentAlarm = stop;
}

export function stopAlarm() {
  stopCurrentAlarm?.();
}

const VOICE_LANG: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', ml: 'ml-IN' };

// Chrome / Edge load the voice list late (Edge's online Hindi and Malayalam
// voices later still). Ask early, and let a phrase wait for the list.
let voicesReady: Promise<void> = Promise.resolve();
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  voicesReady = new Promise<void>((resolve) => {
    if (speechSynthesis.getVoices().length) return resolve();
    speechSynthesis.addEventListener?.('voiceschanged', () => resolve(), { once: true });
    setTimeout(resolve, 3000);
  });
}

/** The voice for a language: its exact Indian variant first, then any of that language; `local` = installed on this PC only. */
function voiceFor(lang: Lang, local = false) {
  if (!('speechSynthesis' in window)) return null;
  const want = VOICE_LANG[lang].toLowerCase();
  const voices = speechSynthesis.getVoices().filter((v) => !local || v.localService);
  return voices.find((v) => v.lang.toLowerCase() === want) ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? null;
}

// ─────────────────────────── recorded clips ───────────────────────────

let recorded: Partial<Record<Lang, Set<string>>> = {};
if (typeof window !== 'undefined') {
  void fetch('/audio/manifest.json')
    .then((r) => (r.ok ? r.json() : {}))
    .then((m: Partial<Record<Lang, string[]>>) => {
      recorded = Object.fromEntries(Object.entries(m).map(([l, keys]) => [l, new Set(keys)]));
    })
    .catch(() => {});
}

let clip: HTMLAudioElement | null = null;
/** Pieces of the phrase now playing through Web Audio. */
let scheduled: AudioBufferSourceNode[] = [];
/** Bumped by every new phrase (and by stop), so a phrase still loading is dropped. */
let phraseSeq = 0;

function stopSpeaking() {
  phraseSeq++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (clip) {
    clip.pause();
    clip = null;
  }
  for (const n of scheduled) {
    try {
      n.stop();
    } catch {
      // not started yet / already ended
    }
  }
  scheduled = [];
}

type Vars = Record<string, string | number>;

/** The last instruction spoken, so the REPEAT button can say it again. */
let last: { key: TKey; vars?: Vars } | null = null;
const lastListeners = new Set<() => void>();

export function lastPhrase() {
  return last;
}
export function onLastPhrase(fn: () => void) {
  lastListeners.add(fn);
  return () => void lastListeners.delete(fn);
}

/** Speak a short phrase in the operator's language, from the recorded clips. */
export function say(key: TKey, vars?: Vars) {
  last = { key, vars };
  for (const l of lastListeners) l();
  const { sound, volume, lang } = usePrefs.getState();
  if (!sound) return;
  stopSpeaking();
  const clips = clipsFor(lang, key, vars);
  if (clips) playSequence(clips, volume, () => speak(key, vars, lang, volume));
  else speak(key, vars, lang, volume);
}

// ─────────────────────── phrases put together from pieces ───────────────────────

const has = (lang: Lang, key: string) => !!recorded[lang]?.has(key);
const url = (lang: Lang, key: string) => `/audio/${lang}/${key}.mp3`;

/** 1234 → num.1 num.thousand num.200 num.34 (0–100 and whole hundreds are recorded as single words). */
function wholeNumber(n: number): string[] | null {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000) return null;
  if (n >= 1000) {
    const head = wholeNumber(Math.floor(n / 1000));
    const rest = n % 1000;
    return head && [...head, 'num.thousand', ...(rest ? (wholeNumber(rest) ?? []) : [])];
  }
  if (n <= 100) return [`num.${n}`];
  const hundreds = Math.floor(n / 100) * 100;
  return n % 100 ? [`num.${hundreds}`, `num.${n % 100}`] : [`num.${hundreds}`];
}

/** "12.50" → twelve point five; "250" → two hundred fifty. */
function numberKeys(text: string): string[] | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(spokenGrams(text.trim()));
  if (!m) return null;
  const whole = wholeNumber(Number(m[1]));
  if (!whole) return null;
  return m[2] ? [...whole, 'num.point', ...m[2].split('').map((d) => `num.${d}`)] : whole;
}

/** Rack "B" → letter B; "C2" → letter C, two. */
function codeKeys(text: string): string[] {
  return text
    .toUpperCase()
    .split('')
    .flatMap((c) => (/[A-Z]/.test(c) ? [`chr.${c}`] : /\d/.test(c) ? [`num.${c}`] : []));
}

const MARK = '\u0000';

/** The clip list for a phrase, or null when any piece is missing (then the PC voice reads it). */
function clipsFor(lang: Lang, key: TKey, vars?: Vars): string[] | null {
  const keys = phraseClipKeys(lang, key, vars);
  return keys && keys.every((k) => has(lang, k)) ? keys.map((k) => url(lang, k)) : null;
}

/** The recorded pieces a phrase is made of, in order (null when a value cannot be spoken from clips). */
export function phraseClipKeys(lang: Lang, key: TKey, vars?: Vars): string[] | null {
  if (!vars) return [key];
  // The template with each {var} marked, split into text pieces and variables in order.
  const marked = Object.fromEntries(Object.keys(vars).map((k) => [k, `${MARK}${k}${MARK}`]));
  const parts = translate(lang, key, marked).split(MARK);
  const keys: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Text piece number i/2, recorded as say.<key>.<n> unless it is only punctuation.
      if (!/[\p{L}\p{N}]/u.test(parts[i])) continue;
      keys.push(`${key}.${i / 2}`);
      continue;
    }
    const name = parts[i];
    const value = String(vars[name]);
    if (name === 'name') continue; // a person's name cannot be pre-recorded: "Hello." is said without it
    const k = name === 'rack' ? codeKeys(value) : numberKeys(value);
    if (!k?.length) return null;
    keys.push(...k);
  }
  return keys;
}

// ─────────────────────── gapless playback of the pieces ───────────────────────

/** Silence left at the start / end of a piece after trimming, and the pause between pieces (seconds). */
const LEAD_S = 0.02;
const TAIL_S = 0.04;
const JOIN_S = 0.05;
/** Anything quieter than this (≈ −40 dB) at the ends of a clip counts as silence. */
const SILENCE = 0.01;

/** Each clip is decoded once and kept, ready to play with no loading in between. */
const decoded = new Map<string, Promise<AudioBuffer | null>>();

function loadClip(src: string): Promise<AudioBuffer | null> {
  let p = decoded.get(src);
  if (!p) {
    const a = audio();
    p = !a
      ? Promise.resolve(null)
      : fetch(src)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((bytes) => a.decodeAudioData(bytes))
          .then((buf) => trimSilence(a, buf))
          .catch(() => {
            decoded.delete(src);
            return null;
          });
    decoded.set(src, p);
  }
  return p;
}

/**
 * MP3 clips carry silence at both ends (encoder padding and the voice's own
 * pause). Played one after another that silence adds up to an audible gap in
 * the middle of a phrase, so it is cut down to a short, even margin.
 */
function trimSilence(a: AudioContext, buf: AudioBuffer): AudioBuffer {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const loud = (i: number) => chans.some((d) => Math.abs(d[i]) > SILENCE);
  let first = 0;
  while (first < buf.length && !loud(first)) first++;
  let last = buf.length - 1;
  while (last > first && !loud(last)) last--;
  if (first >= last) return buf;
  const start = Math.max(0, first - Math.round(LEAD_S * buf.sampleRate));
  const end = Math.min(buf.length, last + Math.round(TAIL_S * buf.sampleRate));
  const out = a.createBuffer(buf.numberOfChannels, end - start, buf.sampleRate);
  chans.forEach((d, c) => out.copyToChannel(d.subarray(start, end), c));
  return out;
}

/** Plays the pieces of a phrase as one: all decoded first, then scheduled back to back. */
async function playSequence(srcs: string[], volume: number, onFail: () => void) {
  const a = audio();
  // Web Audio not available or not allowed to play yet: play the files one by one instead.
  if (!a || a.state !== 'running') return playElements(srcs, volume, onFail);
  const seq = phraseSeq;
  const bufs = await Promise.all(srcs.map(loadClip));
  if (seq !== phraseSeq) return; // a newer phrase has started
  if (bufs.some((b) => !b)) return onFail();
  const gain = a.createGain();
  gain.gain.value = volume / 100;
  gain.connect(a.destination);
  let t = a.currentTime + 0.03;
  scheduled = bufs.map((b) => {
    const n = a.createBufferSource();
    n.buffer = b;
    n.connect(gain);
    n.start(t);
    t += b!.duration + JOIN_S;
    return n;
  });
}

/** Fallback: clips played one after another through an <audio> element. */
function playElements(srcs: string[], volume: number, onFail: () => void) {
  const a = new Audio();
  a.volume = volume / 100;
  clip = a;
  let i = 0;
  const failed = () => {
    if (clip === a) {
      clip = null;
      onFail();
    }
  };
  const next = () => {
    if (clip !== a) return;
    if (i >= srcs.length) {
      clip = null;
      return;
    }
    a.src = srcs[i++];
    void a.play().catch((e: unknown) => {
      // A newer phrase stopped this one: nothing to do.
      if ((e as DOMException)?.name !== 'AbortError') failed();
    });
  };
  a.onended = next;
  a.onerror = failed;
  next();
}

const prefetched = new Set<string>();

/** Loads the clips of a phrase that will be spoken soon (the next bottle), so it starts straight away. */
export function prefetchSay(key: TKey, vars?: Vars) {
  const { sound, lang } = usePrefs.getState();
  if (!sound) return;
  for (const src of clipsFor(lang, key, vars) ?? []) {
    if (prefetched.has(src)) continue;
    prefetched.add(src);
    void loadClip(src).then((b) => b || prefetched.delete(src));
  }
}

/** Bumped on every phrase, so a phrase still waiting (for voices, or after a cancel) is dropped when a newer one comes. */
let speakSeq = 0;
/** Held until the phrase ends: Chrome / Edge stop speaking when the utterance object is garbage-collected. */
let utterance: SpeechSynthesisUtterance | null = null;

function speak(key: TKey, vars: Vars | undefined, lang: Lang, volume: number) {
  if (!('speechSynthesis' in window)) return;
  const seq = ++speakSeq;
  // Edge drops a phrase that is queued in the same moment as cancel(); give it a beat when something was playing.
  const busy = speechSynthesis.speaking || speechSynthesis.pending;
  void voicesReady.then(() => setTimeout(() => seq === speakSeq && start(seq, key, vars, lang, volume, false), busy ? 120 : 0));
}

function start(seq: number, key: TKey, vars: Vars | undefined, lang: Lang, volume: number, localOnly: boolean) {
  const own = voiceFor(lang, localOnly);
  const voice = own ?? voiceFor('en', localOnly) ?? voiceFor('en');
  if (!voice) return;
  const u = new SpeechSynthesisUtterance(translate(own ? lang : 'en', key, vars));
  u.voice = voice;
  u.lang = voice.lang;
  u.volume = volume / 100;
  u.rate = 0.9;

  // Online voices (Edge's Hindi / Malayalam) need the internet. If one fails or never starts, say it with a voice on this PC.
  let started = false;
  const fallback = () => {
    if (seq !== speakSeq || localOnly || voice.localService) return;
    speechSynthesis.cancel();
    setTimeout(() => seq === speakSeq && start(seq, key, vars, lang, volume, true), 120);
  };
  u.onstart = () => (started = true);
  u.onerror = (e) => {
    if (e.error !== 'interrupted' && e.error !== 'canceled') fallback();
  };
  u.onend = () => {
    if (utterance === u) utterance = null;
  };
  if (!voice.localService) setTimeout(() => !started && fallback(), 4000);

  utterance = u;
  // Chrome / Edge sometimes leave speech paused after the tab was in the background; a paused queue says nothing.
  speechSynthesis.resume();
  speechSynthesis.speak(u);
}

/** Say the last instruction again (the REPEAT button). */
export function repeatLast() {
  if (last) say(last.key, last.vars);
}

export function feedback(kind: Cue, phrase?: TKey, vars?: Vars) {
  cue(kind);
  if (phrase) setTimeout(() => say(phrase, vars), kind === 'tap' ? 0 : 380);
}

/** "12.50" → "12.5", "3.00" → "3": reads better aloud than the display format. */
export function spokenGrams(text: string) {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

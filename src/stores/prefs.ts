/**
 * Per-screen preferences: language and sound. Kept in this browser only (a
 * convenience — losing it just falls back to the station default).
 */
import { create } from 'zustand';
import type { Lang } from '@shared/types';

interface Prefs {
  lang: Lang;
  /** True once the operator picked a language on this screen; otherwise the station/user default applies. */
  langChosen: boolean;
  sound: boolean;
  volume: number;
  setLang: (l: Lang, chosen?: boolean) => void;
  setSound: (on: boolean) => void;
  setVolume: (v: number) => void;
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`bg.${key}`);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`bg.${key}`, JSON.stringify(value));
  } catch {
    /* private mode etc. */
  }
}

export const usePrefs = create<Prefs>((set) => ({
  // A language this build no longer offers (e.g. an old Kannada choice) falls back to English.
  lang: (['en', 'hi', 'ml'] as string[]).includes(load<string>('lang', 'en')) ? load<Lang>('lang', 'en') : 'en',
  langChosen: false,
  sound: load('sound', true),
  volume: load('volume', 80),
  setLang: (lang, chosen = true) => {
    save('lang', lang);
    document.documentElement.lang = lang;
    set({ lang, langChosen: chosen });
  },
  setSound: (sound) => {
    save('sound', sound);
    set({ sound });
  },
  setVolume: (volume) => {
    save('volume', volume);
    set({ volume });
  },
}));

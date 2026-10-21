/**
 * Barcode scanner support for keyboard-emulating (HID "wedge") USB and
 * Bluetooth scanners, the common kind. A scanner "types" the code very fast
 * and ends with Enter (or Tab); a person typing is much slower. Only fast
 * bursts are treated as scans, so the operator never has to type or focus a box.
 *
 * Details that matter on the floor:
 * - Timing uses the event's own timestamp, so a busy main thread (re-render,
 *   speech) does not split one scan into two.
 * - Once a burst is recognised its keys are swallowed, so a Space or the final
 *   Enter never "clicks" whatever button has focus.
 * - Shift / Caps Lock / other modifier-only key events are ignored; with Caps
 *   Lock on, letters are flipped back so the code keeps its real case.
 * - An AIM symbology prefix (e.g. "]C1", "]E0") and GS separators (ASCII 29,
 *   sent by GS1 labels) are removed.
 * - While a dialog (call supervisor, how-to, sign-off) or the idle screen is
 *   open, scans are swallowed but not used.
 * - Keys typed into a text field are left alone: on the operator screens the
 *   only text fields are supervisor user name / password / note boxes, and a
 *   scan must never be taken from (or typed into) those.
 */
import { useEffect, useRef } from 'react';

/** Longest pause between two characters of one scan. Scanners send one every few ms. */
const MAX_GAP_MS = 50;
/** Some scanners pause a little longer before the terminating Enter / Tab. */
const END_GAP_MS = 100;
const MIN_LENGTH = 4;

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock']);
const GS = '\x1D';

/** Removes an AIM symbology identifier ("]" + letter + modifier) and GS characters. */
export function cleanScan(raw: string) {
  return raw.replace(/^\][A-Za-z][0-9A-Za-z]/, '').replaceAll(GS, '').trim();
}

function isTextField(el: EventTarget | null) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
}

/** A modal (Radix dialog) or the idle "are you still here?" screen is showing. */
function modalOpen() {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]');
}

export function useBarcodeScanner(onScan: (code: string) => void, enabled = true) {
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    let buf = '';
    let last = -Infinity;

    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || MODIFIER_KEYS.has(e.key)) return;
      if (isTextField(e.target)) {
        buf = '';
        return;
      }
      const now = e.timeStamp;
      const gap = now - last;

      if (e.key === 'Enter' || e.key === 'Tab') {
        const code = cleanScan(buf);
        const burst = buf.length > 0 && gap <= END_GAP_MS;
        buf = '';
        last = now;
        if (burst && code.length >= MIN_LENGTH) {
          e.preventDefault();
          e.stopPropagation();
          if (!modalOpen()) cb.current(code);
        }
        return;
      }

      // GS sent as Ctrl+] by some scanners: part of the scan, but not of the code.
      if (e.ctrlKey && !e.altKey && (e.key === ']' || e.key === GS)) {
        if (buf && gap <= MAX_GAP_MS) {
          last = now;
          e.preventDefault();
        }
        return;
      }
      // Other shortcuts and non-character keys (arrows, F-keys) are not part of a scan.
      if (e.key.length !== 1 || ((e.ctrlKey || e.metaKey) && !e.altKey)) {
        buf = '';
        return;
      }

      if (gap > MAX_GAP_MS) buf = '';
      last = now;
      let ch = e.key;
      // Caps Lock flips the case the scanner meant to send; flip it back.
      if (e.getModifierState?.('CapsLock') && ch.toLowerCase() !== ch.toUpperCase()) ch = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
      buf += ch;
      // From the second fast key on this is a scan, not a person: keep it away from focused buttons.
      if (buf.length > 1) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}

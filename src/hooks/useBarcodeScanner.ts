import { useEffect, useRef } from "react";

type EditableEl = HTMLInputElement | HTMLTextAreaElement;

export type BarcodeScannerOptions = {
  enabled?: boolean;
  minLength?: number;       // min chars to accept (default 4)
  maxIntervalMs?: number;   // max gap between chars (default 300ms — tolerant of Bluetooth latency)
  idleMs?: number;          // auto-fire after this silence once a full code is buffered (default 300ms)
};

/**
 * The scan box is identified by `data-scanner-target="true"` on the element.
 * Its value is used as the code source, because Android routes hardware keys
 * through the IME and reports `key: "Unidentified"` / `keyCode: 229` — the
 * keystroke stream is empty even though the characters reached the field.
 */

/**
 * A keyboard-wedge scanner types far faster than a person. These bounds let a
 * burst be recognised as a scan even when focus sits in a field that never
 * opted in — which is exactly what made scanning appear to "do nothing" the
 * moment the cashier tapped Amount received or Customer name.
 *
 * 40ms/char sustained is ~150 WPM, so ordinary typing never trips it.
 */
const SCANNER_MS_PER_CHAR = 40;
const SCANNER_MIN_TOTAL_MS = 250;
const SCANNER_MIN_LENGTH = 6;

/** Restore an input's value through the prototype setter so React's value
 *  tracker sees a change and propagates it into component state. */
const restoreValue = (el: EditableEl, value: string): void => {
  try {
    if (el.value === value) return;
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } catch {
    // Best effort — the field simply keeps whatever it has.
  }
};

const codeToChar = (code: string, shift: boolean): string | null => {
  if (/^Key[A-Z]$/.test(code)) {
    const c = code.slice(3);
    return shift ? c : c.toLowerCase();
  }
  if (/^Digit[0-9]$/.test(code)) {
    const d = code.slice(5);
    if (!shift) return d;
    return ({ "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")" } as Record<string, string>)[d] ?? d;
  }
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (code === "Space") return " ";
  if (code === "Minus") return shift ? "_" : "-";
  if (code === "Equal") return shift ? "+" : "=";
  if (code === "Slash") return shift ? "?" : "/";
  if (code === "Period") return shift ? ">" : ".";
  if (code === "Comma") return shift ? "<" : ",";
  if (code === "Semicolon") return shift ? ":" : ";";
  if (code === "Quote") return shift ? '"' : "'";
  if (code === "BracketLeft") return shift ? "{" : "[";
  if (code === "BracketRight") return shift ? "}" : "]";
  return null;
};

/** Extract the character a keystroke produced, falling back to the physical
 *  key when the IME swallowed it (Android reports "Unidentified"/229). */
const charFromEvent = (e: KeyboardEvent): string | null => {
  if (e.key.length === 1) return e.key;
  if (e.code) {
    const fromCode = codeToChar(e.code, e.shiftKey);
    if (fromCode) return fromCode;
  }
  if (e.keyCode >= 48 && e.keyCode <= 90) {
    const c = String.fromCharCode(e.keyCode);
    return e.shiftKey ? c : c.toLowerCase();
  }
  return null;
};

/**
 * Global barcode scanner listener.
 *
 * USB and Bluetooth barcode scanners act as keyboard "wedges" — they type
 * the scanned characters extremely fast (much faster than a human) and may
 * or may not end with Enter (many budget scanners have no Enter suffix).
 * We detect rapid keystrokes globally:
 *  - chars accumulate while the gap between keys stays within `maxIntervalMs`
 *  - a code is dispatched when it is at least `minLength` chars AND either
 *    an Enter arrives or no key lands within `idleMs` (so scanners without
 *    an Enter suffix still work automatically)
 *
 * Two extra paths keep this working where it used to produce zero feedback:
 *  - focus in a field that never opted in: a burst no person could type still
 *    fires, and everything it wrote into that field is restored first
 *  - focus in the scan box on Android: the code comes from the field's value,
 *    because the keystroke stream arrives as "Unidentified"
 *
 * This works with virtually any keyboard-emulating barcode scanner, no
 * driver, pairing UI, or device permission needed.
 */
export function useBarcodeScanner(
  onScan: (code: string) => void,
  options?: BarcodeScannerOptions
) {
  const enabled = options?.enabled !== false;
  const minLength = options?.minLength ?? 4;
  const maxInterval = options?.maxIntervalMs ?? 300;
  const idleMs = options?.idleMs ?? 300;
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;

    let buffer = "";
    let burstStart = 0;
    let lastTime = 0;
    let lastTarget: EventTarget | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    let scannerInput: HTMLInputElement | null = null;   // opted-in scan box
    let plainField: EditableEl | null = null;           // field we may have to restore
    let scannerStartLen = 0;
    let plainStartLen = 0;
    let restoreTo: string | null = null;

    const clearIdle = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const startBurst = (target: EventTarget | null) => {
      buffer = "";
      scannerInput = null;
      plainField = null;
      scannerStartLen = 0;
      plainStartLen = 0;
      restoreTo = null;

      if (target instanceof HTMLElement) {
        const optedIn = target.dataset?.scannerTarget === "true";
        if (optedIn && target instanceof HTMLInputElement) {
          scannerInput = target;
          scannerStartLen = target.value.length;
        } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          plainField = target;
          plainStartLen = target.value.length;
          restoreTo = target.value;
        }
      }
      lastTarget = target;
    };

    // The field's own value is authoritative: it is right even when the
    // keystroke stream came through as "Unidentified", and in a hijacked field
    // it isolates exactly what the scanner typed this burst.
    const readRaw = (): string => {
      if (scannerInput) return scannerInput.value.slice(scannerStartLen) || buffer;
      if (plainField && restoreTo !== null) return plainField.value.slice(plainStartLen) || buffer;
      return buffer;
    };

    // A code only counts as a scan when the whole burst lands at machine
    // speed. Without this bound an opted-in scan box fired mid-burst on its
    // first few characters, so slow Bluetooth scanners flashed a "Barcode not
    // found" for a truncated code before the full one had even arrived.
    const shouldFire = (raw: string): boolean => {
      const len = raw.length;
      if (len < 1) return false;
      const total = Date.now() - burstStart;
      return (
        len >= Math.max(minLength, SCANNER_MIN_LENGTH) &&
        total <= Math.max(SCANNER_MIN_TOTAL_MS, len * SCANNER_MS_PER_CHAR)
      );
    };

    const doFire = (raw: string) => {
      clearIdle();
      const code = raw.trim();
      const el = plainField;
      const value = restoreTo;
      startBurst(null);
      lastTime = 0;
      // Restore before the callback — it may re-render, and the hijacked field
      // must not keep the characters the scanner injected into it.
      if (el && value !== null) restoreValue(el, value);
      if (code) onScanRef.current(code);
    };

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEnter = e.key === "Enter";

      clearIdle();

      const now = Date.now();
      if (lastTime === 0 || now - lastTime > maxInterval || target !== lastTarget) {
        startBurst(target);
        burstStart = now;
      }
      lastTime = now;

      if (!isEnter) {
        const ch = charFromEvent(e);
        if (ch && ch.length === 1) buffer += ch;
      }

      const raw = readRaw();

      if (isEnter) {
        if (shouldFire(raw)) {
          e.preventDefault();
          doFire(raw);
        }
        // Below the threshold Enter is left alone so it stays usable.
        return;
      }

      // No immediate firing: a code is dispatched only when the burst is
      // complete — on Enter above, or after `idleMs` of silence here. Scanners
      // without an Enter suffix stream the code and go quiet, so the silence
      // window is the completion signal, not the first N characters.
      if (raw.length >= 1) {
        idleTimer = setTimeout(() => {
          idleTimer = null;
          const pending = readRaw();
          if (shouldFire(pending)) doFire(pending);
        }, idleMs);
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => {
      clearIdle();
      window.removeEventListener("keydown", handler, true);
    };
  }, [enabled, minLength, maxInterval, idleMs]);
}

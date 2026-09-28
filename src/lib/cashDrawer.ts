/**
 * Cash drawer (ESC/POS kick) control.
 *
 * The drawer plugs into the receipt printer's RJ11 port, not the PC — the
 * printer turns the ESC/POS `ESC p` pulse into a voltage spike on pin 2 or 5.
 *
 * This is desktop/Electron-only: the browser has no way to drive the printer
 * directly, so every call here is a safe no-op outside the desktop app.
 */

const PIN_KEY = "zampos.drawerPin";
const AUTO_OPEN_KEY = "zampos.drawerAutoOpen";

interface AndroidBridge {
  openCashDrawer?: () => string;
  setDrawerPin?: (pin: number) => void;
  getDrawerPin?: () => number;
}

const bridge = (): AndroidBridge | undefined => {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Android?: AndroidBridge }).Android;
};

/** True when running inside the desktop app (the preload exposes `window.Android`). */
export const isDesktopApp = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.userAgent?.includes("Electron") && !!bridge();

/** escpos only defines CD_KICK_2 and CD_KICK_5 — anything else falls back to 2. */
export const getDrawerPin = (): number => {
  if (typeof window === "undefined") return 2;
  return window.localStorage.getItem(PIN_KEY) === "5" ? 5 : 2;
};

export const setDrawerPin = (pin: number): void => {
  const normalised = pin === 5 ? 5 : 2;
  if (typeof window !== "undefined") window.localStorage.setItem(PIN_KEY, String(normalised));
  bridge()?.setDrawerPin?.(normalised);
};

/** Open the drawer after every cash sale (default: on). */
export const isDrawerAutoOpen = (): boolean =>
  typeof window === "undefined" ? true : window.localStorage.getItem(AUTO_OPEN_KEY) !== "0";

export const setDrawerAutoOpen = (enabled: boolean): void => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(AUTO_OPEN_KEY, enabled ? "1" : "0");
  }
};

/**
 * Kick the drawer now.
 * Returns the raw bridge result ("OK", "ERROR: ...", "SKIP: ..." )
 * so callers can surface a message when the user pressed a test button.
 */
export const openCashDrawer = (): string => {
  const api = bridge();
  if (!api?.openCashDrawer) return "SKIP: cash drawer is only available in the desktop app";

  try {
    api.setDrawerPin?.(getDrawerPin());
    const result = api.openCashDrawer();
    return result || "OK";
  } catch (e) {
    return "ERROR: " + ((e as Error)?.message || String(e));
  }
};

/** Auto-open path: silently does nothing when disabled or unavailable. */
export const openCashDrawerIfEnabled = (): void => {
  if (!isDrawerAutoOpen()) return;
  if (!bridge()?.openCashDrawer) return;
  try {
    openCashDrawer();
  } catch {
    /* never let a drawer fault break a sale */
  }
};

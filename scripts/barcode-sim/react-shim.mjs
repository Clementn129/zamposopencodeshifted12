// Minimal React shim: runs effects immediately and records cleanups so each
// scenario can tear its window listener down before the next one runs.
const cleanups = [];

export function useEffect(fn) {
  const c = fn();
  if (typeof c === 'function') cleanups.push(c);
}

export function useRef(initial) {
  return { current: initial };
}

export function __flushEffects() {
  while (cleanups.length) {
    const c = cleanups.pop();
    try {
      c();
    } catch {
      /* ignore */
    }
  }
}

export default { useEffect, useRef };

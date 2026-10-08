// Barcode-scanner simulation harness.
// Imports the REAL hook and drives it with synthetic keyboard-wedge events.
//
// A hardware scanner behaves like a very fast keyboard that types the code and
// (usually) ends with Enter. It may deliver the whole code twice. The browser
// fires `keydown` first, then inserts the character into the focused input — so
// this harness reproduces that exact order.
import { useBarcodeScanner } from '../../src/hooks/useBarcodeScanner.ts';
import { __flushEffects } from './react-shim.mjs';

/* ------------------------------ DOM shim ------------------------------ */
class ShimEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {}
}
class ShimKeyboardEvent extends ShimEvent {
  constructor(type, opts = {}) {
    super(type, opts);
    this.key = opts.key ?? '';
    this.code = opts.code ?? '';
    this.shiftKey = !!opts.shiftKey;
    this.keyCode = opts.keyCode ?? 0;
    this.target = opts.target ?? null;
  }
}
class ShimHTMLElement {
  constructor() {
    this.dataset = {};
    this.isContentEditable = false;
    this.tagName = 'DIV';
    this._listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatchEvent(ev) {
    for (const fn of this._listeners.get(ev.type) ?? []) fn(ev);
    return true;
  }
  closest() {
    return null;
  }
}
class ShimHTMLInputElement extends ShimHTMLElement {
  constructor() {
    super();
    this.tagName = 'INPUT';
    this._value = '';
  }
  get value() {
    return this._value;
  }
  set value(v) {
    this._value = String(v);
  }
}
class ShimHTMLTextAreaElement extends ShimHTMLInputElement {
  constructor() {
    super();
    this.tagName = 'TEXTAREA';
  }
}

const windowListeners = new Map();
globalThis.window = {
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  },
  removeEventListener(type, fn) {
    const arr = windowListeners.get(type) ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
};
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
};
globalThis.HTMLElement = ShimHTMLElement;
globalThis.HTMLInputElement = ShimHTMLInputElement;
globalThis.HTMLTextAreaElement = ShimHTMLTextAreaElement;
globalThis.Event = ShimEvent;
globalThis.KeyboardEvent = ShimKeyboardEvent;

/* ------------------------------ helpers ------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fireKey(target, key) {
  const ev = new ShimKeyboardEvent('keydown', { key, code: key === 'Enter' ? 'Enter' : '', target, bubbles: true });
  for (const fn of windowListeners.get('keydown') ?? []) fn(ev);
}

// Browser order: keydown fires first, then the char lands in the field.
function pressChar(target, ch) {
  fireKey(target, ch);
  target.value = target.value + ch;
}

async function type(target, text, gapMs) {
  for (const ch of text) {
    pressChar(target, ch);
    if (gapMs) await sleep(gapMs);
  }
}

function makeScannerBox() {
  const el = new ShimHTMLInputElement();
  el.dataset.scannerTarget = 'true';
  return el;
}

/* --------------------------- scenario runner --------------------------- */
let pass = 0;
let fail = 0;
const assert = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` -> ${extra}` : ''}`);
  }
};

async function run(name, fn) {
  console.log(`\n${name}`);
  __flushEffects();
  await fn();
  __flushEffects();
}

// Scans use a short idle window so the test stays quick; production default is 300ms.
const OPTS = { enabled: true, idleMs: 120 };

/* ------------------------------ scenarios ------------------------------ */
// 1. The bug report: a fast scan must reach the cart and clear the search box.
await run('1) Fast scan into the scan box (no Enter) -> adds once, box cleared', async () => {
  const box = makeScannerBox();
  const scans = [];
  useBarcodeScanner((c) => scans.push(c), OPTS);
  await type(box, '54491472', 4);
  await sleep(200);
  assert('onScan fired exactly once', scans.length === 1, `got ${scans.length}`);
  assert('code is the full barcode', scans[0] === '54491472', `got ${JSON.stringify(scans[0])}`);
  assert('search box was cleared', box.value === '', `left "${box.value}"`);
});

// 2. A scanner that sends an Enter suffix fires immediately.
await run('2) Fast scan with Enter suffix -> adds once', async () => {
  const box = makeScannerBox();
  const scans = [];
  useBarcodeScanner((c) => scans.push(c), OPTS);
  await type(box, '6009644546626', 4);
  fireKey(box, 'Enter');
  await sleep(40);
  assert('onScan fired exactly once', scans.length === 1, `got ${scans.length}`);
  assert('code is correct', scans[0] === '6009644546626', `got ${scans[0]}`);
  assert('search box was cleared', box.value === '', `left "${box.value}"`);
});

// 3. The double-entry bug: a scanner/IME that delivers the code twice.
await run('3) Double-delivery (CODE CODE, no Enter) -> one fire, one code', async () => {
  const box = makeScannerBox();
  const scans = [];
  useBarcodeScanner((c) => scans.push(c), OPTS);
  await type(box, '5449147254491472', 4);
  await sleep(200);
  assert('onScan fired exactly once (doubled buffer collapsed)', scans.length === 1, `got ${scans.length}`);
  assert('code collapsed to a single barcode', scans[0] === '54491472', `got ${JSON.stringify(scans[0])}`);
  assert('search box cleared', box.value === '', `left "${box.value}"`);
});

// 4. Two deliberate scans => two fires (the app increments quantity).
await run('4) Two deliberate scans -> two fires (quantity increments)', async () => {
  const box = makeScannerBox();
  const scans = [];
  useBarcodeScanner((c) => scans.push(c), OPTS);
  await type(box, '54491472', 4);
  fireKey(box, 'Enter');
  await sleep(60);
  await type(box, '54491472', 4);
  fireKey(box, 'Enter');
  await sleep(60);
  assert('onScan fired twice', scans.length === 2, `got ${scans.length}`);
  assert('both codes correct', scans[0] === '54491472' && scans[1] === '54491472', JSON.stringify(scans));
  assert('search box empty after both', box.value === '', `left "${box.value}"`);
});

// 5. A human slowly typing a search term must NOT be hijacked or wiped.
await run('5) Human typing a search term (slow) -> no scan, text preserved', async () => {
  const box = makeScannerBox();
  const scans = [];
  useBarcodeScanner((c) => scans.push(c), OPTS);
  await type(box, '54491472', 200);
  await sleep(200);
  assert('onScan never fired', scans.length === 0, `got ${scans.length}`);
  assert('search text preserved', box.value === '54491472', `left "${box.value}"`);
});

// 6. Ordinary slow typing in a non-scan field is untouched.
await run('6) Human typing in a normal field (e.g. Amount received) -> no scan', async () => {
  const amount = new ShimHTMLInputElement();
  amount.value = '5';
  const scans = [];
  useBarcodeScanner((c) => scans.push(c), OPTS);
  await type(amount, '123456', 200);
  await sleep(200);
  assert('onScan never fired', scans.length === 0, `got ${scans.length}`);
  assert('field keeps what was typed', amount.value === '5123456', `left "${amount.value}"`);
});

// 7. A fast burst in a normal field is recognised as a scan and the field restored.
await run('7) Fast burst in a normal field -> fires and restores the field', async () => {
  const amount = new ShimHTMLInputElement();
  amount.value = '5';
  const scans = [];
  useBarcodeScanner((c) => scans.push(c), { enabled: true, idleMs: 300 });
  await type(amount, '123456', 3);
  fireKey(amount, 'Enter');
  await sleep(40);
  assert('onScan fired once', scans.length === 1, `got ${scans.length}`);
  assert('captured the typed code', scans[0] === '123456', `got ${scans[0]}`);
  assert('field restored to its prior value', amount.value === '5', `left "${amount.value}"`);
});

/* -------------------------------- result -------------------------------- */
console.log(`\n========================================`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`========================================`);
process.exit(fail === 0 ? 0 : 1);

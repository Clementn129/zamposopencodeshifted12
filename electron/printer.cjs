let escpos, USB;
try {
  escpos = require("escpos");
  USB = require("escpos-usb");
} catch (e) {
  console.error("ESC/POS modules not available:", e.message);
}

let currentPrinter = null;
let connected = false;

function findAndConnect() {
  if (!escpos || !USB) return { ok: false, error: "ESC/POS library not installed" };
  try {
    const device = new USB();
    currentPrinter = new escpos.Printer(device);
    connected = true;
    return { ok: true };
  } catch (e) {
    connected = false;
    return { ok: false, error: e.message || "No USB printer found" };
  }
}

function connectTcp(host, port) {
  if (!escpos) return { ok: false, error: "ESC/POS library not installed" };
  try {
    const device = new escpos.Network(host, port || 9100);
    currentPrinter = new escpos.Printer(device);
    connected = true;
    return { ok: true };
  } catch (e) {
    connected = false;
    return { ok: false, error: e.message };
  }
}

/**
 * Kick the cash drawer via ESC/POS `ESC p`.
 * The drawer must be wired to the printer's RJ11 port — never to the PC.
 * escpos only defines CD_KICK_2 and CD_KICK_5, so any other pin falls back to 2.
 */
function openCashDrawer(pin) {
  return new Promise((resolve) => {
    if (!escpos) return resolve({ ok: false, error: "ESC/POS library not installed" });

    if (!currentPrinter || !connected) {
      const conn = findAndConnect();
      if (!conn.ok) return resolve({ ok: false, error: conn.error });
    }

    try {
      currentPrinter.cashdraw(pin === 5 ? 5 : 2);
      currentPrinter.flush((err) => {
        if (err) resolve({ ok: false, error: err.message || String(err) });
        else resolve({ ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e) });
    }
  });
}

function disconnect() {
  try {
    if (currentPrinter && typeof currentPrinter.close === "function") {
      currentPrinter.close();
    }
  } catch (e) { /* ignore */ }
  currentPrinter = null;
  connected = false;
}

function isConnected() {
  return connected && currentPrinter !== null;
}

function parseAndPrint(text, paperWidthMm) {
  return new Promise((resolve, reject) => {
    if (!currentPrinter) return reject(new Error("No printer connected"));

    const p = currentPrinter;
    const lines = text.split("\n");

    for (const line of lines) {
      let align = "LT";
      if (line.startsWith("[C]")) align = "CT";
      else if (line.startsWith("[R]")) align = "RT";
      p.align(align);

      let content = line.replace(/^\[[CLR]\]/, "");

      const boldOn = /<b>/.test(content);
      const fontBig = /<font size='big'>/.test(content);
      const fontTall = /<font size='tall'>/.test(content);
      const fontSmall = /<font size='small'>/.test(content);

      content = content
        .replace(/<\/?b>/g, "")
        .replace(/<\/?font[^>]*>/g, "");

      if (boldOn) p.bold();
      if (fontBig) p.size(2, 2);
      else if (fontTall) p.size(1, 2);
      else if (fontSmall) p.size(0.5, 0.5);

      p.text(content);

      if (boldOn) p.bold(false);
      if (fontBig || fontTall || fontSmall) p.size(1, 1);
    }

    p.cut();
    p.flush((err) => {
      if (err) reject(err);
      else resolve({ ok: true });
    });
  });
}

module.exports = {
  findAndConnect,
  connectTcp,
  disconnect,
  isConnected,
  parseAndPrint,
  openCashDrawer,
};

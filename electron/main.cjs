const { app, BrowserWindow, Menu, ipcMain, protocol, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const licence = require("./licence.cjs");
const activation = require("./activation.cjs");
const secrets = require("./secrets.cjs");

const isDev = process.env.ELECTRON_DEV === "1";
const isWin = process.platform === "win32";
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let mainWindow = null;
let printer = null;
let connectionType = "usb";
let paperWidthMm = 80;
let drawerPin = 2;
let dataDir = "";

function ensureWritableDir(candidate) {
  try {
    fs.mkdirSync(candidate, { recursive: true });
    fs.accessSync(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// The app's Chromium profile, IndexedDB and offline cache live here. Keeping
// this outside AppData makes it easy for the client (and us) to back up.
function resolveDataDir() {
  const candidates = [];
  try {
    const documents = app.getPath("documents");
    const documentsResolved = path.resolve(documents).toLowerCase();
    const oneDriveRoots = [
      process.env.OneDrive,
      process.env.OneDriveConsumer,
      process.env.OneDriveCommercial,
    ]
      .filter(Boolean)
      .map((p) => path.resolve(p).toLowerCase());
    const oneDriveRedirected = oneDriveRoots.some(
      (root) => documentsResolved === root || documentsResolved.startsWith(root + path.sep),
    );
    if (oneDriveRedirected) {
      candidates.push(path.join(process.env.SystemDrive || "C:", path.sep, "Sale Point Data"));
    }
    candidates.push(path.join(documents, "Sale Point Data"));
  } catch {
    // fall through to home directory
  }
  try {
    candidates.push(path.join(app.getPath("home"), "Sale Point Data"));
  } catch {
    // last resort below
  }
  candidates.push(path.join(app.getPath("temp"), "Sale Point Data"));

  for (const candidate of candidates) {
    if (ensureWritableDir(candidate)) return candidate;
  }
  return path.join(app.getPath("temp"), "Sale Point Data");
}

dataDir = resolveDataDir();
app.setPath("userData", dataDir);
licence.configure(dataDir);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

if (isWin) app.setAppUserModelId("com.salepoint.pos");

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".map": "application/json; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
    }[ext] || "application/octet-stream"
  );
}

function registerAppProtocol() {
  const distRoot = path.join(app.getAppPath(), "dist");
  protocol.handle("app", (request) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!pathname || pathname === "/") pathname = "/index.html";

    let filePath = path.normalize(path.join(distRoot, pathname));
    if (filePath !== distRoot && !filePath.startsWith(distRoot + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distRoot, "index.html");
    }
    try {
      const body = fs.readFileSync(filePath);
      return new Response(body, {
        headers: {
          "content-type": mimeFor(filePath),
          "cache-control": "no-cache",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function getPrinter() {
  if (!printer) {
    try {
      printer = require("./printer.cjs");
    } catch (e) {
      console.error("Printer module load failed:", e.message);
      return null;
    }
  }
  return printer;
}

function setupPrinterIPC() {
  ipcMain.on("printer-connect-usb", (event) => {
    const p = getPrinter();
    if (!p) { event.returnValue = "ERROR: Printer module not available"; return; }
    const result = p.findAndConnect();
    if (result.ok) connectionType = "usb";
    event.returnValue = result.ok ? "OK" : "ERROR: " + result.error;
  });

  ipcMain.on("printer-connect-bluetooth", (event) => {
    const p = getPrinter();
    if (!p) { event.returnValue = "ERROR: Printer module not available"; return; }
    const result = p.findAndConnect();
    if (result.ok) connectionType = "bluetooth";
    event.returnValue = result.ok ? "OK" : "ERROR: " + result.error;
  });

  ipcMain.on("printer-connect-tcp", (event, host, port) => {
    const p = getPrinter();
    if (!p) { event.returnValue = "ERROR: Printer module not available"; return; }
    const result = p.connectTcp(host, port);
    if (result.ok) connectionType = "tcp";
    event.returnValue = result.ok ? "OK" : "ERROR: " + result.error;
  });

  ipcMain.on("printer-disconnect", (event) => {
    const p = getPrinter();
    if (p) p.disconnect();
    event.returnValue = "OK";
  });

  ipcMain.on("printer-is-connected", (event) => {
    const p = getPrinter();
    event.returnValue = p ? p.isConnected() : false;
  });

  ipcMain.on("printer-print", (event, text, paperWidth) => {
    const p = getPrinter();
    if (!p) { event.returnValue = "ERROR: Printer module not available"; return; }
    if (!p.isConnected()) {
      const result = p.findAndConnect();
      if (!result.ok) { event.returnValue = "ERROR: " + result.error; return; }
      connectionType = "usb";
    }
    p.parseAndPrint(text, paperWidth || paperWidthMm)
      .then(() => { event.returnValue = "OK"; })
      .catch((e) => { event.returnValue = "ERROR: " + e.message; });
  });

  ipcMain.on("printer-list-usb", (event) => {
    event.returnValue = JSON.stringify([]);
  });

  ipcMain.on("printer-drawer-open", (event) => {
    const p = getPrinter();
    if (!p) { event.returnValue = "ERROR: Printer module not available"; return; }
    if (!p.isConnected()) {
      const result = p.findAndConnect();
      if (!result.ok) { event.returnValue = "ERROR: " + result.error; return; }
      connectionType = "usb";
    }
    p.openCashDrawer(drawerPin)
      .then((r) => { event.returnValue = r.ok ? "OK" : "ERROR: " + r.error; })
      .catch((e) => { event.returnValue = "ERROR: " + e.message; });
  });

  ipcMain.on("printer-set-drawer-pin", (event, pin) => {
    drawerPin = Number(pin) === 5 ? 5 : 2;
    event.returnValue = "OK";
  });

  ipcMain.on("printer-get-drawer-pin", (event) => {
    event.returnValue = drawerPin;
  });

  ipcMain.on("printer-set-paper-width", (event, width) => {
    paperWidthMm = width;
    event.returnValue = "OK";
  });

  ipcMain.on("printer-get-paper-width", (event) => {
    event.returnValue = paperWidthMm;
  });

  ipcMain.on("printer-get-connection-type", (event) => {
    event.returnValue = connectionType;
  });

  ipcMain.on("printer-set-connection-type", (event, type) => {
    connectionType = type;
    event.returnValue = "OK";
  });
}

function verifyOwnerPassword(password, stored) {
  try {
    const [scheme, iterationsRaw, saltHex, hashHex] = String(stored || "").split("$");
    if (scheme !== "pbkdf2" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const candidate = crypto.pbkdf2Sync(
      String(password),
      Buffer.from(saltHex, "hex"),
      Number(iterationsRaw) || 100000,
      expected.length,
      "sha256",
    );
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function setupAppIPC() {
  ipcMain.handle("data-dir-get", () => dataDir);
  ipcMain.handle("data-dir-open", async () => {
    const error = await shell.openPath(dataDir);
    return { ok: !error, error: error || null };
  });

  ipcMain.handle("activation-unseal", (_event, buffer, pin) => {
    try {
      const payload = activation.unseal(buffer, pin);
      const { syncPassword: _syncPassword, licence: _licence, ...safePayload } = payload;
      return { ok: true, payload: safePayload };
    } catch (e) {
      return { ok: false, error: e.message || "Activation file could not be opened." };
    }
  });

  ipcMain.handle("activation-commit", (_event, buffer, pin, password) => {
    try {
      const payload = activation.unseal(buffer, pin);
      if (!verifyOwnerPassword(password, payload.owner?.passwordHash)) {
        return { ok: false, error: "The owner password does not match this activation file." };
      }
      if (!payload.licence) {
        return { ok: false, error: "The activation file has no licence." };
      }
      let licenceStatus;
      try {
        licenceStatus = licence.importToken(payload.licence);
      } catch (e) {
        return { ok: false, error: `Licence could not be installed: ${e.message}` };
      }
      const secretSaved = payload.syncPassword
        ? secrets.save(payload.owner.email, payload.syncPassword)
        : false;
      const { syncPassword: _syncPassword, licence: _licence, ...safePayload } = payload;
      return { ok: true, payload: safePayload, secretSaved, licenceStatus };
    } catch (e) {
      return { ok: false, error: e.message || "Activation failed." };
    }
  });

  ipcMain.handle("licence-status", () => licence.status());
  ipcMain.handle("licence-token", () => licence.currentToken());
  ipcMain.handle("licence-import", (_event, token) => {
    try {
      return { ok: true, status: licence.importToken(token).status };
    } catch (e) {
      return { ok: false, error: e.message || "Licence import failed." };
    }
  });

  ipcMain.handle("activation-secret-get", () => secrets.get());
  ipcMain.handle("activation-secret-clear", () => ({ ok: secrets.clear() }));

  ipcMain.handle("update-check", async () => {
    if (isDev || !app.isPackaged) return { ok: false, error: "Updates are disabled in development." };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, version: result?.updateInfo?.version || null };
    } catch (e) {
      return { ok: false, error: e.message || "Update check failed." };
    }
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Open Data Folder",
            click: () => shell.openPath(dataDir),
          },
          ...(app.isPackaged
            ? [
                {
                  label: "Check for Updates",
                  click: () => {
                    autoUpdater.checkForUpdates().catch(() => {});
                  },
                },
              ]
            : []),
          { type: "separator" },
          { role: "quit", label: "Exit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function createWindow() {
  const iconPath = path.join(app.getAppPath(), "dist", "icon-512.png");
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: "Sale Point",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isDev && /^http:\/\/localhost:8080/.test(url)) return;
    if (url.startsWith("app://bundle/")) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:8080");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL("app://bundle/pos");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    if (mainWindow) mainWindow.webContents.send("update-available", info);
  });
  autoUpdater.on("update-not-available", () => {
    if (mainWindow) mainWindow.webContents.send("update-not-available");
  });
  autoUpdater.on("download-progress", (progress) => {
    if (mainWindow) mainWindow.webContents.send("update-download-progress", progress);
  });
  autoUpdater.on("update-downloaded", () => {
    if (mainWindow) mainWindow.webContents.send("update-downloaded");
  });
  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err?.message || err);
  });

  if (isDev || !app.isPackaged) return;
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 30 * 1000);
  setInterval(check, UPDATE_INTERVAL_MS);
}

app.whenReady().then(() => {
  registerAppProtocol();
  setupPrinterIPC();
  setupAppIPC();
  buildMenu();
  setupAutoUpdater();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (printer) {
    try { printer.disconnect(); } catch { /* ignore */ }
  }
  app.quit();
});

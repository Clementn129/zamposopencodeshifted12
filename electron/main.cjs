const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");

const isDev = process.env.ELECTRON_DEV === "1";
const isWin = process.platform === "win32";

let mainWindow = null;
let printer = null;
let connectionType = "usb";
let paperWidthMm = 80;
let drawerPin = 2;

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: "ZamPOS",
    icon: path.join(__dirname, "..", "public", "icon-512.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:8080");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL("https://zampos.mwilaclement129.workers.dev/");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        isWin
          ? { role: "quit", label: "Exit" }
          : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ])
);

autoUpdater.autoDownload = false;
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
  console.error("Auto-updater error:", err);
});

app.whenReady().then(() => {
  setupPrinterIPC();
  createWindow();

  if (!isDev) {
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (printer) {
    try { printer.disconnect(); } catch (e) { /* ignore */ }
  }
  if (!isWin) app.quit();
});

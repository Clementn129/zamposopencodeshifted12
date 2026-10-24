const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onUpdateAvailable: (callback) => {
    ipcRenderer.on("update-available", (_event, info) => callback(info));
  },
  onUpdateNotAvailable: (callback) => {
    ipcRenderer.on("update-not-available", () => callback());
  },
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on("update-download-progress", (_event, progress) => callback(progress));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on("update-downloaded", () => callback());
  },
  checkForUpdates: () => ipcRenderer.invoke("update-check"),
  dataDir: {
    get: () => ipcRenderer.invoke("data-dir-get"),
    open: () => ipcRenderer.invoke("data-dir-open"),
  },
  activation: {
    unseal: (buffer, pin) => ipcRenderer.invoke("activation-unseal", buffer, pin),
    commit: (buffer, pin, password) => ipcRenderer.invoke("activation-commit", buffer, pin, password),
  },
  licence: {
    status: () => ipcRenderer.invoke("licence-status"),
    current: () => ipcRenderer.invoke("licence-token"),
    import: (token) => ipcRenderer.invoke("licence-import", token),
  },
  secrets: {
    get: () => ipcRenderer.invoke("activation-secret-get"),
    clear: () => ipcRenderer.invoke("activation-secret-clear"),
  },
});

contextBridge.exposeInMainWorld("Android", {
  connectBluetooth: () => {
    return ipcRenderer.sendSync("printer-connect-bluetooth");
  },
  connectUsb: () => {
    return ipcRenderer.sendSync("printer-connect-usb");
  },
  connectTcp: (host, port) => {
    return ipcRenderer.sendSync("printer-connect-tcp", host, port);
  },
  disconnect: () => {
    return ipcRenderer.sendSync("printer-disconnect");
  },
  isConnected: () => {
    return ipcRenderer.sendSync("printer-is-connected");
  },
  print: (text, paperWidth) => {
    return ipcRenderer.sendSync("printer-print", text, paperWidth || 80);
  },
  printRaw: (text) => {
    return ipcRenderer.sendSync("printer-print", text, 80);
  },
  printAndCut: (text) => {
    return ipcRenderer.sendSync("printer-print", text, 80);
  },
  getPairedPrinters: () => {
    return ipcRenderer.sendSync("printer-list-usb");
  },
  getUsbPrinters: () => {
    return ipcRenderer.sendSync("printer-list-usb");
  },
  setPaperWidth: (width) => {
    ipcRenderer.sendSync("printer-set-paper-width", width);
  },
  getPaperWidth: () => {
    return ipcRenderer.sendSync("printer-get-paper-width");
  },
  openCashDrawer: () => {
    return ipcRenderer.sendSync("printer-drawer-open");
  },
  setDrawerPin: (pin) => {
    ipcRenderer.sendSync("printer-set-drawer-pin", pin);
  },
  getDrawerPin: () => {
    return ipcRenderer.sendSync("printer-get-drawer-pin");
  },
  getConnectionType: () => {
    return ipcRenderer.sendSync("printer-get-connection-type");
  },
  setConnectionType: (type) => {
    return ipcRenderer.sendSync("printer-set-connection-type", type);
  },
  openAppSettings: () => {},
});

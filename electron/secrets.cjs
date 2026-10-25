// Stores the one-time sync password using the OS credential vault (DPAPI on
// Windows) through Electron safeStorage. It is only kept until the first
// successful online sign-in, then the renderer clears it.
const fs = require("fs");
const path = require("path");

let electron = null;

function api() {
  if (!electron) electron = require("electron");
  return electron;
}

function secretPath() {
  return path.join(api().app.getPath("userData"), "activation", "secret.json");
}

function save(email, password) {
  try {
    const { safeStorage } = api();
    if (!safeStorage.isEncryptionAvailable()) return false;
    const encrypted = safeStorage.encryptString(JSON.stringify({ email, password }));
    const file = secretPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encrypted.toString("base64"), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function get() {
  try {
    const { safeStorage } = api();
    if (!safeStorage.isEncryptionAvailable()) return null;
    const raw = fs.readFileSync(secretPath(), "utf8");
    const decrypted = safeStorage.decryptString(Buffer.from(raw, "base64"));
    const parsed = JSON.parse(decrypted);
    if (!parsed?.email || !parsed?.password) return null;
    return { email: parsed.email, password: parsed.password };
  } catch {
    return null;
  }
}

function clear() {
  try {
    fs.rmSync(secretPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { save, get, clear };

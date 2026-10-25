// Offline licence verification (Ed25519).
//
// Tokens look like:  SP1.<base64url(payload json)>.<base64url(signature)>
// The payload is signed by scripts/issue-licence.mjs with the private key that
// never ships. The public key below is the only trust anchor the app needs.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, "licence-public.pem"), "utf8");
const TOKEN_PREFIX = "SP1";
const DAY_MS = 24 * 60 * 60 * 1000;

let dataRoot = null;

const fromBase64Url = (value) =>
  Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");

const toBase64Url = (buffer) =>
  Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function verifyToken(token) {
  if (typeof token !== "string" || token.trim().length < 20) {
    throw new Error("Licence key is empty or malformed.");
  }
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw new Error("Not a Sale Point licence key.");
  }
  const [, payloadPart, signaturePart] = parts;
  const ok = crypto.verify(
    null,
    Buffer.from(payloadPart, "utf8"),
    PUBLIC_KEY,
    fromBase64Url(signaturePart),
  );
  if (!ok) throw new Error("Licence signature is invalid.");

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadPart).toString("utf8"));
  } catch {
    throw new Error("Licence payload is unreadable.");
  }
  if (!payload || payload.v !== 1) throw new Error("Unsupported licence version.");
  if (!payload.bid || !payload.exp) throw new Error("Licence is missing required fields.");
  if (Number.isNaN(Date.parse(payload.exp))) throw new Error("Licence expiry date is invalid.");
  return payload;
}

function configure(dir) {
  dataRoot = dir;
  fs.mkdirSync(path.join(dir, "licence"), { recursive: true });
  fs.mkdirSync(path.join(dir, "activation"), { recursive: true });
}

function tokenPath() {
  if (!dataRoot) throw new Error("Licence store is not configured.");
  return path.join(dataRoot, "licence", "token.txt");
}

function clockPath() {
  if (!dataRoot) throw new Error("Licence store is not configured.");
  return path.join(dataRoot, "licence", "clock.json");
}

function readClock() {
  try {
    const raw = fs.readFileSync(clockPath(), "utf8");
    const parsed = JSON.parse(raw);
    const lastSeen = Number(parsed?.lastSeen);
    return Number.isFinite(lastSeen) ? lastSeen : 0;
  } catch {
    return 0;
  }
}

// Monotonic clock: remember the latest wall-clock value we have ever observed.
// Rolling the PC clock backwards can therefore never extend a licence.
function tickClock() {
  const real = Date.now();
  const stored = readClock();
  const rollbackDetected = stored > 0 && real + 5 * 60 * 1000 < stored;
  const effective = Math.max(real, stored);
  try {
    fs.writeFileSync(
      clockPath(),
      JSON.stringify({ lastSeen: effective, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // A read-only data folder must not crash the app; verification still works.
  }
  return { effective, rollbackDetected };
}

function currentToken() {
  try {
    return fs.readFileSync(tokenPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function status() {
  if (!dataRoot) {
    return { valid: false, error: "Licence store is not configured." };
  }
  const tick = tickClock();
  const token = currentToken();
  if (!token) {
    return {
      valid: false,
      error: "No offline licence installed.",
      rollbackDetected: tick.rollbackDetected,
    };
  }
  try {
    const payload = verifyToken(token);
    const expiresMs = Date.parse(payload.exp);
    const daysRemaining = Math.max(0, Math.ceil((expiresMs - tick.effective) / DAY_MS));
    return {
      valid: expiresMs > tick.effective,
      expired: expiresMs <= tick.effective,
      businessId: payload.bid,
      businessCode: payload.bcode || null,
      plan: payload.plan || null,
      issuedAt: payload.iat || null,
      expiresAt: payload.exp,
      daysRemaining,
      rollbackDetected: tick.rollbackDetected,
    };
  } catch (e) {
    return {
      valid: false,
      error: e.message || "Licence could not be verified.",
      rollbackDetected: tick.rollbackDetected,
    };
  }
}

function importToken(token) {
  const payload = verifyToken(token);
  fs.writeFileSync(tokenPath(), token.trim(), "utf8");
  return { status: status(), payload };
}

module.exports = {
  configure,
  verifyToken,
  toBase64Url,
  status,
  importToken,
  currentToken,
};

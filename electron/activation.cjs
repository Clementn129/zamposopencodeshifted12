// Activation bundle unsealing (zero-network provisioning).
//
// A .spact file is AES-256-GCM ciphertext keyed by a short PIN (scrypt). The
// plaintext carries the payload plus an Ed25519 signature made by the private
// signing key, so even someone who learns the PIN cannot edit the licence or
// business snapshot.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, "licence-public.pem"), "utf8");
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const toBuffer = (input) => {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === "string") return Buffer.from(input, "utf8");
  throw new Error("Activation file could not be read.");
};

const deriveKey = (pin, salt) =>
  crypto.scryptSync(String(pin), salt, 32, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });

function unseal(input, pin) {
  if (!pin || String(pin).trim().length < 4) {
    throw new Error("Enter the activation PIN.");
  }

  let envelope;
  try {
    envelope = JSON.parse(toBuffer(input).toString("utf8"));
  } catch {
    throw new Error("This is not a Sale Point activation file.");
  }
  if (!envelope || envelope.v !== 1 || envelope.alg !== "aes-256-gcm") {
    throw new Error("Unsupported activation file version.");
  }

  const salt = Buffer.from(envelope.kdf?.salt || "", "base64");
  const iv = Buffer.from(envelope.iv || "", "base64");
  const tag = Buffer.from(envelope.tag || "", "base64");
  const data = Buffer.from(envelope.data || "", "base64");
  if (!salt.length || !iv.length || !tag.length || !data.length) {
    throw new Error("Activation file is incomplete.");
  }

  const key = deriveKey(String(pin).trim(), salt);
  let plain;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new Error("Wrong activation PIN.");
  }

  let signed;
  try {
    signed = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error("Activation payload is unreadable.");
  }
  if (!signed?.payloadB64 || !signed?.sig) {
    throw new Error("Activation payload is incomplete.");
  }
  const ok = crypto.verify(
    null,
    Buffer.from(signed.payloadB64, "utf8"),
    PUBLIC_KEY,
    Buffer.from(signed.sig, "base64"),
  );
  if (!ok) throw new Error("Activation file signature is invalid.");

  let payload;
  try {
    payload = JSON.parse(Buffer.from(signed.payloadB64, "base64").toString("utf8"));
  } catch {
    throw new Error("Activation payload is unreadable.");
  }
  if (!payload || payload.kind !== "activation" || payload.v !== 1) {
    throw new Error("This file is not an activation bundle.");
  }
  if (!payload.business?.id || !payload.owner?.email || !payload.owner?.passwordHash) {
    throw new Error("Activation bundle is missing business or owner details.");
  }
  return payload;
}

function seal(payload, payloadB64, signatureB64, pin) {
  if (!pin || String(pin).trim().length < 4) throw new Error("PIN must be at least 4 characters.");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(String(pin).trim(), salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify({ payloadB64, sig: signatureB64 }), "utf8");
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "aes-256-gcm",
    kdf: {
      name: "scrypt",
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      salt: salt.toString("base64"),
    },
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };
}

module.exports = { unseal, seal };

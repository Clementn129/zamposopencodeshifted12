// One-time Ed25519 keypair generation for offline licence/activation signing.
// The private key stays in scripts/.secrets (gitignored); the public key is
// shipped inside the Electron app so it can verify tokens offline.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secretDir = path.join(root, "scripts", ".secrets");
const privatePath = path.join(secretDir, "licence-private.pem");
const publicPath = path.join(root, "electron", "licence-public.pem");

if (existsSync(privatePath) && !process.argv.includes("--force")) {
  console.log(`Private key already exists at ${privatePath}`);
  console.log("Refusing to overwrite an existing signing key. Pass --force only if you understand the impact.");
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });

mkdirSync(secretDir, { recursive: true });
writeFileSync(privatePath, privatePem, { mode: 0o600 });
writeFileSync(publicPath, publicPem);

console.log(`Private key: ${privatePath}`);
console.log(`Public key:  ${publicPath}`);
console.log("Back up the private key somewhere safe. Losing it means you cannot issue renewals.");

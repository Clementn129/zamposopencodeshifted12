// Issue a signed offline licence token.
//
// Usage:
//   node scripts/issue-licence.mjs --business-id <uuid> --code POS-XXXXXX \
//     --expires 2026-11-14T19:04:32.413Z --plan "1 cashier" --out licence.splic
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createPrivateKey, sign } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { toBase64Url } = require(path.join(root, "electron", "licence.cjs"));

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith("--")) continue;
  const value = process.argv[i + 1];
  if (value && !value.startsWith("--")) {
    args[key.slice(2)] = value;
    i += 1;
  } else {
    args[key.slice(2)] = true;
  }
}

if (!args["business-id"] || !args.code || !args.expires) {
  console.error("Required: --business-id <uuid> --code <POS-CODE> --expires <ISO date>");
  process.exit(1);
}
const expiresMs = Date.parse(args.expires);
if (Number.isNaN(expiresMs)) {
  console.error(`Invalid --expires date: ${args.expires}`);
  process.exit(1);
}
if (expiresMs <= Date.now()) {
  console.error("Refusing to issue an already-expired licence.");
  process.exit(1);
}

const privateKey = createPrivateKey(
  readFileSync(path.join(root, "scripts", ".secrets", "licence-private.pem"), "utf8"),
);

const payload = {
  v: 1,
  bid: args["business-id"],
  bcode: args.code,
  plan: args.plan || null,
  iat: new Date().toISOString(),
  exp: new Date(expiresMs).toISOString(),
};
const payloadPart = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
const signature = sign(null, Buffer.from(payloadPart, "utf8"), privateKey);
const token = `SP1.${payloadPart}.${toBase64Url(signature)}`;

if (args.out) {
  const out = path.resolve(process.cwd(), args.out);
  writeFileSync(out, token, "utf8");
  console.log(`Wrote ${out}`);
}
console.log(JSON.stringify(payload, null, 2));
console.log(token);

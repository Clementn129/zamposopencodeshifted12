// Build a zero-network activation bundle for one business.
//
// Usage (PowerShell):
//   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."
//   node scripts/make-activation-bundle.mjs `
//     --business-id c64a17dc-867e-4b13-86b6-905db4fe029c `
//     --pin 4821 --password "farmfront" `
//     --out-dir "Farm Front Offline Installer"
//
// Requires the private signing key created by scripts/licence-keygen.mjs.
// The service-role key is fetched at runtime and never written to disk.
import { createRequire } from "node:module";
import { createPrivateKey, pbkdf2Sync, randomBytes, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { toBase64Url, verifyToken } = require(path.join(root, "electron", "licence.cjs"));
const { seal, unseal } = require(path.join(root, "electron", "activation.cjs"));

const PROJECT_REF = "gglhrfogvwnrgyvlixjq";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const MANAGEMENT_URL = `https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`;

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

const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

if (!args["business-id"]) fail("--business-id is required");
if (!args.pin || String(args.pin).trim().length < 4) fail("--pin must be at least 4 characters");
if (!args.password) fail("--password is required");

const privateKey = createPrivateKey(
  readFileSync(path.join(root, "scripts", ".secrets", "licence-private.pem"), "utf8"),
);

async function resolveServiceKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) {
    fail("Set SUPABASE_ACCESS_TOKEN (Management API) or SUPABASE_SERVICE_ROLE_KEY.");
  }
  const res = await fetch(MANAGEMENT_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) fail(`Could not reveal API keys (${res.status} ${res.statusText}).`);
  const keys = await res.json();
  const entry = (Array.isArray(keys) ? keys : []).find(
    (k) =>
      k?.name === "service_role" ||
      k?.type === "service_role" ||
      k?.id === "service_role" ||
      String(k?.name || "").includes("service_role"),
  );
  const key = entry?.api_key || entry?.key || entry?.secret;
  if (!key) fail("service_role key not found in the Management API response.");
  return key;
}

async function rest(serviceKey, table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    fail(`${table} request failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function adminUser(serviceKey, userId) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    fail(`Owner lookup failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

function hashOwnerPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const iterations = 100000;
  const derived = pbkdf2Sync(password, Buffer.from(salt, "hex"), iterations, 32, "sha256").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${derived}`;
}

const serviceKey = await resolveServiceKey();
const businessId = args["business-id"];
const [business] = await rest(serviceKey, "businesses", `id=eq.${businessId}&select=*`);
if (!business) fail(`Business ${businessId} was not found.`);

const expiryRaw = args.expires || business.subscription_expires_at;
const expiryMs = Date.parse(expiryRaw);
if (Number.isNaN(expiryMs)) fail("No valid subscription expiry found; pass --expires <ISO date>.");
if (expiryMs <= Date.now()) {
  fail(`Subscription expiry ${new Date(expiryMs).toISOString()} is in the past. Pass --expires.`);
}
const expiresAt = new Date(expiryMs).toISOString();

const productsBusinessId = args["products-business-id"] || businessId;
const products = await rest(
  serviceKey,
  "products",
  `business_id=eq.${productsBusinessId}&select=*&order=created_at.asc`,
);
if (products.length === 0 && !args["allow-empty"]) {
  fail(
    `No products found for business ${productsBusinessId}. Use --products-business-id <root id> or --allow-empty.`,
  );
}

const owner = await adminUser(serviceKey, business.user_id);
if (!owner?.email) fail("Owner account has no email address.");

const plan = args.plan || business.plan_tier || null;
const nowIso = new Date().toISOString();
const ownerNewPassword = String(args.password);

const licencePayload = {
  v: 1,
  bid: business.id,
  bcode: business.payment_code,
  plan,
  iat: nowIso,
  exp: expiresAt,
};
const licencePart = toBase64Url(Buffer.from(JSON.stringify(licencePayload), "utf8"));
const licenceSig = sign(null, Buffer.from(licencePart, "utf8"), privateKey);
const licenceToken = `SP1.${licencePart}.${toBase64Url(licenceSig)}`;

const activationPayload = {
  kind: "activation",
  v: 1,
  issuedAt: nowIso,
  business: {
    id: business.id,
    name: business.name,
    code: business.payment_code,
    phone: business.phone,
    email: business.email,
    address: business.address,
    taxMode: business.tax_mode || "none",
    vatRate: Number(business.vat_rate ?? 16),
    customTaxName: business.custom_tax_name,
    customTaxRate: business.custom_tax_rate,
    tpin: business.tpin,
    logoUrl: business.logo_url,
    vatNumber: business.vat_number,
    businessType: business.business_type,
    subscriptionStatus: business.subscription_status,
    subscriptionExpiresAt: expiresAt,
  },
  subscription: {
    status: business.subscription_status,
    expiresAt,
    plan,
  },
  products: products.map((p) => ({
    id: p.id,
    name: p.name,
    price: Number(p.price) || 0,
    stock: Number(p.stock) || 0,
    category: p.category ?? null,
    barcode: p.barcode ?? null,
    sku: p.sku ?? null,
    imageUrl: p.image_url ?? null,
    costPrice: p.cost_price != null ? Number(p.cost_price) : null,
    reorderLevel: p.minimum_stock != null ? Number(p.minimum_stock) : null,
    isActive: p.is_active !== false,
    branchId: p.branch_id ?? null,
    expiryDate: p.expiry_date ?? null,
  })),
  owner: {
    userId: owner.id,
    email: owner.email,
    passwordHash: hashOwnerPassword(ownerNewPassword),
    role: "owner",
    lastOnlineLogin: owner.last_sign_in_at || nowIso,
  },
  licence: licenceToken,
  syncPassword: ownerNewPassword,
};

const activationPart = toBase64Url(Buffer.from(JSON.stringify(activationPayload), "utf8"));
const activationSig = sign(null, Buffer.from(activationPart), privateKey).toString("base64");
const envelope = seal(activationPayload, activationPart, activationSig, String(args.pin).trim());

// Self-check before writing anything the client will receive.
verifyToken(licenceToken);
const checked = unseal(JSON.stringify(envelope), String(args.pin).trim());
if (checked.business?.id !== business.id) fail("Self-check failed: activation payload mismatch.");

const outDir = path.resolve(process.cwd(), args["out-dir"] || "Farm Front Offline Installer");
mkdirSync(outDir, { recursive: true });
const slug =
  args.name ||
  business.payment_code?.toLowerCase() ||
  business.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const bundlePath = path.join(outDir, `activation-${slug}.spact`);
const licencePath = path.join(outDir, `licence-${slug}.splic`);
const summaryPath = path.join(outDir, `activation-${slug}.json`);

writeFileSync(bundlePath, JSON.stringify(envelope), "utf8");
writeFileSync(licencePath, licenceToken, "utf8");
writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      business: { id: business.id, name: business.name, code: business.payment_code },
      owner: owner.email,
      plan,
      products: products.length,
      licence: { expiresAt, days: Math.ceil((expiryMs - Date.now()) / 86400000) },
      activationFile: path.basename(bundlePath),
      issuedAt: nowIso,
    },
    null,
    2,
  ),
  "utf8",
);

console.log("Activation bundle created:");
console.log(`  Business: ${business.name} (${business.payment_code})`);
console.log(`  Owner:    ${owner.email}`);
console.log(`  Products: ${products.length}`);
console.log(`  Licence:  ${expiresAt} (${plan || "no plan label"})`);
console.log(`  Bundle:   ${bundlePath}`);
console.log(`  Licence:  ${licencePath}`);
console.log(`  Summary:  ${summaryPath}`);

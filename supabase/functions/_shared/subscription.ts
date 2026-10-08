import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Sandbox by default; set LENCO_BASE_URL=https://api.lenco.co/access/v2 when live.
const LENCO_BASE_URL = Deno.env.get("LENCO_BASE_URL") ?? "https://sandbox.lenco.co/access/v2";
const LENCO_SECRET_KEY = Deno.env.get("LENCO_SECRET_KEY")!;

// Mirror of src/lib/paymentDetails.ts PRICING_TIERS — the server is the source
// of truth for what a renewal costs so a client cannot underpay.
const PRICING_TIERS = [
  { minCashiers: 0, maxCashiers: 1, priceZmw: 200, label: "1 cashier" },
  { minCashiers: 2, maxCashiers: 3, priceZmw: 350, label: "2 – 3 cashiers" },
  { minCashiers: 4, maxCashiers: 4, priceZmw: 500, label: "4 cashiers" },
  { minCashiers: 5, maxCashiers: null, priceZmw: 0, label: "5+ cashiers (custom)" },
];

function resolveTier(activeCashiers: number, planLabel?: string | null) {
  if (planLabel) {
    const byLabel = PRICING_TIERS.find((t) => t.label === planLabel);
    if (byLabel) return byLabel;
  }
  const n = Math.max(0, Math.floor(activeCashiers || 0));
  return (
    PRICING_TIERS.find(
      (t) => n >= t.minCashiers && (t.maxCashiers === null || n <= t.maxCashiers),
    ) ?? PRICING_TIERS[0]
  );
}

type VerifyArgs = {
  reference: string;
  businessId: string;
  months: number;
  callerId: string;
};

export async function verifyAndExtendSubscription({ reference, businessId, months, callerId }: VerifyArgs) {
  if (!reference || !/^[A-Za-z0-9._-]{4,100}$/.test(reference)) throw new Error("Invalid payment reference");
  if (!Number.isInteger(months) || months < 1 || months > 24) throw new Error("Invalid months");

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // 1. The caller must own the business they are renewing.
  const { data: biz, error: bizErr } = await admin
    .from("businesses")
    .select("id, payment_code, subscription_expires_at, subscription_status, plan_tier, monthly_price_zmw")
    .eq("id", businessId)
    .eq("user_id", callerId)
    .maybeSingle();
  if (bizErr) throw new Error(bizErr.message);
  if (!biz) throw new Error("Business not found for this account");

  // 2. Price is computed server-side. A locked price (grandfathered) always
  // wins; otherwise derive it from the business's own cashier count / plan.
  const { count: activeCashiers, error: cErr } = await admin
    .from("business_cashiers")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("is_active", true);
  if (cErr) throw new Error(cErr.message);

  const lockedPrice =
    biz.monthly_price_zmw !== null && biz.monthly_price_zmw !== undefined
      ? Number(biz.monthly_price_zmw)
      : null;
  let monthlyPrice: number;
  let planLabel: string;
  if (lockedPrice !== null && Number.isFinite(lockedPrice)) {
    monthlyPrice = lockedPrice;
    planLabel = "locked-in price";
  } else {
    const tier = resolveTier(activeCashiers ?? 0, biz.plan_tier);
    monthlyPrice = tier.priceZmw;
    planLabel = tier.label;
  }
  if (monthlyPrice <= 0) throw new Error("Custom pricing plan — renew via WhatsApp");
  const expectedAmount = monthlyPrice * months;

  // 3. Verify the payment with Lenco using our secret key (never the browser).
  const res = await fetch(
    `${LENCO_BASE_URL}/collections/status/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${LENCO_SECRET_KEY}` } },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.status) {
    throw new Error(body?.message || `Lenco verification failed (HTTP ${res.status})`);
  }

  const payment = body.data;
  const paidStatus = String(payment?.status ?? "").toLowerCase();
  if (paidStatus !== "successful") {
    if (paidStatus === "pending" || paidStatus === "pay-offline" || paidStatus === "processing") {
      throw new Error("Payment is still pending confirmation — your subscription will update automatically once it clears. Please don't pay again.");
    }
    throw new Error(`Payment not completed (status: ${payment?.status || "unknown"})`);
  }
  if (String(payment?.currency ?? "").toUpperCase() !== "ZMW") throw new Error("Payment currency mismatch");
  if (Number(payment?.amount ?? 0) < expectedAmount) {
    throw new Error(`Paid amount ZMW ${payment?.amount} is below the required ZMW ${expectedAmount}`);
  }

  const now = new Date();

  // 4. Claim the reference BEFORE extending. lenco_reference is unique, so this
  //    insert is what makes every reference single-use — Lenco reports
  //    "successful" forever, and without this a paid reference could be
  //    replayed to extend the subscription over and over.
  const { error: claimErr } = await admin.from("payments").insert({
    business_id: businessId,
    amount: expectedAmount,
    status: "approved",
    approved_at: now.toISOString(),
    lenco_reference: reference,
    notes: `Lenco ${reference} — ${months} month(s) subscription renewal (${planLabel})`,
  });
  if (claimErr) {
    if (claimErr.code === "23505") throw new Error("This payment reference has already been used");
    throw new Error(`Could not record payment: ${claimErr.message}`);
  }

  // 5. Extend from the later of now or the current expiry.
  const currentExpiry = biz.subscription_expires_at ? new Date(biz.subscription_expires_at) : null;
  const startPoint = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const newExpiry = new Date(startPoint);
  newExpiry.setMonth(newExpiry.getMonth() + months);

  const { error: uErr } = await admin
    .from("businesses")
    .update({
      subscription_status: "active",
      subscription_expires_at: newExpiry.toISOString(),
      is_locked: false,
      updated_at: new Date().toISOString(),
      // Freeze this client's price on their first successful payment: only
      // written while still unlocked, so later renewals keep what they paid.
      ...(lockedPrice === null ? { monthly_price_zmw: monthlyPrice } : {}),
    })
    .eq("id", businessId);
  if (uErr) {
    // Nothing was extended — release the claim so the same reference can be
    // verified again (transient failure), instead of burning a paid reference.
    await admin.from("payments").delete().eq("lenco_reference", reference);
    throw new Error(uErr.message);
  }

  // The claim insert above doubles as the admin-visible record (approved =
  // counted as revenue in the admin dashboard).

  return {
    success: true,
    newExpiry: newExpiry.toISOString(),
    months,
    amount: expectedAmount,
    lencoReference: payment?.lencoReference ?? null,
  };
}

export const PAYMENT_DETAILS = {
  whatsappNumberE164: "260976621936",
  whatsappDisplay: "+260 976 621 936",
  momo: {
    mtn: {
      network: "MTN",
      number: "0763165781",
      name: "Clement Mwila",
    },
    airtel: {
      network: "Airtel",
      number: "0572540590",
      name: "Clement Mwila",
    },
  },
  pricePerMonthZmw: 200, // lowest tier (1 cashier) — kept for legacy admin calcs
  trialDays: 3,
} as const;

export type PricingTier = {
  /** Inclusive lower bound on active cashier count */
  minCashiers: number;
  /** Inclusive upper bound; null means "and above" */
  maxCashiers: number | null;
  /** Monthly price in ZMW */
  priceZmw: number;
  /** Short label for UI */
  label: string;
};

export const PRICING_TIERS: PricingTier[] = [
  { minCashiers: 0, maxCashiers: 1, priceZmw: 200, label: "1 cashier" },
  { minCashiers: 2, maxCashiers: 3, priceZmw: 350, label: "2 – 3 cashiers" },
  { minCashiers: 4, maxCashiers: 4, priceZmw: 500, label: "4 cashiers" },
  { minCashiers: 5, maxCashiers: null, priceZmw: 0, label: "5+ cashiers (custom)" },
];

export const getPricingTier = (activeCashiers: number): PricingTier => {
  const n = Math.max(0, Math.floor(activeCashiers || 0));
  return (
    PRICING_TIERS.find(
      (t) => n >= t.minCashiers && (t.maxCashiers === null || n <= t.maxCashiers),
    ) ?? PRICING_TIERS[0]
  );
};

/** Look up a tier by its display label (e.g. set by a super admin). */
export const getPricingTierByLabel = (label?: string | null): PricingTier | null => {
  if (!label) return null;
  return PRICING_TIERS.find((t) => t.label === label) ?? null;
};

/**
 * Resolve the effective tier for a business. An admin-assigned plan label always
 * wins; otherwise we derive the tier from the active cashier count.
 */
export const resolvePricingTier = (
  activeCashiers: number,
  adminPlanLabel?: string | null,
): PricingTier =>
  getPricingTierByLabel(adminPlanLabel) ?? getPricingTier(activeCashiers);

export const getMonthlyPriceForCashiers = (activeCashiers: number): number =>
  getPricingTier(activeCashiers).priceZmw;

export interface ResolvedMonthlyPrice {
  /** Effective monthly price in ZMW. */
  priceZmw: number;
  /** Short label for receipts/notes. */
  label: string;
  /** True when the price is 0/negotiated (5+ cashiers or a locked custom deal). */
  isCustom: boolean;
  /** True when the price came from the business's grandfathered lock. */
  locked: boolean;
}

/**
 * Resolve what a business actually pays per month. A locked price (set on its
 * first successful payment, or backfilled by migration) always wins; otherwise
 * fall back to the admin plan label / active cashier count.
 */
export const resolveMonthlyPrice = ({
  lockedPriceZmw,
  adminPlanLabel,
  activeCashiers,
}: {
  lockedPriceZmw?: number | null;
  adminPlanLabel?: string | null;
  activeCashiers: number;
}): ResolvedMonthlyPrice => {
  const locked = lockedPriceZmw !== null && lockedPriceZmw !== undefined ? Number(lockedPriceZmw) : null;
  if (locked !== null && Number.isFinite(locked)) {
    return { priceZmw: locked, label: "Locked-in price", isCustom: locked <= 0, locked: true };
  }
  const tier = resolvePricingTier(activeCashiers, adminPlanLabel);
  return { priceZmw: tier.priceZmw, label: tier.label, isCustom: tier.priceZmw <= 0, locked: false };
};


export const buildWhatsAppPaymentLink = (args: {
  paymentCode: string;
  amountZmw: number;
  userEmail?: string;
}) => {
  const { paymentCode, amountZmw, userEmail } = args;

  const message = [
    "Hello, I want to renew my Sale Point subscription.",
    "",
    `Reference / Payment Code: ${paymentCode}`,
    userEmail ? `User: ${userEmail}` : undefined,
    "",
    `I have sent payment of ZMW ${amountZmw}.`,
    "Please find the screenshot attached.",
  ]
    .filter(Boolean)
    .join("\n");

  const encoded = encodeURIComponent(message);
  return `https://wa.me/${PAYMENT_DETAILS.whatsappNumberE164}?text=${encoded}`;
};

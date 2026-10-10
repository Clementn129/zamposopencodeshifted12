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

/**
 * Lenco charges a flat, banded fee to pay money OUT of their platform to a
 * mobile-money wallet (https://lenco.co/zm/pricing). When a client renews
 * online we pass that cost on so the withdrawal fee doesn't eat the payment.
 * Bands: ≤K1,000 → K12; ≤K50,000 → K15; above → K35.
 */
export const LENCO_SERVICE_FEE_TIERS = [
  { maxAmountZmw: 1000, feeZmw: 12 },
  { maxAmountZmw: 50_000, feeZmw: 15 },
  { maxAmountZmw: Infinity, feeZmw: 35 },
] as const;

/** Flat service fee (ZMW) added to an online renewal of the given amount. */
export const getLencoServiceFee = (amountZmw: number): number => {
  if (!Number.isFinite(amountZmw) || amountZmw <= 0) return 0;
  const tier = LENCO_SERVICE_FEE_TIERS.find((t) => amountZmw <= t.maxAmountZmw);
  return tier ? tier.feeZmw : LENCO_SERVICE_FEE_TIERS[LENCO_SERVICE_FEE_TIERS.length - 1].feeZmw;
};

/**
 * What the client is actually charged online: the subscription plus the flat
 * service fee, grossed up so Lenco's 1% collection cut is covered too.
 * e.g. K200 → (200 + 12) / 0.99 = K215.
 */
export const getLencoOnlineTotal = (amountZmw: number): number => {
  const fee = getLencoServiceFee(amountZmw);
  if (fee === 0) return amountZmw;
  return Math.ceil((amountZmw + fee) / 0.99);
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

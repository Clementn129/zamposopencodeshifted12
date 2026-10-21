// Single source of truth for per-line sale math.
//
// POS checkout writes `finalSalePrice` onto every item: the per-unit price
// actually charged after line + global discounts (`Pos.tsx:663`), and keeps
// `price` as the pre-discount unit price. `subtotal` on a sale is the sum of
// gross line totals (`price * quantity`); the discount lives on the line and
// in `discount_amount`.
//
// When `finalSalePrice` is missing (legacy sales synced before it existed)
// we fall back to `price` — identical to how Reports already reads items.

export type SaleItemMath = {
  price?: number | string | null;
  finalSalePrice?: number | string | null;
  quantity?: number | string | null;
  costPrice?: number | string | null;
  lineTotal?: number | string | null;
};

const empty = (item: SaleItemMath | null | undefined) => item ?? {};

export const lineQty = (item: SaleItemMath | null | undefined): number => {
  const q = Number(empty(item).quantity);
  return Number.isFinite(q) && q > 0 ? q : 0;
};

// Unit price actually charged (discount-apportioned), falling back to gross.
export const linePrice = (item: SaleItemMath | null | undefined): number => {
  const fsp = empty(item).finalSalePrice;
  if (fsp !== null && fsp !== undefined && !Number.isNaN(Number(fsp))) {
    return Number(fsp);
  }
  const p = Number(empty(item).price);
  return Number.isFinite(p) ? p : 0;
};

// Gross pre-discount unit price, used for `subtotal` semantics.
export const lineGrossPrice = (item: SaleItemMath | null | undefined): number => {
  const p = Number(empty(item).price);
  return Number.isFinite(p) ? p : 0;
};

// Amount actually charged for this line (discount already applied per unit).
export const lineAmount = (item: SaleItemMath | null | undefined): number =>
  linePrice(item) * lineQty(item);

// Gross amount for this line (before discount) — `subtotal` semantics.
export const lineGrossAmount = (item: SaleItemMath | null | undefined): number =>
  lineGrossPrice(item) * lineQty(item);

export const lineCost = (item: SaleItemMath | null | undefined): number => {
  const c = Number(empty(item).costPrice);
  return (Number.isFinite(c) ? c : 0) * lineQty(item);
};

// Discount-aware revenue for a line. If the item carries a `finalSalePrice`
// (modern POS), the apportioned discount is already baked into the unit price
// and we return it directly. Legacy items fall back to the old apportionment
// against the sale-level discount so old history stays consistent.
export const lineRevenue = (
  item: SaleItemMath | null | undefined,
  saleSubtotal = 0,
  saleDiscount = 0,
): number => {
  const fsp = empty(item).finalSalePrice;
  if (fsp !== null && fsp !== undefined && !Number.isNaN(Number(fsp))) {
    return Number(fsp) * lineQty(item);
  }
  const gross = lineGrossAmount(item);
  const share = saleSubtotal > 0 ? (gross / saleSubtotal) * (Number(saleDiscount) || 0) : 0;
  return gross - share;
};

export type SaleTotalsMath = {
  subtotal: number; // Σ gross line totals (pre-discount)
  discountAmount: number; // Σ (gross − charged) per line
  net: number; // Σ charged line amounts (discount applied)
};

export const saleTotals = (items: SaleItemMath[] | null | undefined): SaleTotalsMath => {
  const list = Array.isArray(items) ? items : [];
  const gross = list.reduce((s, i) => s + lineGrossAmount(i), 0);
  const net = list.reduce((s, i) => s + lineAmount(i), 0);
  return {
    subtotal: Math.round(gross * 100) / 100,
    discountAmount: Math.round((gross - net) * 100) / 100,
    net: Math.round(net * 100) / 100,
  };
};

// ---------------------------------------------------------------------------
// Profit — ONE definition, shared by Reports and Sales History so the two pages
// can never disagree again.
//
//   grossProfit = revenue − tax − cogs
//   netProfit   = grossProfit − businessExpenses − ownerDrawings
//
// * `revenue` is TAX-INCLUSIVE (prices are entered incl. VAT); `tax` is the
//   extracted portion owed onward, so it is removed from profit.
// * `cogs` is the cost of the goods sold (from the sale-line cost snapshot).
// * Owner drawings are a distribution of profit, not an operating expense —
//   they are subtracted here so "net profit" reflects what the business
//   actually retained, matching the Sales History view.
// ---------------------------------------------------------------------------
export type ProfitInputs = {
  revenue: number;
  tax: number;
  cogs: number;
  businessExpenses?: number;
  ownerDrawings?: number;
};

export type ProfitResult = {
  grossProfit: number;
  netProfit: number;
};

export const computeProfit = ({
  revenue,
  tax,
  cogs,
  businessExpenses = 0,
  ownerDrawings = 0,
}: ProfitInputs): ProfitResult => {
  const grossProfit = (Number(revenue) || 0) - (Number(tax) || 0) - (Number(cogs) || 0);
  const netProfit = grossProfit - (Number(businessExpenses) || 0) - (Number(ownerDrawings) || 0);
  return { grossProfit, netProfit };
};
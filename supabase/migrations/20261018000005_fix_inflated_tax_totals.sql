-- =====================================================
-- fix_inflated_tax_totals — repair totals double-counted by calc_backfill
--
-- `20261018000002_calc_backfill.sql` wrote `total = net + tax_amount`, but the
-- POS model stores `total` as the tax-INCLUSIVE amount the customer pays
-- (`subtotal − discount_amount`), with `tax_amount` merely the portion extracted
-- from it (see src/lib/tax.ts). For the handful of sales that carry tax this
-- added the tax a second time, e.g. subtotal 405 -> total 460.86 (+55.86).
--
-- Evidence: every affected row has `amount_paid = subtotal − discount_amount`
-- (the amount actually collected, which backfill did not touch) while its
-- `total` sits one tax_amount higher.
--
-- Repair: set `total` back to the tax-inclusive charged amount. Guarded so only
-- the exact inflated pattern is touched, and ONLY when the recorded payment
-- confirms the inclusive figure — legitimate rows are untouched.
-- =====================================================

UPDATE public.sales
   SET total = ROUND(subtotal - discount_amount, 2)
 WHERE COALESCE(tax_amount, 0) > 0
   AND COALESCE(total, 0) > (subtotal - discount_amount) + 0.01
   AND ABS(COALESCE(total, 0) - (subtotal - discount_amount + tax_amount)) <= 0.01
   AND ABS(COALESCE(amount_paid, 0) - (subtotal - discount_amount)) <= 0.01;

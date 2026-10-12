-- =====================================================
-- Backfill: count existing untracked products
--
-- Historically, quick-added products (and some imported ones) were created
-- with track_stock = false, so they were sold without ever changing any stock
-- number and silently bypassed the prevent-negative-stock toggle. Now that
-- quick-add creates counted products, bring the existing backlog in line too.
--
-- Dishes (is_dish) and services stay intentionally untracked / unlimited:
--   * a dish's ingredients carry the stock, never the dish itself;
--   * a service has no stock.
--
-- Only flips the flag; no stock value is changed, so the negative-stock
-- trigger is a no-op here.
-- =====================================================

UPDATE public.products
   SET track_stock = true
 WHERE track_stock IS NOT TRUE
   AND COALESCE(is_dish, false) = false
   AND item_type <> 'service';

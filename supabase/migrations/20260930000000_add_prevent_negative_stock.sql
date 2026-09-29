-- Dynamic Sales: per-business negative-stock policy.
--
--   true  (DEFAULT) = block/refuse sales that would drive stock below zero.
--                     Preserves today's behaviour for every existing business.
--   false           = allow inventory to go negative (Aronium-style).
--                     Opt-in only, set from Settings > Inventory.
--
-- Additive column with a DEFAULT, so no existing row is rewritten and no
-- client can observe a change until the code that reads it ships.
BEGIN;

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS prevent_negative_stock BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.businesses.prevent_negative_stock
  IS 'true = keep stock at or above zero (block oversells). false = allow negative inventory.';

COMMIT;

-- =====================================================
-- Negative-stock backstop trigger
--
-- The pricing/costing RPCs (`sync_offline_sale`, `deduct_delivery_note_stock`,
-- `adjust_product_stock`) already floor deductions with GREATEST(..., 0) when
-- `businesses.prevent_negative_stock` is true, and subtract plainly when it is
-- false. But any OTHER write to `products.stock` — an edge function, an admin
-- script, a future code path, or a manual SQL correction — could still drive a
-- product below zero for a business that has negative stock disabled.
--
-- This trigger closes that gap at the table level:
--
--   prevent_negative_stock = true  -> a write that would take stock from a
--                                     non-negative value to a negative one is
--                                     rejected (ERRCODE check_violation).
--   prevent_negative_stock = false -> unchanged: negatives are permitted.
--
-- Safety / additive guarantees:
--   * Fires only when the NEW value is negative, so every existing
--     GREATEST-floored RPC remains a no-op.
--   * Never touches a row that is ALREADY negative (OLD.stock < 0), so the
--     handful of pre-existing negative rows stay editable and are not
--     rewritten. New negatives are what get blocked.
--   * Fail-closed: a missing business row resolves to `true`.
--   * Service lines are exempt (mirrors the RPCs, which never deduct them).
-- =====================================================

CREATE OR REPLACE FUNCTION public.enforce_negative_stock_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prevent boolean;
BEGIN
  -- Nothing to enforce unless this write creates a negative balance.
  IF NEW.stock IS NULL OR NEW.stock >= 0 THEN
    RETURN NEW;
  END IF;

  -- Leave already-negative rows alone (pre-existing data / corrections).
  IF TG_OP = 'UPDATE' AND OLD.stock IS NOT NULL AND OLD.stock < 0 THEN
    RETURN NEW;
  END IF;

  -- Services are never stock-deducted, so they are exempt from the policy.
  IF COALESCE(NEW.item_type, 'product') = 'service' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(b.prevent_negative_stock, true)
    INTO v_prevent
    FROM public.businesses b
   WHERE b.id = NEW.business_id;

  IF COALESCE(v_prevent, true) THEN
    RAISE EXCEPTION 'Stock for "%" cannot go below zero (negative stock is disabled for this business)', NEW.name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER on_products_before_negative_stock
    BEFORE INSERT OR UPDATE ON public.products
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_negative_stock_policy();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

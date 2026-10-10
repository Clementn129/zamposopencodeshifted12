-- =====================================================
-- Isolation hotfix (Phase 0)
--
-- Three SECURITY DEFINER RPCs were callable by ANY role (Postgres default
-- grants EXECUTE to PUBLIC, which includes `anon`) and performed cross-tenant
-- writes without validating the caller's membership:
--
--   * deduct_delivery_note_stock(p_dn_id)          -> writes products.stock
--   * recompute_dish_cost(p_product_id DEFAULT NULL) -> writes products.cost_price
--                                                     (NULL = EVERY business's dishes)
--   * adjust_ingredients_for_sale(p_business_id, …)  -> writes ingredients.stock
--                                                     and the movement ledger
--
-- Any authenticated (or even anonymous) caller who knew a UUID could corrupt
-- another tenant's stock. Each function now (re)validates that the caller
-- belongs to the affected business, and EXECUTE is locked down to the
-- `authenticated` / `service_role` roles only.
--
-- Callers that matter are all user-driven (sale insert/delete triggers,
-- delivery-note creation, recipe/ingredient edits) so `auth.uid()` is always
-- the acting member; `is_business_member` is therefore the correct boundary.
-- =====================================================

-- ---------------------------------------------------------------------------
-- 1. deduct_delivery_note_stock(p_dn_id)
--    Body otherwise identical to 20261003000000_offline_replay_idempotency.sql.
-- =====================================================
CREATE OR REPLACE FUNCTION public.deduct_delivery_note_stock(p_dn_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  DECLARE
    v_biz uuid;
    v_item record;
    v_prevent_neg boolean := true;
    v_already boolean := false;
  BEGIN
    SELECT business_id, COALESCE(stock_deducted, false)
      INTO v_biz, v_already
      FROM public.delivery_notes
     WHERE id = p_dn_id
     FOR UPDATE;

    IF v_biz IS NULL THEN
      RETURN;
    END IF;

    -- Only a member of the owning business may move its stock.
    IF NOT public.is_business_member(v_biz) THEN
      RAISE EXCEPTION 'not authorized';
    END IF;

    -- Idempotent: a repeat call (e.g. replay or the delivered trigger firing
    -- after completion) must not move stock a second time.
    IF v_already THEN
      RETURN;
    END IF;

    SELECT COALESCE(b.prevent_negative_stock, true)
      INTO v_prevent_neg
      FROM public.businesses b
     WHERE b.id = v_biz;

    FOR v_item IN
      SELECT dni.product_id, dni.quantity
        FROM public.delivery_note_items dni
       WHERE dni.delivery_note_id = p_dn_id
    LOOP
      IF v_item.product_id IS NULL OR COALESCE(v_item.quantity, 0) <= 0 THEN
        CONTINUE;
      END IF;

      IF v_prevent_neg THEN
        UPDATE public.products
           SET stock = GREATEST(stock - v_item.quantity, 0),
               updated_at = now()
         WHERE id = v_item.product_id
           AND business_id = v_biz
           AND item_type <> 'service';
      ELSE
        UPDATE public.products
           SET stock = stock - v_item.quantity,
               updated_at = now()
         WHERE id = v_item.product_id
           AND business_id = v_biz
           AND item_type <> 'service';
      END IF;
    END LOOP;

    UPDATE public.delivery_notes
       SET stock_deducted = true
     WHERE id = p_dn_id;
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.deduct_delivery_note_stock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deduct_delivery_note_stock(uuid) TO authenticated, service_role;

-- =====================================================
-- recompute_dish_cost(p_product_id DEFAULT NULL)
--
-- The NULL/no-argument form previously recomputed EVERY dish in the database
-- (`WHERE p.is_dish = true`, no tenant filter). It is no longer called by the
-- client or by any trigger, so NULL is now rejected outright. A non-null id is
-- validated against the caller's membership.
-- =====================================================
CREATE OR REPLACE FUNCTION public.recompute_dish_cost(p_product_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_business uuid;
BEGIN
  IF p_product_id IS NULL THEN
    RAISE EXCEPTION 'recompute_dish_cost requires a product id';
  END IF;

  SELECT business_id INTO v_business
    FROM public.products
   WHERE id = p_product_id;

  IF v_business IS NULL THEN
    RETURN;
  END IF;

  IF NOT public.is_business_member(v_business) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE public.products p
  SET cost_price = COALESCE((
        SELECT SUM(ri.quantity * i.cost_per_unit)
        FROM public.recipe_ingredients ri
        JOIN public.ingredients i ON i.id = ri.ingredient_id
        WHERE ri.product_id = p.id
      ), 0),
      updated_at = now()
  WHERE p.id = p_product_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recompute_dish_cost(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recompute_dish_cost(uuid) TO authenticated, service_role;

-- =====================================================
-- adjust_ingredients_for_sale(p_business_id, p_items, direction, type, ref)
--
-- Previously only validated business_type and the item shape, then wrote
-- ingredients.stock + forged ledger rows for ANY business id supplied. Now the
-- caller must be a member of p_business_id. Body is otherwise unchanged.
-- =====================================================
CREATE OR REPLACE FUNCTION public.adjust_ingredients_for_sale(
  p_business_id uuid,
  p_items jsonb,
  p_direction integer,
  p_movement_type text,
  p_reference_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_item jsonb;
  v_product uuid;
  v_qty integer;
  v_recipe record;
  v_after integer;
  v_business_type text;
BEGIN
  IF NOT public.is_business_member(p_business_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT business_type INTO v_business_type FROM public.businesses WHERE id = p_business_id;
  IF v_business_type <> 'restaurant' OR jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
    RETURN;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    v_product := (v_item->>'productId')::uuid;
    v_qty := COALESCE((v_item->>'quantity')::integer, 0);
    IF v_product IS NULL OR v_qty <= 0 THEN
      CONTINUE;
    END IF;
    FOR v_recipe IN
      SELECT ri.ingredient_id, ri.quantity AS per_serving, i.cost_per_unit
      FROM public.recipe_ingredients ri
      JOIN public.ingredients i ON i.id = ri.ingredient_id
      WHERE ri.product_id = v_product AND ri.quantity > 0
    LOOP
      UPDATE public.ingredients
      SET stock = stock + (p_direction * v_recipe.per_serving * v_qty),
          updated_at = now()
      WHERE id = v_recipe.ingredient_id
      RETURNING stock INTO v_after;

      INSERT INTO public.ingredient_stock_movements (
        business_id, ingredient_id, delta, quantity_after,
        movement_type, reference_type, reference_id, actor_id, actor_name
      ) VALUES (
        p_business_id, v_recipe.ingredient_id, p_direction * v_recipe.per_serving * v_qty,
        v_after, p_movement_type, 'sale', p_reference_id, auth.uid(), COALESCE(auth.jwt()->>'email', '')
      );
    END LOOP;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.adjust_ingredients_for_sale(uuid, jsonb, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_ingredients_for_sale(uuid, jsonb, integer, text, uuid) TO authenticated, service_role;

-- =====================================================
-- Guard: fail loudly if any of the three still exposes EXECUTE to anon/public.
-- =====================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, a.grantee
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE n.nspname = 'public'
      AND p.proname IN ('recompute_dish_cost', 'adjust_ingredients_for_sale', 'deduct_delivery_note_stock')
      AND a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0 OR a.grantee = 'anon'::regrole)
  LOOP
    RAISE EXCEPTION 'isolation_hotfix: % still grants EXECUTE to public/anon', r.proname;
  END LOOP;
END $$;

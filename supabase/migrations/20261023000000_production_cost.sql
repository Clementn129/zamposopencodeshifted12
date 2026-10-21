-- =====================================================
-- Production cost tracking
--
-- Adds material-cost accounting to the manufacturing module so a Producer
-- can see what it costs to build a finished good, not just what it sells for.
--
-- Design notes:
--   * Purely additive. New columns carry defaults so existing rows are
--     unaffected. No behaviour change for non-producer businesses.
--   * Production cost is a SNAPSHOT: captured at completion from the component
--     cost prices in effect at that moment, so later price changes don't
--     rewrite history.
--   * Physical production (raw -> finished) is an internal stock move, NOT an
--     expense. Its cost becomes COGS only when the finished good is sold.
--   * Named `prod_cost`-prefixed locals only to avoid colliding with function
--     args of the replaced RPCs.
-- =====================================================

-- ---------------------------------------------------------------------------
-- 1. production_orders: material-cost snapshot columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cost numeric(16,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_snapshotted_at timestamptz;

COMMENT ON COLUMN public.production_orders.unit_cost IS
  'Material cost of ONE finished unit at completion (sum of component cost_price x quantity_required).';
COMMENT ON COLUMN public.production_orders.total_cost IS
  'unit_cost * quantity_to_produce, snapshotted when the order was completed.';
COMMENT ON COLUMN public.production_orders.cost_snapshotted_at IS
  'When the cost snapshot was taken (NULL for orders completed before cost tracking).';

-- ---------------------------------------------------------------------------
-- 2. Internal helper: recompute a manufactured product's cost_price from BOM
--
-- Used by save_bom_item / delete_bom_item (only when the product's cost is
-- empty — a manual override survives) and by sync_manufactured_cost (forced).
-- Returns the unit cost that was computed (or NULL if the product has no BOM).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_manufactured_cost(
  p_finished_product_id uuid,
  p_force boolean DEFAULT false
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_bom boolean;
  v_unit numeric;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.bom_items WHERE finished_product_id = p_finished_product_id
  ) INTO v_has_bom;

  IF NOT v_has_bom THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(COALESCE(p.cost_price, 0) * bi.quantity_required), 0)
    INTO v_unit
    FROM public.bom_items bi
    JOIN public.products p ON p.id = bi.component_product_id
   WHERE bi.finished_product_id = p_finished_product_id;

  -- Only fill when the product is manufactured (or forced) and — unless forced —
  -- only when it has no cost yet, so a manual override is preserved.
  IF p_force THEN
    UPDATE public.products
       SET cost_price = v_unit, updated_at = now()
     WHERE id = p_finished_product_id
       AND is_manufactured = true;
  ELSE
    UPDATE public.products
       SET cost_price = v_unit, updated_at = now()
     WHERE id = p_finished_product_id
       AND is_manufactured = true
       AND cost_price IS NULL;
  END IF;

  RETURN v_unit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recompute_manufactured_cost(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recompute_manufactured_cost(uuid, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. RPC: sync_manufactured_cost — force re-pull a product's cost from its BOM
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_manufactured_cost(p_product_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid;
  v_unit numeric;
BEGIN
  SELECT business_id INTO v_biz FROM public.products WHERE id = p_product_id;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'Product not found'; END IF;

  IF NOT (public.owns_business(v_biz) OR public.is_manager(v_biz)) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  v_unit := public.recompute_manufactured_cost(p_product_id, true);
  IF v_unit IS NULL THEN
    RAISE EXCEPTION 'This product has no Bill of Materials to price from';
  END IF;

  RETURN v_unit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_manufactured_cost(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_manufactured_cost(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. save_bom_item — now also auto-fills the finished good's cost (when empty)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_bom_item(
  p_business_id uuid,
  p_finished_product_id uuid,
  p_component_product_id uuid,
  p_quantity_required numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_cycle boolean;
BEGIN
  IF NOT (public.owns_business(p_business_id) OR public.is_manager(p_business_id)) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF p_quantity_required IS NULL OR p_quantity_required <= 0 THEN
    RAISE EXCEPTION 'Quantity required must be greater than zero';
  END IF;

  IF p_finished_product_id = p_component_product_id THEN
    RAISE EXCEPTION 'A product cannot be a component of itself';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products
     WHERE id = p_finished_product_id AND business_id = p_business_id
  ) THEN
    RAISE EXCEPTION 'Finished product not found in this business';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
     WHERE id = p_component_product_id AND business_id = p_business_id
  ) THEN
    RAISE EXCEPTION 'Component product not found in this business';
  END IF;

  WITH RECURSIVE deps(pid) AS (
    SELECT p_component_product_id
    UNION
    SELECT bi.component_product_id
      FROM public.bom_items bi
      JOIN deps d ON bi.finished_product_id = d.pid
     WHERE bi.business_id = p_business_id
  )
  SELECT EXISTS (SELECT 1 FROM deps WHERE pid = p_finished_product_id) INTO v_cycle;

  IF v_cycle THEN
    RAISE EXCEPTION 'This component would create a circular Bill of Materials';
  END IF;

  INSERT INTO public.bom_items (
    business_id, finished_product_id, component_product_id, quantity_required
  ) VALUES (
    p_business_id, p_finished_product_id, p_component_product_id, p_quantity_required
  )
  ON CONFLICT (finished_product_id, component_product_id)
  DO UPDATE SET quantity_required = EXCLUDED.quantity_required,
                updated_at = now()
  RETURNING id INTO v_id;

  -- Auto-fill the finished good's cost from its materials (only if empty).
  PERFORM public.recompute_manufactured_cost(p_finished_product_id, false);

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_bom_item(uuid, uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_bom_item(uuid, uuid, uuid, numeric) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. delete_bom_item — also refresh the finished good's cost (when empty)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_bom_item(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid;
  v_finished uuid;
BEGIN
  SELECT business_id, finished_product_id INTO v_biz, v_finished
    FROM public.bom_items WHERE id = p_id;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'BOM item not found'; END IF;
  IF NOT (public.owns_business(v_biz) OR public.is_manager(v_biz)) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  DELETE FROM public.bom_items WHERE id = p_id;

  IF v_finished IS NOT NULL THEN
    PERFORM public.recompute_manufactured_cost(v_finished, false);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_bom_item(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_bom_item(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. log_stock_change — support app.stock_reference_type GUC (allowlisted)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_stock_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old integer := COALESCE(OLD.stock, 0);
  v_new integer := COALESCE(NEW.stock, 0);
  v_delta integer := v_new - v_old;
  v_mtype text := 'manual_edit';
  v_ref_type text := NULL;
  v_ref_id uuid := NULL;
  v_note text := NULL;
  v_actor_id uuid := NULL;
  v_actor_name text := NULL;
  v_effective_at timestamptz := NULL;
  v_guc text;
  v_allowed text[] := ARRAY[
    'sale','sale_return','sale_delete','delivery_note',
    'adjustment_add','adjustment_remove','manual_edit','import',
    'variant_create','product_create','restoration','other'
  ];
  v_allowed_ref text[] := ARRAY['production_order'];
BEGIN
  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  v_actor_id := auth.uid();

  IF TG_NAME = 'on_products_stock_after_update' THEN
    v_mtype := 'manual_edit';
  END IF;

  BEGIN
    v_effective_at := NULLIF(current_setting('app.stock_effective_at', true), '')::timestamptz;
  EXCEPTION WHEN others THEN
    v_effective_at := NULL;
  END;
  v_effective_at := LEAST(COALESCE(v_effective_at, now()), now());

  v_guc := NULLIF(current_setting('app.stock_movement_type', true), '');
  IF v_guc IS NOT NULL AND v_guc = ANY (v_allowed) THEN
    v_mtype := v_guc;
  END IF;

  -- Reference type: only a small allowlist is accepted.
  v_guc := NULLIF(current_setting('app.stock_reference_type', true), '');
  IF v_guc IS NOT NULL AND v_guc = ANY (v_allowed_ref) THEN
    v_ref_type := v_guc;
  END IF;

  BEGIN
    v_ref_id := NULLIF(current_setting('app.stock_reference_id', true), '')::uuid;
  EXCEPTION WHEN others THEN
    v_ref_id := NULL;
  END;

  v_note := NULLIF(current_setting('app.stock_note', true), '');

  INSERT INTO public.stock_movements (
    business_id, product_id, delta, quantity_after, movement_type,
    reference_type, reference_id, note, actor_id, actor_name, effective_at
  ) VALUES (
    NEW.business_id, NEW.id, v_delta, v_new, v_mtype,
    v_ref_type, v_ref_id, v_note, v_actor_id, v_actor_name, v_effective_at
  );
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. complete_production_order — now snapshots material cost
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_production_order(p_order_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
  v_prevent boolean := true;
  v_needed numeric;
  v_have integer;
  v_comp record;
  v_unit_cost numeric := 0;
BEGIN
  SELECT * INTO v_order
    FROM public.production_orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production order not found';
  END IF;

  IF NOT (public.owns_business(v_order.business_id) OR public.is_manager(v_order.business_id)) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_order.status NOT IN ('PENDING','IN_PROGRESS') THEN
    RAISE EXCEPTION 'Only pending or in-progress orders can be completed';
  END IF;

  SELECT COALESCE(prevent_negative_stock, true) INTO v_prevent
    FROM public.businesses WHERE id = v_order.business_id;

  -- Step B: sufficiency check for every component (and accumulate unit cost).
  FOR v_comp IN
    SELECT bi.component_product_id AS pid,
           p.name AS name,
           (bi.quantity_required * v_order.quantity_to_produce) AS need,
           p.stock AS have,
           (COALESCE(p.cost_price, 0) * bi.quantity_required) AS line_unit_cost
      FROM public.bom_items bi
      JOIN public.products p ON p.id = bi.component_product_id
     WHERE bi.finished_product_id = v_order.product_id
  LOOP
    IF v_prevent AND v_comp.have < v_comp.need THEN
      RAISE EXCEPTION 'Insufficient materials: "%" needs % but only % in stock',
        v_comp.name, v_comp.need, v_comp.have
        USING ERRCODE = 'check_violation';
    END IF;
    v_unit_cost := v_unit_cost + v_comp.line_unit_cost;
  END LOOP;

  -- Step C: consume components.
  PERFORM set_config('app.stock_movement_type', 'adjustment_remove', true);
  PERFORM set_config('app.stock_reference_type', 'production_order', true);
  PERFORM set_config('app.stock_reference_id', v_order.id::text, true);
  PERFORM set_config('app.stock_note',
    'Production consumption for order ' || v_order.id::text, true);

  UPDATE public.products p
     SET stock = p.stock - (bi.quantity_required * v_order.quantity_to_produce),
         updated_at = now()
    FROM public.bom_items bi
   WHERE bi.finished_product_id = v_order.product_id
     AND p.id = bi.component_product_id;

  PERFORM set_config('app.stock_movement_type', '', true);
  PERFORM set_config('app.stock_reference_type', '', true);
  PERFORM set_config('app.stock_reference_id', '', true);
  PERFORM set_config('app.stock_note', '', true);

  -- Step D: produce the finished good.
  PERFORM set_config('app.stock_movement_type', 'adjustment_add', true);
  PERFORM set_config('app.stock_reference_type', 'production_order', true);
  PERFORM set_config('app.stock_reference_id', v_order.id::text, true);
  PERFORM set_config('app.stock_note',
    'Production output for order ' || v_order.id::text, true);

  UPDATE public.products
     SET stock = stock + v_order.quantity_to_produce,
         updated_at = now()
   WHERE id = v_order.product_id
     AND business_id = v_order.business_id;

  PERFORM set_config('app.stock_movement_type', '', true);
  PERFORM set_config('app.stock_reference_type', '', true);
  PERFORM set_config('app.stock_reference_id', '', true);
  PERFORM set_config('app.stock_note', '', true);

  -- Step E: complete the order + snapshot the material cost.
  UPDATE public.production_orders
     SET status = 'COMPLETED',
         completed_at = now(),
         unit_cost = v_unit_cost,
         total_cost = v_unit_cost * v_order.quantity_to_produce,
         cost_snapshotted_at = now(),
         updated_at = now()
   WHERE id = v_order.id;

  RETURN v_order.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_production_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_production_order(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. RPC: reverse_production_order — undo a COMPLETED run
--
--   Adds the components back and removes the finished good, mirroring exactly
--   what complete_production_order did. The order is marked CANCELLED (kept for
--   the audit trail) rather than deleted.
--
--   Safety: refuses if removing the finished good would drive its stock below
--   zero (i.e. the produced units have already been sold/used). No override —
--   the operator must first correct the downstream activity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_production_order(p_order_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
  v_finished_stock integer;
BEGIN
  SELECT * INTO v_order
    FROM public.production_orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production order not found';
  END IF;

  IF NOT (public.owns_business(v_order.business_id) OR public.is_manager(v_order.business_id)) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_order.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Only completed orders can be reversed';
  END IF;

  -- Guard: the produced units must still be on hand.
  SELECT stock INTO v_finished_stock
    FROM public.products
   WHERE id = v_order.product_id AND business_id = v_order.business_id;

  IF v_finished_stock IS NULL THEN
    RAISE EXCEPTION 'Finished product no longer exists';
  END IF;

  IF v_finished_stock < v_order.quantity_to_produce THEN
    RAISE EXCEPTION 'Cannot reverse: only % of the % produced units remain in stock (the rest were sold or used)',
      v_finished_stock, v_order.quantity_to_produce
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reverse Step D: remove the finished good.
  PERFORM set_config('app.stock_movement_type', 'adjustment_remove', true);
  PERFORM set_config('app.stock_reference_type', 'production_order', true);
  PERFORM set_config('app.stock_reference_id', v_order.id::text, true);
  PERFORM set_config('app.stock_note',
    'Production reversal (output removed) for order ' || v_order.id::text, true);

  UPDATE public.products
     SET stock = stock - v_order.quantity_to_produce,
         updated_at = now()
   WHERE id = v_order.product_id
     AND business_id = v_order.business_id;

  PERFORM set_config('app.stock_movement_type', '', true);
  PERFORM set_config('app.stock_reference_type', '', true);
  PERFORM set_config('app.stock_reference_id', '', true);
  PERFORM set_config('app.stock_note', '', true);

  -- Reverse Step C: give the components back.
  PERFORM set_config('app.stock_movement_type', 'adjustment_add', true);
  PERFORM set_config('app.stock_reference_type', 'production_order', true);
  PERFORM set_config('app.stock_reference_id', v_order.id::text, true);
  PERFORM set_config('app.stock_note',
    'Production reversal (materials returned) for order ' || v_order.id::text, true);

  UPDATE public.products p
     SET stock = p.stock + (bi.quantity_required * v_order.quantity_to_produce),
         updated_at = now()
    FROM public.bom_items bi
   WHERE bi.finished_product_id = v_order.product_id
     AND p.id = bi.component_product_id;

  PERFORM set_config('app.stock_movement_type', '', true);
  PERFORM set_config('app.stock_reference_type', '', true);
  PERFORM set_config('app.stock_reference_id', '', true);
  PERFORM set_config('app.stock_note', '', true);

  -- Mark cancelled; clear the cost snapshot's active meaning but keep the row.
  UPDATE public.production_orders
     SET status = 'CANCELLED',
         updated_at = now()
   WHERE id = v_order.id;

  RETURN v_order.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reverse_production_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_production_order(uuid) TO authenticated, service_role;

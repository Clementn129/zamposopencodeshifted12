-- =====================================================
-- Universal Manufacturing / Production module
--
-- Adds a "Producer" production capability that turns RAW_MATERIALs into
-- FINISHED_GOODs via a Bill of Materials (BOM), with work orders that move
-- product stock atomically on completion.
--
-- Design notes:
--   * Purely additive. New columns carry defaults so every existing row /
--     business type (retail, service, hybrid, restaurant) is unaffected.
--   * Only `products.stock` is moved. The existing `log_stock_change()`
--     trigger writes the `stock_movements` audit ledger automatically via the
--     app.stock_* GUC handshake — no second ledger, no manual ledger inserts.
--   * `product_type` / `status` use TEXT + CHECK (house convention: only
--     item_type, business_type, movement_type are constrained this way too).
--   * Behaviours are gated on `businesses.business_type = 'producer'` at the
--     UI layer; the RPCs work for any business but are owner/manager gated.
-- =====================================================

-- ---------------------------------------------------------------------------
-- 1. products: product_type + is_manufactured
-- ---------------------------------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'FINISHED_GOOD',
  ADD COLUMN IF NOT EXISTS is_manufactured BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE public.products
    ADD CONSTRAINT products_product_type_check
    CHECK (product_type IN ('RAW_MATERIAL','SUB_ASSEMBLY','FINISHED_GOOD'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.products.product_type IS
  'Manufacturing role of the product: RAW_MATERIAL (input), SUB_ASSEMBLY (intermediate), FINISHED_GOOD (output). Orthogonal to item_type.';
COMMENT ON COLUMN public.products.is_manufactured IS
  'True when the product is produced via a Bill of Materials rather than purchased for resale.';

-- ---------------------------------------------------------------------------
-- 2. bom_items — Bill of Materials (many-to-many)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bom_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  finished_product_id  uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  component_product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity_required    numeric(12,4) NOT NULL CHECK (quantity_required > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (finished_product_id, component_product_id),
  CHECK (finished_product_id <> component_product_id)
);

COMMENT ON TABLE public.bom_items IS
  'Bill of Materials: quantity of each component_product_id required to make one unit of finished_product_id.';
COMMENT ON COLUMN public.bom_items.quantity_required IS
  'Amount of the component needed to produce ONE unit of the finished product.';

CREATE INDEX IF NOT EXISTS idx_bom_items_business ON public.bom_items(business_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_finished ON public.bom_items(finished_product_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_component ON public.bom_items(component_product_id);

ALTER TABLE public.bom_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view bom items" ON public.bom_items;
CREATE POLICY "Members can view bom items" ON public.bom_items
  FOR SELECT TO authenticated
  USING (public.is_business_member(business_id));

DROP POLICY IF EXISTS "Owners and managers manage bom items" ON public.bom_items;
CREATE POLICY "Owners and managers manage bom items" ON public.bom_items
  FOR ALL TO authenticated
  USING (public.owns_business(business_id) OR public.is_manager(business_id))
  WITH CHECK (public.owns_business(business_id) OR public.is_manager(business_id));

DROP TRIGGER IF EXISTS trg_bom_items_updated_at ON public.bom_items;
CREATE TRIGGER trg_bom_items_updated_at
  BEFORE UPDATE ON public.bom_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 3. production_orders — work orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.production_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id           uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity_to_produce  integer NOT NULL CHECK (quantity_to_produce > 0),
  status               text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','CANCELLED')),
  started_at           timestamptz,
  completed_at         timestamptz,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_orders IS
  'Work orders tracking the manufacturing of a finished good from its BOM.';

CREATE INDEX IF NOT EXISTS idx_production_orders_business ON public.production_orders(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_orders_product ON public.production_orders(product_id);

ALTER TABLE public.production_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view production orders" ON public.production_orders;
CREATE POLICY "Members can view production orders" ON public.production_orders
  FOR SELECT TO authenticated
  USING (public.is_business_member(business_id));

DROP POLICY IF EXISTS "Owners and managers manage production orders" ON public.production_orders;
CREATE POLICY "Owners and managers manage production orders" ON public.production_orders
  FOR ALL TO authenticated
  USING (public.owns_business(business_id) OR public.is_manager(business_id))
  WITH CHECK (public.owns_business(business_id) OR public.is_manager(business_id));

DROP TRIGGER IF EXISTS trg_production_orders_updated_at ON public.production_orders;
CREATE TRIGGER trg_production_orders_updated_at
  BEFORE UPDATE ON public.production_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 4. RPC: save_bom_item — upsert one BOM line, with cycle validation
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

  -- Both products must belong to this business.
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

  -- Cycle guard: adding finished <- component must not let the finished good
  -- feed back into itself transitively (finished must not already depend on
  -- the component as its own component, directly or indirectly).
  -- Walk DOWNWARD from the component: if we ever reach the finished product,
  -- the new edge closes a loop.
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

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_bom_item(uuid, uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_bom_item(uuid, uuid, uuid, numeric) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. RPC: delete_bom_item
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_bom_item(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid;
BEGIN
  SELECT business_id INTO v_biz FROM public.bom_items WHERE id = p_id;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'BOM item not found'; END IF;
  IF NOT (public.owns_business(v_biz) OR public.is_manager(v_biz)) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  DELETE FROM public.bom_items WHERE id = p_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_bom_item(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_bom_item(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. RPC: start_production_order
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_production_order(
  p_business_id uuid,
  p_product_id uuid,
  p_quantity integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT (public.owns_business(p_business_id) OR public.is_manager(p_business_id)) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity to produce must be greater than zero';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products
     WHERE id = p_product_id AND business_id = p_business_id
  ) THEN
    RAISE EXCEPTION 'Finished product not found in this business';
  END IF;

  INSERT INTO public.production_orders (
    business_id, product_id, quantity_to_produce, status, started_at, created_by
  ) VALUES (
    p_business_id, p_product_id, p_quantity, 'IN_PROGRESS', now(), auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.start_production_order(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_production_order(uuid, uuid, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. RPC: complete_production_order — the atomic production trigger
--
--   Step A: load the BOM for the order's product
--   Step B: verify sufficient stock of every component (else RAISE)
--   Step C: subtract (quantity_required * quantity_to_produce) from components
--   Step D: add quantity_to_produce to the finished good
--   Step E: mark the order COMPLETED
--
-- All in one transaction. Stock moves are logged to `stock_movements`
-- automatically by `log_stock_change()` via the app.stock_* GUCs.
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
  v_biz_name text;
  v_needed numeric;
  v_have integer;
  v_comp record;
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

  -- Step B: sufficiency check for every component.
  IF v_prevent THEN
    FOR v_comp IN
      SELECT bi.component_product_id AS pid,
             p.name AS name,
             (bi.quantity_required * v_order.quantity_to_produce) AS need,
             p.stock AS have
        FROM public.bom_items bi
        JOIN public.products p ON p.id = bi.component_product_id
       WHERE bi.finished_product_id = v_order.product_id
    LOOP
      IF v_comp.have < v_comp.need THEN
        RAISE EXCEPTION 'Insufficient materials: "%" needs % but only % in stock',
          v_comp.name, v_comp.need, v_comp.have
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;

  -- Step C: consume components.
  PERFORM set_config('app.stock_movement_type', 'adjustment_remove', true);
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
  PERFORM set_config('app.stock_reference_id', '', true);
  PERFORM set_config('app.stock_note', '', true);

  -- Step D: produce the finished good.
  PERFORM set_config('app.stock_movement_type', 'adjustment_add', true);
  PERFORM set_config('app.stock_reference_id', v_order.id::text, true);
  PERFORM set_config('app.stock_note',
    'Production output for order ' || v_order.id::text, true);

  UPDATE public.products
     SET stock = stock + v_order.quantity_to_produce,
         updated_at = now()
   WHERE id = v_order.product_id
     AND business_id = v_order.business_id;

  PERFORM set_config('app.stock_movement_type', '', true);
  PERFORM set_config('app.stock_reference_id', '', true);
  PERFORM set_config('app.stock_note', '', true);

  -- Step E: complete the order.
  UPDATE public.production_orders
     SET status = 'COMPLETED',
         completed_at = now(),
         updated_at = now()
   WHERE id = v_order.id;

  RETURN v_order.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_production_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_production_order(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. RPC: cancel_production_order — no stock impact
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_production_order(p_order_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order
    FROM public.production_orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Production order not found'; END IF;

  IF NOT (public.owns_business(v_order.business_id) OR public.is_manager(v_order.business_id)) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_order.status NOT IN ('PENDING','IN_PROGRESS') THEN
    RAISE EXCEPTION 'Only pending or in-progress orders can be cancelled';
  END IF;

  UPDATE public.production_orders
     SET status = 'CANCELLED', updated_at = now()
   WHERE id = v_order.id;

  RETURN v_order.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cancel_production_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_production_order(uuid) TO authenticated, service_role;

-- Opening-stock correction.
--
-- Products already keep a complete stock_movements ledger. This migration adds
-- an explicit opening_stock value so an owner can correct the original opening
-- quantity after sales have happened without overwriting current stock.
--
-- The correction is posted as a back-dated `opening_correction` movement, so
-- reports for past periods are restated and the current stock falls by the same
-- difference the opening stock fell.

-- ---------------------------------------------------------------------------
-- 1. Business feature flag
-- ---------------------------------------------------------------------------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS allow_opening_stock_correction BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.businesses.allow_opening_stock_correction IS
  'When true, the owner may correct a product opening quantity after sales. Off by default.';

-- ---------------------------------------------------------------------------
-- 2. Product opening-stock value
-- ---------------------------------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS opening_stock INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_opening_stock_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_opening_stock_check CHECK (opening_stock >= 0);

COMMENT ON COLUMN public.products.opening_stock IS
  'The product opening quantity. Corrected through correct_opening_stock(), never by ordinary product edits.';

-- New products record their initial quantity automatically, including products
-- created by quick-add, CSV import or any direct insert path.
CREATE OR REPLACE FUNCTION public.set_product_opening_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.opening_stock := COALESCE(NEW.stock, 0);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_products_opening_stock_before_insert ON public.products;
CREATE TRIGGER set_products_opening_stock_before_insert
  BEFORE INSERT ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.set_product_opening_stock();

-- ---------------------------------------------------------------------------
-- 3. Movement type for auditable opening corrections
-- ---------------------------------------------------------------------------
ALTER TABLE public.stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;
ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN (
    'sale','sale_return','sale_delete','delivery_note',
    'adjustment_add','adjustment_remove','manual_edit','import',
    'variant_create','product_create','restoration','other','opening_correction'
  ));

-- The newest log_stock_change() version lost its INSERT branch, so products
-- created after it logged their opening movement as a manual edit. Restore the
-- INSERT branch and relabel the exact creation-time rows it produced.
CREATE OR REPLACE FUNCTION public.log_stock_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old integer := 0;
  v_new integer := COALESCE(NEW.stock, 0);
  v_delta integer;
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
    'variant_create','product_create','restoration','other',
    'opening_correction'
  ];
  v_allowed_ref text[] := ARRAY['production_order'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_old := 0;
    v_new := COALESCE(NEW.stock, 0);
    v_mtype := 'product_create';
  ELSE
    v_old := COALESCE(OLD.stock, 0);
    v_new := COALESCE(NEW.stock, 0);
    IF TG_NAME = 'on_products_stock_after_update' THEN
      v_mtype := 'manual_edit';
    END IF;
  END IF;

  v_delta := v_new - v_old;
  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  v_actor_id := auth.uid();

  BEGIN
    v_effective_at := NULLIF(current_setting('app.stock_effective_at', true), '')::timestamptz;
  EXCEPTION WHEN others THEN
    v_effective_at := NULL;
  END;

  BEGIN
    v_ref_id := NULLIF(current_setting('app.stock_reference_id', true), '')::uuid;
  EXCEPTION WHEN others THEN
    v_ref_id := NULL;
  END;

  v_note := NULLIF(current_setting('app.stock_note', true), '');

  v_guc := NULLIF(current_setting('app.stock_movement_type', true), '');
  IF v_guc IS NOT NULL AND v_guc = ANY (v_allowed) THEN
    v_mtype := v_guc;
  END IF;

  v_guc := NULLIF(current_setting('app.stock_reference_type', true), '');
  IF v_guc IS NOT NULL AND v_guc = ANY (v_allowed_ref) THEN
    v_ref_type := v_guc;
  END IF;

  INSERT INTO public.stock_movements (
    business_id, product_id, delta, quantity_after, movement_type,
    reference_type, reference_id, note, actor_id, actor_name, effective_at
  ) VALUES (
    NEW.business_id, NEW.id, v_delta, v_new, v_mtype,
    v_ref_type, v_ref_id, v_note, v_actor_id, v_actor_name,
    LEAST(COALESCE(v_effective_at, now()), now())
  );

  RETURN NEW;
END;
$$;

WITH first_movement AS (
  SELECT DISTINCT ON (sm.product_id)
    sm.id,
    sm.product_id,
    sm.movement_type,
    sm.created_at
  FROM public.stock_movements sm
  ORDER BY sm.product_id, COALESCE(sm.effective_at, sm.created_at), sm.created_at, sm.id
)
UPDATE public.stock_movements sm
SET movement_type = 'product_create'
FROM first_movement f
JOIN public.products p ON p.id = f.product_id
WHERE sm.id = f.id
  AND f.movement_type = 'manual_edit'
  AND f.created_at = p.created_at;

-- Backfill the explicit opening value from the first opening-type movement.
WITH first_movement AS (
  SELECT DISTINCT ON (sm.product_id)
    sm.product_id,
    sm.delta,
    sm.movement_type
  FROM public.stock_movements sm
  ORDER BY sm.product_id, COALESCE(sm.effective_at, sm.created_at), sm.created_at, sm.id
)
UPDATE public.products p
SET opening_stock = GREATEST(COALESCE((
  SELECT f.delta
  FROM first_movement f
  WHERE f.product_id = p.id
    AND f.movement_type IN ('product_create', 'import', 'variant_create')
), 0), 0);

-- ---------------------------------------------------------------------------
-- 4. Owner-only correction RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correct_opening_stock(
  p_product_id uuid,
  p_new_opening integer,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product public.products%ROWTYPE;
  v_old integer;
  v_delta integer;
  v_new_stock integer;
  v_opening_ts timestamptz;
  v_first_ts timestamptz;
  v_effective timestamptz;
  v_note text;
BEGIN
  IF p_new_opening IS NULL OR p_new_opening < 0 THEN
    RAISE EXCEPTION 'Opening stock cannot be negative';
  END IF;

  SELECT * INTO v_product
  FROM public.products
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  IF NOT public.owns_business(v_product.business_id) THEN
    RAISE EXCEPTION 'Only the business owner can correct opening stock';
  END IF;

  IF NOT COALESCE((
    SELECT allow_opening_stock_correction
    FROM public.businesses
    WHERE id = v_product.business_id
  ), false) THEN
    RAISE EXCEPTION 'Opening-stock corrections are turned off';
  END IF;

  v_old := COALESCE(v_product.opening_stock, 0);
  v_delta := p_new_opening - v_old;

  IF v_delta = 0 THEN
    RETURN jsonb_build_object(
      'changed', false,
      'old_opening', v_old,
      'new_opening', p_new_opening,
      'delta', 0,
      'current_stock', v_product.stock
    );
  END IF;

  v_new_stock := COALESCE(v_product.stock, 0) + v_delta;

  IF v_new_stock < 0 THEN
    RAISE EXCEPTION
      'Cannot set opening stock to %. It must be at least % because current stock is % after units already sold or moved.',
      p_new_opening, GREATEST(v_old - COALESCE(v_product.stock, 0), 0), v_product.stock
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(sm.effective_at, sm.created_at)
    INTO v_opening_ts
  FROM public.stock_movements sm
  WHERE sm.product_id = p_product_id
    AND sm.movement_type IN ('product_create', 'import', 'variant_create')
  ORDER BY COALESCE(sm.effective_at, sm.created_at), sm.created_at, sm.id
  LIMIT 1;

  IF v_opening_ts IS NOT NULL THEN
    -- Sit immediately after the opening movement but before later activity.
    v_effective := LEAST(v_opening_ts + interval '1 microsecond', now());
  ELSE
    SELECT MIN(COALESCE(sm.effective_at, sm.created_at))
      INTO v_first_ts
    FROM public.stock_movements sm
    WHERE sm.product_id = p_product_id;

    -- No opening movement exists (opening was zero). Put the correction just
    -- before the first known activity so it becomes the opening balance.
    v_effective := LEAST(
      LEAST(COALESCE(v_first_ts, v_product.created_at), v_product.created_at) - interval '1 microsecond',
      now()
    );
  END IF;

  v_note := 'Opening stock corrected from ' || v_old || ' to ' || p_new_opening;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NOT NULL THEN
    v_note := v_note || ': ' || trim(p_reason);
  END IF;

  PERFORM set_config('app.stock_effective_at', v_effective::text, true);
  PERFORM set_config('app.stock_movement_type', 'opening_correction', true);
  PERFORM set_config('app.stock_note', v_note, true);

  UPDATE public.products
  SET stock = v_new_stock,
      opening_stock = p_new_opening,
      updated_at = now()
  WHERE id = p_product_id;

  PERFORM set_config('app.stock_effective_at', '', true);
  PERFORM set_config('app.stock_movement_type', '', true);
  PERFORM set_config('app.stock_note', '', true);

  -- quantity_after is a denormalised running balance. Rebuild it for the whole
  -- product after restating the opening so item-history balances stay correct.
  WITH ordered AS (
    SELECT
      sm.id,
      SUM(sm.delta) OVER (
        ORDER BY COALESCE(sm.effective_at, sm.created_at), sm.created_at, sm.id
      ) AS running
    FROM public.stock_movements sm
    WHERE sm.product_id = p_product_id
  )
  UPDATE public.stock_movements sm
  SET quantity_after = o.running
  FROM ordered o
  WHERE sm.id = o.id;

  RETURN jsonb_build_object(
    'changed', true,
    'old_opening', v_old,
    'new_opening', p_new_opening,
    'delta', v_delta,
    'current_stock', v_new_stock
  );
END;
$$;

REVOKE ALL ON FUNCTION public.correct_opening_stock(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_opening_stock(uuid, integer, text) TO authenticated;

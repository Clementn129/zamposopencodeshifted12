-- Back-dating (per-business opt-in) + effective-dated stock movements.
--
-- 1. businesses.allow_backdating gates every back-dating date picker. Off by
--    default; only businesses that ask for it get it turned on.
-- 2. stock_movements.effective_at records WHEN a stock change actually happened
--    (which may be in the past), while created_at stays the audit/insert time.
-- 3. stock_adjustment_requests.effective_at lets a cashier propose a date at
--    request time; the owner can still change it before approving.
-- 4. log_stock_change() reads two transaction-local GUCs so an RPC can stamp a
--    movement; with no GUC set it behaves exactly as before (now(), manual_edit).

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS allow_backdating BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.businesses.allow_backdating IS
  'When true, staff may back-date sales and stock adjustments. Off by default.';

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS effective_at timestamptz NULL;

COMMENT ON COLUMN public.stock_movements.effective_at IS
  'Occurrence time of the movement. NULL falls back to created_at (pre-existing rows).';

ALTER TABLE public.stock_adjustment_requests
  ADD COLUMN IF NOT EXISTS effective_at timestamptz NULL;

COMMENT ON COLUMN public.stock_adjustment_requests.effective_at IS
  'Optional requested back-date for the adjustment; owner may change it before approving.';

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_effective
  ON public.stock_movements (product_id, effective_at);

-- Turn the feature on ONLY for the business that requested it.
UPDATE public.businesses
  SET allow_backdating = true
  WHERE id = '82b240ec-1515-4a48-80f9-2caa16dfdf69';

-- ---------------------------------------------------------------------------
-- Trigger: stamp effective_at (and optional type/ref/note) from GUCs.
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
BEGIN
  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  v_actor_id := auth.uid();

  IF TG_NAME = 'on_products_stock_after_update' THEN
    v_mtype := 'manual_edit';
  END IF;

  -- Occurrence time: only from a trusted RPC, clamped to "not in the future".
  BEGIN
    v_effective_at := NULLIF(current_setting('app.stock_effective_at', true), '')::timestamptz;
  EXCEPTION WHEN others THEN
    v_effective_at := NULL;
  END;
  v_effective_at := LEAST(COALESCE(v_effective_at, now()), now());

  -- Movement type: validate against the CHECK list, otherwise keep manual_edit.
  v_guc := NULLIF(current_setting('app.stock_movement_type', true), '');
  IF v_guc IS NOT NULL AND v_guc = ANY (v_allowed) THEN
    v_mtype := v_guc;
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
-- approve_stock_adjustment: apply the request's effective_at (owner-editable),
-- stamp a typed movement. Gains an optional p_effective_at so the owner can
-- change the requested date at approval time.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.approve_stock_adjustment(uuid, text);

CREATE OR REPLACE FUNCTION public.approve_stock_adjustment(
  p_request_id uuid,
  p_note text DEFAULT NULL,
  p_effective_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid;
  v_product uuid;
  v_variant uuid;
  v_type text;
  v_qty integer;
  v_status text;
  v_target uuid;
  v_delta integer;
  v_request_effective timestamptz;
  v_effective timestamptz;
BEGIN
  SELECT business_id, product_id, variant_id, adjustment_type, quantity, status, effective_at
    INTO v_biz, v_product, v_variant, v_type, v_qty, v_status, v_request_effective
    FROM public.stock_adjustment_requests
    WHERE id = p_request_id
    FOR UPDATE;

  IF v_biz IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF NOT public.owns_business(v_biz) THEN RAISE EXCEPTION 'Only the business owner can approve'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'Request already %', v_status; END IF;

  v_target := COALESCE(v_variant, v_product);
  v_delta := CASE WHEN v_type = 'add' THEN v_qty ELSE -v_qty END;
  -- Owner-provided date wins; otherwise the date captured at request time.
  v_effective := LEAST(COALESCE(p_effective_at, v_request_effective, now()), now());

  PERFORM set_config('app.stock_effective_at', v_effective::text, true);
  PERFORM set_config('app.stock_movement_type',
    CASE WHEN v_type = 'add' THEN 'adjustment_add' ELSE 'adjustment_remove' END, true);
  PERFORM set_config('app.stock_reference_id', p_request_id::text, true);
  PERFORM set_config('app.stock_note', COALESCE(p_note, ''), true);

  UPDATE public.products
    SET stock = GREATEST(stock + v_delta, 0), updated_at = now()
    WHERE id = v_target AND business_id = v_biz;

  PERFORM set_config('app.stock_effective_at', '', true);
  PERFORM set_config('app.stock_movement_type', '', true);
  PERFORM set_config('app.stock_reference_id', '', true);
  PERFORM set_config('app.stock_note', '', true);

  UPDATE public.stock_adjustment_requests
    SET status = 'approved',
        effective_at = v_effective,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_note = p_note
    WHERE id = p_request_id;

  RETURN p_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_stock_adjustment(uuid, text, timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- adjust_product_stock: owner-only direct stock change with an optional date.
-- Used by the Products page when back-dating is enabled and by offline replay.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_product_stock(
  p_product_id uuid,
  p_delta integer,
  p_reason text DEFAULT NULL,
  p_effective_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid;
  v_prevent boolean := true;
  v_effective timestamptz;
BEGIN
  IF p_delta = 0 THEN
    RETURN;
  END IF;

  SELECT business_id INTO v_biz
    FROM public.products
    WHERE id = p_product_id;

  IF v_biz IS NULL THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF NOT public.owns_business(v_biz) THEN RAISE EXCEPTION 'Only the business owner can adjust stock'; END IF;

  SELECT COALESCE(prevent_negative_stock, true) INTO v_prevent
    FROM public.businesses WHERE id = v_biz;

  v_effective := LEAST(COALESCE(p_effective_at, now()), now());

  PERFORM set_config('app.stock_effective_at', v_effective::text, true);
  PERFORM set_config('app.stock_movement_type',
    CASE WHEN p_delta > 0 THEN 'adjustment_add' ELSE 'adjustment_remove' END, true);
  PERFORM set_config('app.stock_note', COALESCE(p_reason, ''), true);

  IF v_prevent THEN
    UPDATE public.products
      SET stock = GREATEST(stock + p_delta, 0), updated_at = now()
      WHERE id = p_product_id AND business_id = v_biz;
  ELSE
    UPDATE public.products
      SET stock = stock + p_delta, updated_at = now()
      WHERE id = p_product_id AND business_id = v_biz;
  END IF;

  PERFORM set_config('app.stock_effective_at', '', true);
  PERFORM set_config('app.stock_movement_type', '', true);
  PERFORM set_config('app.stock_note', '', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.adjust_product_stock(uuid, integer, text, timestamptz) TO authenticated;

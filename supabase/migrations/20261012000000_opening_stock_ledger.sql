-- Opening-stock ledger: make stock_movements complete so that for every product
--   SUM(stock_movements.delta) = products.stock
--
-- Before this migration the trigger only fired on UPDATE OF stock, so a product's
-- initial/created stock was never recorded. That made "starting stock" for any
-- period impossible to reconstruct. This migration:
--   1. logs a movement on product INSERT (opening stock at creation),
--   2. backfills ONE baseline movement per existing product so the invariant
--      holds for all legacy rows,
--   3. stamps back-dated sales deductions with the sale's own date so they land
--      in the correct reporting period.
--
-- No new columns, no new movement_type values (reuses 'product_create' and
-- 'import' from the existing CHECK list).

-- ---------------------------------------------------------------------------
-- 1. log_stock_change() - handle INSERT (opening) as well as UPDATE.
--    OLD is not available on INSERT, so the delta is computed in BEGIN.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_stock_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old integer;
  v_new integer;
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
    'variant_create','product_create','restoration','other'
  ];
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

  -- Occurrence time: only from a trusted RPC, clamped to "not in the future".
  BEGIN
    v_effective_at := NULLIF(current_setting('app.stock_effective_at', true), '')::timestamptz;
  EXCEPTION WHEN others THEN
    v_effective_at := NULL;
  END;
  v_effective_at := LEAST(COALESCE(v_effective_at, now()), now());

  -- Movement type: validate against the CHECK list, otherwise keep the default.
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

-- Log opening stock when a product is created with a non-zero stock.
DO $$ BEGIN
  CREATE TRIGGER on_products_stock_after_insert
    AFTER INSERT ON public.products
    FOR EACH ROW
    EXECUTE FUNCTION public.log_stock_change();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. One-time baseline backfill.
--    For each product, the ledger is missing everything that happened before the
--    ledger existed. Insert a single 'import' movement so the cumulative sum
--    reaches the product's current stock. Dated just before the earliest known
--    movement (or the product's creation time) so it sorts first.
-- ---------------------------------------------------------------------------
INSERT INTO public.stock_movements (
  business_id, product_id, delta, quantity_after, movement_type,
  reference_type, reference_id, note, actor_id, actor_name,
  created_at, effective_at
)
SELECT
  p.business_id,
  p.id,
  p.stock - COALESCE(m.sum_delta, 0),
  p.stock - COALESCE(m.sum_delta, 0),
  'import',
  'product',
  p.id,
  'Opening balance (baseline)',
  NULL,
  NULL,
  COALESCE(m.first_ts - interval '1 microsecond', p.created_at),
  COALESCE(m.first_ts - interval '1 microsecond', p.created_at)
FROM public.products p
LEFT JOIN (
  SELECT product_id,
         SUM(delta) AS sum_delta,
         MIN(COALESCE(effective_at, created_at)) AS first_ts
  FROM public.stock_movements
  GROUP BY product_id
) m ON m.product_id = p.id
WHERE p.stock - COALESCE(m.sum_delta, 0) <> 0;

-- ---------------------------------------------------------------------------
-- 3. sync_offline_sale (20 args) - stamp stock deductions with the sale date.
--    Back-dated sales set p_created_at in the past; without this the movement's
--    effective_at defaulted to now() and landed in the wrong reporting period.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_offline_sale(
    p_business_id uuid,
    p_offline_id text,
    p_items jsonb,
    p_subtotal numeric,
    p_total numeric,
    p_discount_amount numeric DEFAULT 0,
    p_discount_type text DEFAULT NULL,
    p_payment_method text DEFAULT 'cash',
    p_created_at timestamp with time zone DEFAULT now(),
    p_tax_amount numeric DEFAULT 0,
    p_taxable_amount numeric DEFAULT 0,
    p_zero_rated_amount numeric DEFAULT 0,
    p_exempt_amount numeric DEFAULT 0,
    p_customer_name text DEFAULT NULL,
    p_customer_tpin text DEFAULT NULL,
    p_amount_paid numeric DEFAULT NULL,
    p_due_date date DEFAULT NULL,
    p_customer_phone text DEFAULT NULL,
    p_table_id uuid DEFAULT NULL,
    p_deduct_stock boolean DEFAULT true
  )
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  DECLARE
    v_sale_id uuid;
    v_item jsonb;
    v_product_id uuid;
    v_quantity integer;
    v_paid numeric;
    v_cashier_id uuid;
    v_cashier_name text;
    v_cashier_username text;
    v_table_ok boolean;
    v_prevent_neg boolean := true;
  BEGIN
    IF NOT public.is_business_member(p_business_id) THEN
      RAISE EXCEPTION 'Not allowed to sync this sale';
    END IF;

    SELECT id INTO v_sale_id
    FROM public.sales
    WHERE business_id = p_business_id
      AND offline_id = p_offline_id
    LIMIT 1;

    IF v_sale_id IS NOT NULL THEN
      RETURN v_sale_id;
    END IF;

    IF p_table_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.dining_tables
        WHERE id = p_table_id AND business_id = p_business_id
      ) INTO v_table_ok;
      IF NOT v_table_ok THEN
        RAISE EXCEPTION 'Table does not belong to this business';
      END IF;
    END IF;

    v_paid := LEAST(GREATEST(COALESCE(p_amount_paid, p_total), 0), COALESCE(p_total, 0));
    v_cashier_id := auth.uid();

    SELECT COALESCE(NULLIF(trim(bc.display_name), ''), bc.username), bc.username
      INTO v_cashier_name, v_cashier_username
    FROM public.business_cashiers bc
    WHERE bc.business_id = p_business_id
      AND bc.auth_user_id = v_cashier_id
      AND bc.is_active = true
    LIMIT 1;

    IF v_cashier_name IS NULL THEN
      SELECT COALESCE(NULLIF(trim(pr.full_name), ''), pr.email, 'Owner'), pr.email
        INTO v_cashier_name, v_cashier_username
      FROM public.profiles pr
      WHERE pr.user_id = v_cashier_id
      LIMIT 1;
    END IF;

    INSERT INTO public.sales (
      business_id, items, subtotal, total, discount_amount, discount_type,
      payment_method, synced, offline_id, created_at,
      tax_amount, taxable_amount, zero_rated_amount, exempt_amount,
      customer_name, customer_tpin, customer_phone, amount_paid, due_date,
      cashier_id, cashier_name, cashier_username, table_id
    ) VALUES (
      p_business_id,
      COALESCE(p_items, '[]'::jsonb),
      COALESCE(p_subtotal, 0),
      COALESCE(p_total, 0),
      COALESCE(p_discount_amount, 0),
      p_discount_type,
      COALESCE(NULLIF(trim(p_payment_method), ''), 'cash'),
      true,
      p_offline_id,
      COALESCE(p_created_at, now()),
      COALESCE(p_tax_amount, 0),
      COALESCE(p_taxable_amount, 0),
      COALESCE(p_zero_rated_amount, 0),
      COALESCE(p_exempt_amount, 0),
      NULLIF(trim(p_customer_name), ''),
      NULLIF(trim(p_customer_tpin), ''),
      NULLIF(trim(p_customer_phone), ''),
      v_paid,
      p_due_date,
      v_cashier_id,
      COALESCE(v_cashier_name, 'Staff'),
      v_cashier_username,
      p_table_id
    ) RETURNING id INTO v_sale_id;

    -- Zero-price sale: v_paid is 0, so 0 > 0 is false and no sale_payments row
    -- is written. That keeps us clear of the CHECK (amount > 0) on sale_payments.
    IF v_paid > 0 AND v_paid < COALESCE(p_total, 0) THEN
      INSERT INTO public.sale_payments (sale_id, business_id, amount, payment_method, notes, recorded_by)
      VALUES (v_sale_id, p_business_id, v_paid, COALESCE(NULLIF(trim(p_payment_method), ''), 'cash'), 'Initial deposit', v_cashier_id);
    END IF;

    IF COALESCE(p_deduct_stock, true) THEN
      SELECT COALESCE(b.prevent_negative_stock, true)
        INTO v_prevent_neg
        FROM public.businesses b
       WHERE b.id = p_business_id;

      -- Deduct as of the sale's own date (clamped to now), so a back-dated sale
      -- is reported in the period it happened.
      PERFORM set_config('app.stock_effective_at',
        LEAST(COALESCE(p_created_at, now()), now())::text, true);
      PERFORM set_config('app.stock_movement_type', 'sale', true);

      FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
        BEGIN
          v_product_id := NULLIF(v_item->>'productId', '')::uuid;
        EXCEPTION WHEN others THEN
          v_product_id := NULL;
        END;
        v_quantity := GREATEST(COALESCE((v_item->>'quantity')::integer, 0), 0);

        IF v_product_id IS NOT NULL AND v_quantity > 0 THEN
          IF v_prevent_neg THEN
            UPDATE public.products
            SET stock = GREATEST(stock - v_quantity, 0),
                updated_at = now()
            WHERE id = v_product_id
              AND business_id = p_business_id
              AND track_stock;
          ELSE
            UPDATE public.products
            SET stock = stock - v_quantity,
                updated_at = now()
            WHERE id = v_product_id
              AND business_id = p_business_id
              AND track_stock
              AND item_type <> 'service';
          END IF;
        END IF;
      END LOOP;

      PERFORM set_config('app.stock_effective_at', '', true);
      PERFORM set_config('app.stock_movement_type', '', true);
    END IF;

    RETURN v_sale_id;
  END;
  $$;

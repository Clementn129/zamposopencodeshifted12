-- =====================================================
-- Offline-sale cashier attribution
--
-- `sync_offline_sale` stamps `cashier_id = auth.uid()` — the account that
-- happens to be signed in when the row is pushed. On a shared POS device with
-- shifts this is wrong: cashier A rings a sale offline, logs out, cashier B
-- signs in, and A's sale is credited to B.
--
-- The client now stamps the SELLING cashier's user id into the local sale
-- record, and passes it here as `p_cashier_id`. When it names an ACTIVE
-- cashier of this business we attribute the sale to them instead of the
-- caller. Anything else (null, unknown, inactive, or another business) is
-- ignored and the caller's own id is used — so this cannot be used to steal or
-- forge attribution across tenants.
--
-- Body is otherwise identical to the 20-arg version in
-- 20261012000000_opening_stock_ledger.sql.
-- =====================================================

-- Adding a 21st parameter would otherwise create an OVERLOAD (leaving the old
-- 20-arg function in place and making PostgREST RPC resolution ambiguous), so
-- drop every existing overload by name first.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'sync_offline_sale'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig;
  END LOOP;
END $$;

CREATE FUNCTION public.sync_offline_sale(
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
    p_deduct_stock boolean DEFAULT true,
    p_cashier_id uuid DEFAULT NULL
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
    v_actor uuid;
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
    v_actor := auth.uid();
    v_cashier_id := v_actor;

    -- Honour the SELLING cashier stamped by the device when it names an active
    -- cashier of THIS business (shared-device / shift handover). Otherwise the
    -- caller's own id stands.
    IF p_cashier_id IS NOT NULL AND p_cashier_id <> v_actor THEN
      IF EXISTS (
        SELECT 1 FROM public.business_cashiers bc
        WHERE bc.business_id = p_business_id
          AND bc.auth_user_id = p_cashier_id
          AND bc.is_active = true
      ) THEN
        v_cashier_id := p_cashier_id;
      END IF;
    END IF;

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

-- Cross-tenant sensitive SECURITY DEFINER function: keep EXECUTE off public/anon.
REVOKE EXECUTE ON FUNCTION public.sync_offline_sale(
  uuid, text, jsonb, numeric, numeric, numeric, text, text, timestamptz,
  numeric, numeric, numeric, numeric, text, text, numeric, date, text, uuid, boolean, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_offline_sale(
  uuid, text, jsonb, numeric, numeric, numeric, text, text, timestamptz,
  numeric, numeric, numeric, numeric, text, text, numeric, date, text, uuid, boolean, uuid
) TO authenticated, service_role;

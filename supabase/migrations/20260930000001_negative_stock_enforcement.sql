-- Dynamic Sales: honour businesses.prevent_negative_stock when deducting stock.
--
-- SAFETY PROPERTY
--   prevent_negative_stock defaults to TRUE for all 30 existing businesses, and
--   the TRUE branch below is a byte-for-byte copy of the statements that are
--   running today. Under the default the executed SQL is therefore unchanged --
--   this migration is a no-op for every existing business.
--
--   TRUE  : keep today's GREATEST(..., 0) floor. Stock can never go negative,
--           and no sale is ever rejected (offline replay can never be stranded).
--   FALSE : plain subtraction, so inventory may go negative (opt-in only).
--           Service items are excluded here so they can never be driven below
--           zero by a sale line.
--
-- The flag is fail-closed: declared default true, read with COALESCE(..., true),
-- and a missing business row leaves the variable at true.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. sync_offline_sale  (20 args) -- POS sale path + invoice-to-sale
--    Baseline md5: 68b3663f8892e59959dc070e35a148f2
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
              AND business_id = p_business_id;
          ELSE
            UPDATE public.products
            SET stock = stock - v_quantity,
                updated_at = now()
            WHERE id = v_product_id
              AND business_id = p_business_id
              AND item_type <> 'service';
          END IF;
        END IF;
      END LOOP;
    END IF;

    RETURN v_sale_id;
  END;
  $$;

-- ---------------------------------------------------------------------------
-- 2. deduct_delivery_note_stock  (1 arg) -- delivery note / completion path
--    Baseline md5: 1d5eeedc47f0d5871d78fc59bd575ee7
-- ---------------------------------------------------------------------------
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
  BEGIN
    SELECT business_id INTO v_biz
      FROM public.delivery_notes
     WHERE id = p_dn_id;

    IF v_biz IS NULL THEN
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
       SET stock_deducted = true,
           updated_at = now()
     WHERE id = p_dn_id;
  END;
  $$;

COMMIT;

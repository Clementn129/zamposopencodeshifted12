-- Lean add-on: Cost of Goods + zero-price sales + delivery-note stock sync.
-- Retail logic is untouched: every new behaviour is either additive (a new
-- column / trigger) or gated behind an explicit flag that defaults to today's
-- behaviour.

-- ---------------------------------------------------------------------------
-- 1. Has this delivery note already deducted stock?
--    Default false for existing rows: their stock was never moved, so an
--    invoice paid against them must still deduct (unchanged behaviour).
-- ---------------------------------------------------------------------------
ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS stock_deducted boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. sync_offline_sale gains p_deduct_stock (DEFAULT true).
--
--    The 19-arg signature MUST be dropped before the 20-arg one is created:
--    two same-named functions make PostgREST raise
--      "could not choose best candidate function between public.sync_offline_sale..."
--    This exact outage already happened once (20260904000000).
--
--    Clients send named arguments (Pos.tsx, Debtors.tsx, useSalesSync.ts,
--    usePendingOpsSync.ts) and never pass p_deduct_stock, so it binds to the
--    DEFAULT true -> stock behaves exactly as it does today.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.sync_offline_sale(uuid, text, jsonb, numeric, numeric, numeric, text, text, timestamp with time zone, numeric, numeric, numeric, numeric, text, text, numeric, date, text, uuid);

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
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
      BEGIN
        v_product_id := NULLIF(v_item->>'productId', '')::uuid;
      EXCEPTION WHEN others THEN
        v_product_id := NULL;
      END;
      v_quantity := GREATEST(COALESCE((v_item->>'quantity')::integer, 0), 0);

      IF v_product_id IS NOT NULL AND v_quantity > 0 THEN
        UPDATE public.products
        SET stock = GREATEST(stock - v_quantity, 0),
            updated_at = now()
        WHERE id = v_product_id
          AND business_id = p_business_id;
      END IF;
    END LOOP;
  END IF;

  RETURN v_sale_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_offline_sale(uuid, text, jsonb, numeric, numeric, numeric, text, text, timestamp with time zone, numeric, numeric, numeric, numeric, text, text, numeric, date, text, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_offline_sale(uuid, text, jsonb, numeric, numeric, numeric, text, text, timestamp with time zone, numeric, numeric, numeric, numeric, text, text, numeric, date, text, uuid, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Delivery Note -> stock deduction.
--
--    Fires ONLY on pending -> delivered, so the 26 delivery notes that are
--    already delivered today do not retro-deduct on deploy.
--    The UI exposes "Mark Delivered" only while status = 'pending'
--    (DeliveryNoteList.tsx:78, DeliveryNoteView.tsx:241) and
--    updateDeliveryNoteStatus is only ever called with 'delivered'
--    (DeliveryNoteTab.tsx:67), so each note deducts exactly once.
--    stock_deducted is the hard backstop if a status ever flips again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deduct_stock_on_delivery_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item record;
BEGIN
  -- Already accounted for (e.g. the linked invoice paid first).
  IF COALESCE(NEW.stock_deducted, false) THEN
    RETURN NEW;
  END IF;

  FOR v_item IN
    SELECT dni.product_id, dni.quantity
      FROM public.delivery_note_items dni
     WHERE dni.delivery_note_id = NEW.id
  LOOP
    IF v_item.product_id IS NULL OR COALESCE(v_item.quantity, 0) <= 0 THEN
      CONTINUE;
    END IF;

    UPDATE public.products
       SET stock = GREATEST(stock - v_item.quantity, 0),
           updated_at = now()
     WHERE id = v_item.product_id
       AND business_id = NEW.business_id
       AND item_type <> 'service';
  END LOOP;

  -- Nested UPDATE does not mention `status` in its SET clause, so the
  -- "AFTER UPDATE OF status" trigger below cannot re-fire on it.
  UPDATE public.delivery_notes
     SET stock_deducted = true,
         updated_at = now()
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dn_deduct_stock ON public.delivery_notes;
CREATE TRIGGER trg_dn_deduct_stock
  AFTER UPDATE OF status ON public.delivery_notes
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status = 'delivered')
  EXECUTE FUNCTION public.deduct_stock_on_delivery_note();

-- ---------------------------------------------------------------------------
-- 4. pay_invoice:
--    a) carry costPrice onto the sale so invoice-paid sales show Cost of Goods
--       (it was silently dropped before -> COGS reported 0)
--    b) skip the stock loop when the linked delivery note already deducted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pay_invoice(
  p_invoice_id TEXT,
  p_payment_method TEXT DEFAULT 'cash'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_real UUID;
  v_biz UUID;
  v_status public.invoice_status;
  v_sale_id UUID;
  v_subtotal NUMERIC;
  v_total NUMERIC;
  v_discount_amount NUMERIC;
  v_discount_type TEXT;
  v_tax_amount NUMERIC;
  v_customer_name TEXT;
  v_customer_tpin TEXT;
  v_customer_phone TEXT;
  v_quotation_id UUID;
  v_delivery_note_id UUID;
  v_dn_deducted BOOLEAN := false;
  v_items JSONB;
  v_offline_id TEXT;
BEGIN
  BEGIN
    SELECT id INTO v_real FROM public.invoices WHERE id = p_invoice_id::uuid AND deleted_at IS NULL;
  EXCEPTION WHEN invalid_text_representation THEN
    v_real := NULL;
  END;
  IF v_real IS NULL THEN
    SELECT id INTO v_real FROM public.invoices WHERE offline_id = p_invoice_id AND deleted_at IS NULL;
  END IF;
  IF v_real IS NULL THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  SELECT business_id, status, converted_sale_id, subtotal, total,
         COALESCE(discount_amount, 0), discount_type, COALESCE(tax_amount, 0),
         customer_name, customer_tpin, customer_phone, quotation_id, delivery_note_id
    INTO v_biz, v_status, v_sale_id, v_subtotal, v_total,
         v_discount_amount, v_discount_type, v_tax_amount,
         v_customer_name, v_customer_tpin, v_customer_phone, v_quotation_id, v_delivery_note_id
    FROM public.invoices WHERE id = v_real;

  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_status = 'paid' AND v_sale_id IS NOT NULL THEN
    RETURN v_sale_id;
  END IF;

  IF NOT public.is_business_member(v_biz) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_delivery_note_id IS NOT NULL THEN
    SELECT COALESCE(stock_deducted, false)
      INTO v_dn_deducted
      FROM public.delivery_notes
     WHERE id = v_delivery_note_id;
  END IF;

  -- costPrice is snapshot from products.cost_price at payment time so Cost of
  -- Goods survives onto the sale's items JSONB (Reports.tsx / SalesHistory.tsx).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'productId', ii.product_id,
    'name', ii.product_name,
    'price', ii.unit_price,
    'quantity', ii.quantity,
    'costPrice', COALESCE(p.cost_price, 0),
    'discountType', ii.discount_type,
    'discountValue', ii.discount_value,
    'lineTotal', ii.line_total
  )), '[]'::jsonb) INTO v_items
  FROM public.invoice_items ii
  LEFT JOIN public.products p ON p.id = ii.product_id
  WHERE ii.invoice_id = v_real;

  v_offline_id := 'inv_' || v_real::text;

  -- p_deduct_stock = false when the delivery note already moved the stock.
  v_sale_id := public.sync_offline_sale(
    v_biz, v_offline_id, v_items, v_subtotal, v_total,
    v_discount_amount, v_discount_type, p_payment_method, now(),
    v_tax_amount, 0, 0, 0, v_customer_name, v_customer_tpin,
    v_total, NULL, v_customer_phone, NULL,
    NOT v_dn_deducted
  );

  UPDATE public.invoices
    SET status = 'paid', payment_method = p_payment_method,
        converted_sale_id = v_sale_id, updated_at = now()
    WHERE id = v_real;

  IF v_quotation_id IS NOT NULL THEN
    UPDATE public.quotations
      SET status = 'converted', converted_sale_id = v_sale_id, updated_at = now()
    WHERE id = v_quotation_id;
  END IF;

  IF v_delivery_note_id IS NOT NULL THEN
    -- Stock is now accounted for either way (deducted here, or earlier by the
    -- delivery-note trigger), so lock the flag: nothing may deduct twice.
    UPDATE public.delivery_notes
      SET status = 'invoiced', stock_deducted = true, updated_at = now()
      WHERE id = v_delivery_note_id;
  END IF;

  RETURN v_sale_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pay_invoice(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_invoice(text, text) TO anon;

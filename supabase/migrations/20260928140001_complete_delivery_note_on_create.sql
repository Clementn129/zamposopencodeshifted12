-- Completion at creation time for delivery notes.
--
-- A delivery note saved with "Complete" ticked now does two things in one
-- atomic RPC:
--   1. stock moves (same GREATEST(floor, 0) rule the POS sale path uses)
--   2. a fully-paid cash sale is written to public.sales, so it shows up in
--      Sales History and Reports exactly like a till sale (with costPrice, so
--      Cost of Goods / gross profit are right too).
--
-- "Delivered" is untouched: it still only moves stock. The invoice path is
-- untouched too, except it now refuses to fire against an already-completed
-- delivery note so the same goods can never be sold twice.

-- ---------------------------------------------------------------------------
-- 1. Stock move, extracted so the delivered-trigger and the create-time
--    completion path share one implementation.
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
BEGIN
  SELECT business_id INTO v_biz
    FROM public.delivery_notes
   WHERE id = p_dn_id;

  IF v_biz IS NULL THEN
    RETURN;
  END IF;

  FOR v_item IN
    SELECT dni.product_id, dni.quantity
      FROM public.delivery_note_items dni
     WHERE dni.delivery_note_id = p_dn_id
  LOOP
    IF v_item.product_id IS NULL OR COALESCE(v_item.quantity, 0) <= 0 THEN
      CONTINUE;
    END IF;

    UPDATE public.products
       SET stock = GREATEST(stock - v_item.quantity, 0),
           updated_at = now()
     WHERE id = v_item.product_id
       AND business_id = v_biz
       AND item_type <> 'service';
  END LOOP;

  UPDATE public.delivery_notes
     SET stock_deducted = true,
         updated_at = now()
   WHERE id = p_dn_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The delivered trigger now just calls the helper. Same WHEN clause as
--    before: still pending -> delivered only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deduct_stock_on_delivery_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Already accounted for (e.g. the linked invoice paid first).
  IF COALESCE(NEW.stock_deducted, false) THEN
    RETURN NEW;
  END IF;

  PERFORM public.deduct_delivery_note_stock(NEW.id);

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. create_delivery_note_with_items: after the items are written, if the
--    header asked for 'completed', move stock then record the sale.
--
--    The stock move happens here rather than in a trigger on INSERT because
--    this function inserts the header FIRST and the items in a loop after it
--    -- an AFTER INSERT trigger would fire before any item rows exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_delivery_note_with_items(
  p_business_id UUID,
  p_header JSONB,
  p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id UUID;
  v_number TEXT;
  v_item JSONB;
  v_status public.delivery_note_status;
  v_sale_id UUID;
  v_sale_items JSONB;
  v_subtotal NUMERIC;
  v_customer_name TEXT;
  v_customer_phone TEXT;
BEGIN
  IF NOT public.is_business_member(p_business_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  v_number := public.generate_delivery_note_number(p_business_id);
  v_status := COALESCE((p_header->>'status')::delivery_note_status,
                       'pending'::delivery_note_status);

  INSERT INTO public.delivery_notes (
    business_id, delivery_note_number,
    customer_name, customer_phone, delivery_address,
    driver_name, car_plate, notes, status, quotation_id
  ) VALUES (
    p_business_id, v_number,
    NULLIF(trim(p_header->>'customer_name'), ''),
    NULLIF(trim(p_header->>'customer_phone'), ''),
    NULLIF(trim(p_header->>'delivery_address'), ''),
    NULLIF(trim(p_header->>'driver_name'), ''),
    NULLIF(trim(p_header->>'car_plate'), ''),
    p_header->>'notes',
    v_status,
    NULLIF(p_header->>'quotation_id', '')::uuid
  ) RETURNING id, customer_name, customer_phone
       INTO v_id, v_customer_name, v_customer_phone;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.delivery_note_items (
      delivery_note_id, product_id, product_name, quantity, unit_price, line_total
    ) VALUES (
      v_id,
      NULLIF(v_item->>'product_id', '')::uuid,
      v_item->>'product_name',
      COALESCE((v_item->>'quantity')::int, 1),
      COALESCE((v_item->>'unit_price')::numeric, 0),
      COALESCE((v_item->>'line_total')::numeric, 0)
    );
  END LOOP;

  IF v_status = 'completed' THEN
    -- Stock first, so the sale we are about to write does not move it again.
    PERFORM public.deduct_delivery_note_stock(v_id);

    -- costPrice is snapshotted from products so Cost of Goods and gross
    -- profit in Reports.tsx / SalesHistory.tsx are correct for this sale.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'productId', dni.product_id,
             'name', dni.product_name,
             'price', dni.unit_price,
             'quantity', dni.quantity,
             'costPrice', COALESCE(p.cost_price, 0),
             'discountType', NULL,
             'discountValue', 0,
             'notes', NULL,
             'taxCategory', 'taxable',
             'lineTotal', dni.line_total
           )), '[]'::jsonb),
           COALESCE(SUM(dni.line_total), 0)
      INTO v_sale_items, v_subtotal
      FROM public.delivery_note_items dni
      LEFT JOIN public.products p ON p.id = dni.product_id
     WHERE dni.delivery_note_id = v_id;

    -- Offline id 'dn_<uuid>' makes this idempotent: sync_offline_sale returns
    -- the existing sale instead of writing a second one.
    -- p_amount_paid is left NULL, so the sale is recorded fully paid in cash.
    v_sale_id := public.sync_offline_sale(
      p_business_id, 'dn_' || v_id::text, v_sale_items,
      v_subtotal, v_subtotal,
      0, NULL, 'cash', now(),
      0, 0, 0, 0,
      v_customer_name, NULL,
      NULL, NULL,
      v_customer_phone, NULL,
      false
    );
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_delivery_note_with_items(uuid, jsonb, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. pay_invoice: refuse to bill a delivery note that has already been
--    completed as its own sale -- otherwise the same goods would be counted
--    as revenue twice.
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
  v_dn_status public.delivery_note_status;
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
    SELECT COALESCE(stock_deducted, false), status
      INTO v_dn_deducted, v_dn_status
      FROM public.delivery_notes
     WHERE id = v_delivery_note_id;

    IF v_dn_status = 'completed' THEN
      RAISE EXCEPTION 'This delivery note was already completed as a sale and cannot also be invoiced';
    END IF;
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

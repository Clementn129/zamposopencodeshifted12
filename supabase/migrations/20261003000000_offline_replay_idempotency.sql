-- Offline replay idempotency for create_invoice_with_items and
-- deduct_delivery_note_stock.
--
-- Both functions are reachable from offline replay. A retry (network blip,
-- tab close, crash after the write but before the client could record success)
-- must never apply the same logical operation twice. These changes are purely
-- additive: the first call for a given operation behaves exactly as before.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. create_invoice_with_items
--
--    The client has always passed a stable p_offline_id, but the function only
--    stored it. On retry it wrote a second invoice with the same offline_id.
--    Return the already-created invoice instead.
--    Body is otherwise unchanged from 20260922000000_invoices.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_invoice_with_items(
  p_business_id UUID,
  p_header JSONB,
  p_items JSONB,
  p_offline_id TEXT DEFAULT NULL
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
  v_offline_id TEXT;
BEGIN
  IF NOT public.is_business_member(p_business_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  v_offline_id := NULLIF(trim(p_offline_id), '');

  -- Idempotent replay: the same offline invoice may be pushed more than once.
  IF v_offline_id IS NOT NULL THEN
    SELECT id INTO v_id
      FROM public.invoices
     WHERE business_id = p_business_id
       AND offline_id = v_offline_id
       AND deleted_at IS NULL
     LIMIT 1;

    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  v_number := public.generate_invoice_number(p_business_id);

  INSERT INTO public.invoices (
    business_id, invoice_number, offline_id,
    customer_name, customer_phone, customer_email, customer_tpin,
    subtotal, discount_type, discount_value, discount_amount, tax_amount, total,
    status, issued_date, due_date, notes,
    quotation_id, delivery_note_id
  ) VALUES (
    p_business_id, v_number, v_offline_id,
    NULLIF(trim(p_header->>'customer_name'), ''),
    NULLIF(trim(p_header->>'customer_phone'), ''),
    NULLIF(trim(p_header->>'customer_email'), ''),
    NULLIF(trim(p_header->>'customer_tpin'), ''),
    COALESCE((p_header->>'subtotal')::numeric, 0),
    NULLIF(p_header->>'discount_type', ''),
    COALESCE((p_header->>'discount_value')::numeric, 0),
    COALESCE((p_header->>'discount_amount')::numeric, 0),
    COALESCE((p_header->>'tax_amount')::numeric, 0),
    COALESCE((p_header->>'total')::numeric, 0),
    COALESCE((p_header->>'status')::invoice_status, 'draft'::invoice_status),
    COALESCE(NULLIF(p_header->>'issued_date', '')::date, CURRENT_DATE),
    NULLIF(p_header->>'due_date', '')::date,
    p_header->>'notes',
    NULLIF(p_header->>'quotation_id', '')::uuid,
    NULLIF(p_header->>'delivery_note_id', '')::uuid
  ) RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    INSERT INTO public.invoice_items (
      invoice_id, product_id, product_name, quantity, unit_price,
      discount_type, discount_value, line_total
    ) VALUES (
      v_id,
      NULLIF(v_item->>'product_id', '')::uuid,
      v_item->>'product_name',
      COALESCE((v_item->>'quantity')::int, 1),
      COALESCE((v_item->>'unit_price')::numeric, 0),
      NULLIF(v_item->>'discount_type', ''),
      COALESCE((v_item->>'discount_value')::numeric, 0),
      COALESCE((v_item->>'line_total')::numeric, 0)
    );
  END LOOP;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_invoice_with_items(uuid, jsonb, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. deduct_delivery_note_stock
--
--    Called by the delivery-note trigger and by create_delivery_note_with_items.
--    A concurrent or repeated call could move stock more than once. Lock the
--    delivery note row and no-op when stock was already deducted this way.
--    Body is otherwise unchanged from 20260930000001_negative_stock_enforcement.sql.
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
       SET stock_deducted = true,
           updated_at = now()
     WHERE id = p_dn_id;
  END;
  $$;

COMMIT;

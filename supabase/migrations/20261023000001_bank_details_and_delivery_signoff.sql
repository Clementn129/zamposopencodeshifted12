-- Business bank / payment details shown on quotations, invoices and delivery notes.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS bank_account_name text,
  ADD COLUMN IF NOT EXISTS bank_account_number text,
  ADD COLUMN IF NOT EXISTS bank_branch text,
  ADD COLUMN IF NOT EXISTS bank_swift text;

-- Sign-off names captured on the delivery note.
ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS delivered_by text,
  ADD COLUMN IF NOT EXISTS received_by text;

-- Re-create the create RPC so the new sign-off fields are persisted.
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
    driver_name, car_plate, delivered_by, received_by,
    notes, status, quotation_id
  ) VALUES (
    p_business_id, v_number,
    NULLIF(trim(p_header->>'customer_name'), ''),
    NULLIF(trim(p_header->>'customer_phone'), ''),
    NULLIF(trim(p_header->>'delivery_address'), ''),
    NULLIF(trim(p_header->>'driver_name'), ''),
    NULLIF(trim(p_header->>'car_plate'), ''),
    NULLIF(trim(p_header->>'delivered_by'), ''),
    NULLIF(trim(p_header->>'received_by'), ''),
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

-- =====================================================
-- refund_sale(p_sale_id, p_refund_items)
--
-- Single, atomic refund for a full or partial sale refund.
--
-- WHY: the previous refund was a client-side multi-write
-- (UPDATE sales, then bump products.stock one row at a time).
-- It was non-atomic, recomputed totals without discounts/tax,
-- never restored ingredients, and hit RLS "permission denied"
-- for any non-owner because direct UPDATEs on sales/products
-- are owner-gated.
--
-- This replaces all of that with one SECURITY DEFINER RPC:
--   * owner | manager only (mirrors restock_ingredient etc.)
--   * FOR UPDATE lock on the sale
--   * refund quantities validated against what was bought
--   * totals recomputed proportionally (keeps discount/tax ratio)
--   * returned product stock logged as a 'sale_return' movement
--     linked to the sale (via the stock_movements GUCs used by
--     log_stock_change, same trick as sync_offline_sale)
--   * ingredients restored through adjust_ingredients_for_sale
--     with movement type 'dish_refund'
-- =====================================================

CREATE OR REPLACE FUNCTION public.refund_sale(
  p_sale_id uuid,
  p_refund_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_sale record;
  v_business uuid;
  v_line record;
  v_prod_id uuid;
  v_qty integer;
  v_bought integer;
  v_oi record;
  v_new_qty integer;
  v_price numeric;
  v_refund_qty integer;
  v_new_item jsonb;
  v_new_items jsonb := '[]'::jsonb;
  v_new_subtotal numeric := 0;
  v_refund_amount numeric := 0;
  v_orig_subtotal numeric;
  v_ratio numeric := 0;
  v_new_total numeric := 0;
  v_new_discount numeric := 0;
  v_new_tax numeric := 0;
  v_status text;
  v_refunded jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_sale
    FROM public.sales
   WHERE id = p_sale_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale does not exist';
  END IF;

  v_business := v_sale.business_id;

  -- Authorization: owners and managers only. Cashiers must ask a manager/owner.
  IF NOT (public.owns_business(v_business) OR public.is_manager(v_business)) THEN
    RAISE EXCEPTION 'Not allowed to refund this sale';
  END IF;

  IF v_sale.status = 'refunded' THEN
    RAISE EXCEPTION 'This sale is already fully refunded';
  END IF;

  IF v_sale.status NOT IN ('completed', 'partially_refunded') THEN
    RAISE EXCEPTION 'Sale is not refundable';
  END IF;

  IF COALESCE(p_refund_items, '[]'::jsonb) = '[]'::jsonb THEN
    RAISE EXCEPTION 'No items to refund';
  END IF;

  -- ------------------------------------------------------------------
  -- 1. Validate each requested refund line against what was actually
  --    bought. Tolerant of number/string encodings from the client.
  -- ------------------------------------------------------------------
  FOR v_line IN
    SELECT COALESCE(x.product_id, '') AS pid_t,
           COALESCE(x.quantity, '0')  AS qty_t
      FROM jsonb_to_recordset(p_refund_items) AS x(product_id text, quantity text)
  LOOP
    BEGIN
      v_prod_id := NULLIF(v_line.pid_t, '')::uuid;
      v_qty     := NULLIF(v_line.qty_t, '')::int;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;

    IF v_prod_id IS NULL OR v_qty IS NULL OR v_qty < 1 THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(COUNT(*)::int, 0) INTO v_bought
      FROM jsonb_array_elements(COALESCE(v_sale.items, '[]'::jsonb)) e
     WHERE (e->>'productId')::uuid = v_prod_id;

    IF v_bought = 0 THEN
      RAISE EXCEPTION 'Cannot refund a product that is not on this sale';
    END IF;

    SELECT COALESCE((e->>'quantity')::int, 0) INTO v_bought
      FROM jsonb_array_elements(COALESCE(v_sale.items, '[]'::jsonb)) e
     WHERE (e->>'productId')::uuid = v_prod_id
     LIMIT 1;

    IF v_qty > v_bought THEN
      RAISE EXCEPTION 'Cannot refund more than was purchased (% refunded of % possible)', v_qty, v_bought;
    END IF;

    v_refunded := v_refunded || jsonb_build_object('productId', v_prod_id, 'quantity', v_qty);
  END LOOP;

  IF jsonb_array_length(v_refunded) = 0 THEN
    RAISE EXCEPTION 'No valid items to refund';
  END IF;

  -- ------------------------------------------------------------------
  -- 2. Rebuild the sale line items and totals. Missing quantities are
  --    kept; the discount/tax are scaled down proportionally to what
  --    remains so the stored totals stay coherent.
  -- ------------------------------------------------------------------
  FOR v_oi IN
    SELECT value FROM jsonb_array_elements(COALESCE(v_sale.items, '[]'::jsonb))
  LOOP
    v_prod_id := (v_oi.value->>'productId')::uuid;
    v_qty     := COALESCE((v_oi.value->>'quantity')::int, 0);
    v_price   := COALESCE((v_oi.value->>'price')::numeric, 0);

    v_refund_qty := 0;
    SELECT COALESCE((r->>'quantity')::int, 0) INTO v_refund_qty
      FROM jsonb_array_elements(v_refunded) r
     WHERE (r->>'productId')::uuid = v_prod_id;

    v_new_qty       := v_qty - v_refund_qty;
    v_refund_amount := v_refund_amount + (v_refund_qty * v_price);

    IF v_new_qty > 0 THEN
      v_new_item   := v_oi.value || jsonb_build_object('quantity', v_new_qty);
      v_new_items  := v_new_items || v_new_item;
      v_new_subtotal := v_new_subtotal + (v_new_qty * v_price);
    END IF;
  END LOOP;

  v_orig_subtotal := COALESCE(v_sale.subtotal, 0);
  IF v_orig_subtotal > 0 THEN
    v_ratio      := v_new_subtotal / v_orig_subtotal;
    v_new_total  := GREATEST(ROUND(v_new_subtotal * (COALESCE(v_sale.total, 0) / v_orig_subtotal), 2), 0);
    v_new_discount := ROUND(COALESCE(v_sale.discount_amount, 0) * v_ratio, 2);
    v_new_tax     := ROUND(COALESCE(v_sale.tax_amount, 0) * v_ratio, 2);
  END IF;

  v_status := CASE
    WHEN jsonb_array_length(v_new_items) = 0 THEN 'refunded'
    ELSE 'partially_refunded'
  END;

  -- ------------------------------------------------------------------
  -- 3. Return stock to the products, logged as 'sale_return' movements
  --    linked to this sale via the same GUCs sync_offline_sale uses.
  -- ------------------------------------------------------------------
  PERFORM set_config('app.stock_movement_type', 'sale_return', true);
  PERFORM set_config('app.stock_reference_id', p_sale_id::text, true);
  PERFORM set_config('app.stock_note', 'Refund of sale', true);

  FOR v_line IN
    SELECT value FROM jsonb_array_elements(v_refunded)
  LOOP
    v_prod_id := (v_line.value->>'productId')::uuid;
    v_qty     := (v_line.value->>'quantity')::int;

    UPDATE public.products
       SET stock = stock + v_qty,
           updated_at = now()
     WHERE id = v_prod_id
       AND business_id = v_business
       AND track_stock
       AND item_type <> 'service';
  END LOOP;

  PERFORM set_config('app.stock_movement_type', '', true);
  PERFORM set_config('app.stock_reference_id', '', true);
  PERFORM set_config('app.stock_note', '', true);

  -- ------------------------------------------------------------------
  -- 4. Restore ingredient stock for restaurant dishes (mirrors the
  --    sale-delete trigger, using the dedicated 'dish_refund' type).
  -- ------------------------------------------------------------------
  BEGIN
    PERFORM public.adjust_ingredients_for_sale(v_business, v_refunded, 1, 'dish_refund', p_sale_id);
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'skipped ingredient restore for sale %: %', p_sale_id, SQLERRM;
  END;

  -- ------------------------------------------------------------------
  -- 5. Persist the refunded sale. The set_sale_payment_status trigger
  --    recomputes payment_status/balance_due from the new total.
  -- ------------------------------------------------------------------
  UPDATE public.sales
     SET items = v_new_items,
         subtotal = v_new_subtotal,
         discount_amount = v_new_discount,
         tax_amount = v_new_tax,
         total = v_new_total,
         status = v_status,
         updated_at = now()
   WHERE id = v_sale.id;

  RETURN jsonb_build_object(
    'id', v_sale.id,
    'status', v_status,
    'subtotal', v_new_subtotal,
    'total', v_new_total,
    'refundAmount', v_refund_amount,
    'refunded', v_refunded
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refund_sale(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_sale(uuid, jsonb) TO authenticated, service_role;
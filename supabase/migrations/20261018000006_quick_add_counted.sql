-- =====================================================
-- Quick-added products are now COUNTED
--
-- `quick_add_product` used to create an untracked product (track_stock=false,
-- stock 0), so a quick sale of a brand-new item was never counted and silently
-- bypassed the prevent-negative-stock toggle. It now creates a tracked product
-- whose starting stock is supplied by the cashier (p_stock, default 1), so the
-- same negative-stock rules apply to quick-adds as to any other product.
--
-- Sales that synced before the product existed still reference the client temp
-- id (they deducted nothing because no product matched). Those quantities are
-- subtracted from the starting stock here, honouring prevent_negative_stock,
-- before the items are relinked to the new product id.
--
-- Additive: p_stock has a default, so existing callers keep working.
-- =====================================================

CREATE OR REPLACE FUNCTION public.quick_add_product(
  p_business_id uuid,
  p_name text,
  p_price numeric,
  p_temp_id text DEFAULT NULL::text,
  p_stock integer DEFAULT 1
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_name text;
  v_stock integer;
  v_sold integer := 0;
  v_prevent boolean := true;
BEGIN
  IF NOT public.is_business_member(p_business_id) THEN
    RAISE EXCEPTION 'Not allowed to add products to this business';
  END IF;

  v_name := NULLIF(trim(p_name), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Product name is required';
  END IF;

  v_stock := GREATEST(COALESCE(p_stock, 0), 0);

  -- Sales that synced before this product existed still reference the client
  -- temp id and deducted nothing. Subtract those quantities from the starting
  -- stock now, honouring the business's negative-stock policy.
  IF p_temp_id IS NOT NULL AND left(p_temp_id, 8) = 'offline_' THEN
    SELECT COALESCE(SUM(GREATEST(COALESCE((elem->>'quantity')::integer, 0), 0)), 0)
      INTO v_sold
      FROM public.sales s
      CROSS JOIN LATERAL jsonb_array_elements(s.items) AS elem
     WHERE s.business_id = p_business_id
       AND jsonb_typeof(s.items) = 'array'
       AND elem->>'productId' = p_temp_id;

    IF v_sold > 0 THEN
      SELECT COALESCE(b.prevent_negative_stock, true)
        INTO v_prevent
        FROM public.businesses b
       WHERE b.id = p_business_id;

      v_stock := CASE WHEN COALESCE(v_prevent, true)
                      THEN GREATEST(v_stock - v_sold, 0)
                      ELSE v_stock - v_sold END;
    END IF;
  END IF;

  INSERT INTO public.products (
    business_id, is_active, name, price, cost_price, stock, minimum_stock,
    category, tax_category, barcode, item_type, track_expiry, track_stock,
    image_url, expiry_date
  )
  VALUES (
    p_business_id,
    true,
    v_name,
    GREATEST(COALESCE(p_price, 0), 0),
    NULL,
    v_stock,
    0,
    NULL,
    'taxable',
    NULL,
    'product',
    false,
    true,
    NULL,
    NULL
  )
  RETURNING id INTO v_id;

  -- Relink sales that synced before this product existed. Only ever rewrite
  -- client temp ids (offline_*) and only within this business.
  IF p_temp_id IS NOT NULL AND left(p_temp_id, 8) = 'offline_' THEN
    UPDATE public.sales s
    SET items = (
      SELECT jsonb_agg(
        CASE
          WHEN elem->>'productId' = p_temp_id
            THEN jsonb_set(elem, '{productId}', to_jsonb(v_id::text))
          ELSE elem
        END
      )
      FROM jsonb_array_elements(s.items) AS elem
    )
    WHERE s.business_id = p_business_id
      AND jsonb_typeof(s.items) = 'array'
      AND s.items @> jsonb_build_array(jsonb_build_object('productId', p_temp_id));
  END IF;

  RETURN v_id;
END;
$function$;

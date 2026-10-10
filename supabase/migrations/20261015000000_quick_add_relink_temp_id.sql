-- Quick Sale for cashiers (see 20260930000003_quick_add_product.sql).
--
-- Offline quick-adds mint a client temp id (offline_...) and queue a
-- product_create op. Sales sync on a separate path and copy the temp id into
-- sales.items verbatim. When the op later succeeds, the product is created
-- with a NEW uuid, so those already-synced sales keep pointing at the temp id
-- forever and never show up against the real product.
--
-- This adds an optional p_temp_id so the replay can relink any sales that
-- referenced the temp id. The old 3-arg overload is dropped so PostgREST
-- resolves a single function (otherwise the defaulted 4-arg overload would be
-- ambiguous).

CREATE OR REPLACE FUNCTION public.quick_add_product(
  p_business_id uuid,
  p_name text,
  p_price numeric,
  p_temp_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id uuid;
  v_name text;
BEGIN
  IF NOT public.is_business_member(p_business_id) THEN
    RAISE EXCEPTION 'Not allowed to add products to this business';
  END IF;

  v_name := NULLIF(trim(p_name), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Product name is required';
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
    0,
    0,
    NULL,
    'taxable',
    NULL,
    'product',
    false,
    false,
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
$fn$;

-- Remove the superseded 3-arg overload.
DROP FUNCTION IF EXISTS public.quick_add_product(uuid, text, numeric);

REVOKE ALL ON FUNCTION public.quick_add_product(uuid, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quick_add_product(uuid, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quick_add_product(uuid, text, numeric, text) TO service_role;

COMMENT ON FUNCTION public.quick_add_product(uuid, text, numeric, text) is
  'Quick Sale: lets a business member create an untracked stock-0 product and relink any sales that referenced its offline temp id.';

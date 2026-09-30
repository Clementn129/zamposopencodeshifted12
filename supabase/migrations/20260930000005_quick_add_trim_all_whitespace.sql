BEGIN;

-- quick_add_product rejected blank names with NULLIF(trim(p_name), ''), but
-- PostgreSQL's trim() only strips ASCII spaces. A name of just tabs/newlines
-- survived it and created a product with an invisible name. The UI already
-- blocks this with JavaScript's trim(), so the gap was only reachable by
-- calling the RPC directly -- but the guard should match its own intent.
-- Same signature, same LANGUAGE/SECURITY/search_path, grants unchanged.
CREATE OR REPLACE FUNCTION public.quick_add_product(p_business_id uuid, p_name text, p_price numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  DECLARE
    v_id uuid;
    v_name text;
  BEGIN
    IF NOT public.is_business_member(p_business_id) THEN
      RAISE EXCEPTION 'Not allowed to add products to this business';
    END IF;

    v_name := NULLIF(regexp_replace(coalesce(p_name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
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

    RETURN v_id;
  END;
  $function$;

GRANT EXECUTE ON FUNCTION public.quick_add_product(uuid, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quick_add_product(uuid, text, numeric) TO service_role;
REVOKE ALL ON FUNCTION public.quick_add_product(uuid, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.quick_add_product(uuid, text, numeric) FROM anon;

COMMIT;

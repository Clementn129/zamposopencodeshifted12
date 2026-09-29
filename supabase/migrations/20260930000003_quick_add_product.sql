-- Quick Sale for cashiers: products INSERT is RLS owner-only, so a cashier
-- cannot create a product directly (Products already hides "Add Product" from
-- them). This narrow function lets any *member* of the business create exactly
-- one shape of row: an untracked, stock-0, non-service product.
--
-- Deliberately NOT a general product-create:
--   * membership checked via is_business_member (owner or active cashier)
--   * item_type forced to 'product', track_stock forced to false,
--     stock forced to 0  ->  no inventory is ever handed to a cashier
--   * no barcode / category / image / expiry, so it cannot shadow a real SKU
--
-- SECURITY DEFINER so it runs with the owner's rights and bypasses the
-- owner-only INSERT policy on public.products.
BEGIN;

CREATE OR REPLACE FUNCTION public.quick_add_product(
    p_business_id uuid,
    p_name text,
    p_price numeric
  )
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
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

    RETURN v_id;
  END;
  $fn$;

REVOKE ALL ON FUNCTION public.quick_add_product(uuid, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quick_add_product(uuid, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quick_add_product(uuid, text, numeric) TO service_role;

COMMENT ON FUNCTION public.quick_add_product(uuid, text, numeric) is
  'Quick Sale: lets a business member create an untracked stock-0 product.';

COMMIT;

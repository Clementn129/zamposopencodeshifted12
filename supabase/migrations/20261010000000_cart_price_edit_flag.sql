-- Per-business opt-in: allow a cashier to override a line's unit price in the POS cart.
-- Off by default for every new business; businesses that have already used the
-- feature keep it on so their workflow does not change.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS allow_cart_price_edit BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.businesses.allow_cart_price_edit IS
  'When true, the POS cart shows an editable unit-price box on each line. Off by default.';

-- Grandfather the businesses that have ever sold a line at a price different
-- from its catalogue price (price <> catalogPrice on a saved sale item).
UPDATE public.businesses b
SET allow_cart_price_edit = true
WHERE EXISTS (
  SELECT 1
  FROM public.sales s
  WHERE s.business_id = b.id
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(s.items) it
      WHERE (it->>'catalogPrice') IS NOT NULL
        AND (it->>'price')::numeric <> (it->>'catalogPrice')::numeric
    )
);

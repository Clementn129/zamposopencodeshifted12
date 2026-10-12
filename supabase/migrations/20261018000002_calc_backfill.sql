-- =====================================================
-- calc_backfill — reconcile already-damaged sale totals
--
-- One-time repair for sales whose stored totals were written by the previous
-- discount-blind EditSaleModal (gross recompute that dropped the discount and
-- bumped `total` without updating `tax_amount`), and any sale whose
-- `discount_amount` drifted from what its own items actually charged.
--
-- For every non-empty completed/partial sale we recompute from the items
-- themselves:
--
--   subtotal      = Σ price * quantity               (gross, stored semantic)
--   discount      = Σ (price − finalSalePrice) qty   (0 when finalSalePrice
--                     is absent — legacy items were charged at gross price)
--   net           = Σ finalSalePrice * quantity      (fallback price)
--   tax_amount    = net × (stored tax ÷ old net)     (keeps the sale's own rate)
--   taxable/zero/exempt amounts scale proportionally
--   total         = net + tax_amount
--
-- Correct sales are a no-op by construction: POS-checked-out rows already
-- satisfy subtotal ≈ Σ gross, discount ≈ Σ(price − final), total ≈ net + tax,
-- so the write guard (diff > 0.01) prevents touching them.
--
-- Idempotent: re-running changes nothing once totals are consistent.
-- =====================================================

DO $$
DECLARE
  r record;
  v_gross numeric := 0;
  v_net numeric := 0;
  v_discount numeric := 0;
  v_old_net numeric := 0;
  v_rate numeric := 0;
  v_new_tax numeric := 0;
  v_ratio numeric := 1;
  v_new_taxable numeric := 0;
  v_new_zero numeric := 0;
  v_new_exempt numeric := 0;
  v_new_total numeric := 0;
BEGIN
  FOR r IN
    SELECT id, items, subtotal, discount_amount, tax_amount,
           COALESCE(taxable_amount, 0) AS taxable_amount,
           COALESCE(zero_rated_amount, 0) AS zero_rated_amount,
           COALESCE(exempt_amount, 0) AS exempt_amount,
           total
      FROM public.sales
     WHERE items IS NOT NULL
       AND jsonb_typeof(items) = 'array'
       AND jsonb_array_length(items) > 0
       AND status IN ('completed', 'partially_refunded')
     ORDER BY id
  LOOP
    SELECT COALESCE(SUM(x.gross), 0), COALESCE(SUM(x.net), 0)
      INTO v_gross, v_net
      FROM (
        SELECT (e->>'price')::numeric * (e->>'quantity')::int AS gross,
               (COALESCE(e->>'finalSalePrice', e->>'price'))::numeric
                 * (e->>'quantity')::int AS net
          FROM jsonb_array_elements(r.items) AS e
         WHERE (e->>'price') IS NOT NULL
      ) AS x;

    v_gross    := ROUND(v_gross, 2);
    v_net      := ROUND(v_net, 2);
    v_discount := ROUND(v_gross - v_net, 2);

    v_old_net := COALESCE(r.subtotal, 0) - COALESCE(r.discount_amount, 0);

    IF v_old_net > 0 THEN
      v_rate := COALESCE(r.tax_amount, 0) / v_old_net;
      v_ratio := v_net / v_old_net;
    ELSE
      v_rate := 0;
    END IF;

    v_new_tax    := ROUND(v_net * v_rate, 2);
    v_new_taxable := ROUND(COALESCE(r.taxable_amount, 0) * v_ratio, 2);
    v_new_zero    := ROUND(COALESCE(r.zero_rated_amount, 0) * v_ratio, 2);
    v_new_exempt  := ROUND(COALESCE(r.exempt_amount, 0) * v_ratio, 2);
    v_new_total   := ROUND(v_net + v_new_tax, 2);

    IF ABS(ROUND(COALESCE(r.subtotal, 0), 2) - v_gross) > 0.01
       OR ABS(ROUND(COALESCE(r.discount_amount, 0), 2) - v_discount) > 0.01
       OR ABS(ROUND(COALESCE(r.tax_amount, 0), 2) - v_new_tax) > 0.01
       OR ABS(ROUND(COALESCE(r.total, 0), 2) - v_new_total) > 0.01
    THEN
      UPDATE public.sales
         SET subtotal = v_gross,
             discount_amount = v_discount,
             tax_amount = v_new_tax,
             taxable_amount = v_new_taxable,
             zero_rated_amount = v_new_zero,
             exempt_amount = v_new_exempt,
             total = v_new_total
       WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
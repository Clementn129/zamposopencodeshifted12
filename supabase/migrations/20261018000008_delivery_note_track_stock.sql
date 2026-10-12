-- =====================================================
-- Delivery notes must respect track_stock
--
-- `deduct_delivery_note_stock` deducted every non-service line, including
-- products with track_stock = false (dishes, and previously quick-adds),
-- which drifted those products' stock and disagreed with `sync_offline_sale`
-- (which already filters on track_stock). Add `AND track_stock` to both
-- branches so delivery notes and POS sales agree.
-- =====================================================

CREATE OR REPLACE FUNCTION public.deduct_delivery_note_stock(p_dn_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- Only a member of the owning business may move its stock.
    IF NOT public.is_business_member(v_biz) THEN
      RAISE EXCEPTION 'not authorized';
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
           AND track_stock
           AND item_type <> 'service';
      ELSE
        UPDATE public.products
           SET stock = stock - v_item.quantity,
               updated_at = now()
         WHERE id = v_item.product_id
           AND business_id = v_biz
           AND track_stock
           AND item_type <> 'service';
      END IF;
    END LOOP;

    UPDATE public.delivery_notes
       SET stock_deducted = true
     WHERE id = p_dn_id;
  END;
$function$;

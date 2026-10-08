-- Trigger to capture stock changes
BEGIN;

CREATE OR REPLACE FUNCTION public.log_stock_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old integer := COALESCE(OLD.stock, 0);
  v_new integer := COALESCE(NEW.stock, 0);
  v_delta integer := v_new - v_old;
  v_mtype text := 'manual_edit';
  v_ref_type text := NULL;
  v_ref_id uuid := NULL;
  v_note text := NULL;
  v_actor_id uuid := NULL;
  v_actor_name text := NULL;
BEGIN
  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  v_actor_id := auth.uid();

  IF TG_NAME = 'on_products_stock_after_update' THEN
    v_mtype := 'manual_edit';
  END IF;

  INSERT INTO public.stock_movements (
    business_id, product_id, delta, quantity_after, movement_type,
    reference_type, reference_id, note, actor_id, actor_name
  ) VALUES (
    NEW.business_id, NEW.id, v_delta, v_new, v_mtype,
    v_ref_type, v_ref_id, v_note, v_actor_id, v_actor_name
  );
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER on_products_stock_after_update
    AFTER UPDATE OF stock ON public.products
    FOR EACH ROW
    WHEN (OLD.stock IS DISTINCT FROM NEW.stock)
    EXECUTE FUNCTION public.log_stock_change();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;

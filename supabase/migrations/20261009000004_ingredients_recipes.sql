-- Phase C: Ingredients, recipes, automatic ingredient deduction on dish sales,
-- and dish costing.
--
--   * ingredients          - purchasable stock kept in smallest units (ints).
--   * recipe_ingredients   - how much of each ingredient goes into a dish.
--   * ingredient_stock_movements - immutable ledger mirroring stock_movements.
--   * products.is_dish     - marks recipe-based items; they do not track their
--                            own stock (POS sets track_stock=false for dishes).
--
-- Triggers:
--   * On sales INSERT, deduct ingredients for every dish line (restaurant only,
--     exception-wrapped so a deduction never fails the sale).
--   * On sales DELETE, restore the deducted ingredients.
--   * On recipe change or ingredient unit-cost change, recompute the dish cost
--     into products.cost_price (which POS already snapshots into sales.items).
--
-- Additive and backwards-compatible: existing data is untouched and the tables
-- are inert until a business actually creates ingredients/recipes.

-- ---------------------------------------------------------------------------
-- is_manager helper (idempotent: also shipped in 20261009000003).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_manager(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.business_cashiers c
    WHERE c.business_id = p_business_id
      AND c.auth_user_id = auth.uid()
      AND c.is_active = true
      AND c.role = 'manager'
  );
$$;

-- ---------------------------------------------------------------------------
-- 1. ingredients
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingredients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'g',
  stock INTEGER NOT NULL DEFAULT 0,
  cost_per_unit NUMERIC(12, 4) NOT NULL DEFAULT 0,
  low_stock_warning INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingredients_business ON public.ingredients (business_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_business_active ON public.ingredients (business_id, is_active);

ALTER TABLE public.ingredients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ingredients read for members" ON public.ingredients;
CREATE POLICY "Ingredients read for members"
  ON public.ingredients FOR SELECT
  TO authenticated
  USING (public.is_business_member(business_id));

DROP POLICY IF EXISTS "Ingredients managed by owner" ON public.ingredients;
CREATE POLICY "Ingredients managed by owner"
  ON public.ingredients FOR ALL
  TO authenticated
  USING (public.owns_business(business_id))
  WITH CHECK (public.owns_business(business_id));

DROP POLICY IF EXISTS "Ingredients managed by manager" ON public.ingredients;
CREATE POLICY "Ingredients managed by manager"
  ON public.ingredients FOR ALL
  TO authenticated
  USING (public.is_manager(business_id))
  WITH CHECK (public.is_manager(business_id));

-- ---------------------------------------------------------------------------
-- 2. recipe_ingredients
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recipe_ingredients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, ingredient_id)
);

CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_product ON public.recipe_ingredients (product_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_ingredient ON public.recipe_ingredients (ingredient_id);

ALTER TABLE public.recipe_ingredients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Recipes read for members" ON public.recipe_ingredients;
CREATE POLICY "Recipes read for members"
  ON public.recipe_ingredients FOR SELECT
  TO authenticated
  USING (public.is_business_member(business_id));

DROP POLICY IF EXISTS "Recipes managed by owner" ON public.recipe_ingredients;
CREATE POLICY "Recipes managed by owner"
  ON public.recipe_ingredients FOR ALL
  TO authenticated
  USING (public.owns_business(business_id))
  WITH CHECK (public.owns_business(business_id));

DROP POLICY IF EXISTS "Recipes managed by manager" ON public.recipe_ingredients;
CREATE POLICY "Recipes managed by manager"
  ON public.recipe_ingredients FOR ALL
  TO authenticated
  USING (public.is_manager(business_id))
  WITH CHECK (public.is_manager(business_id));

-- ---------------------------------------------------------------------------
-- 3. ingredient_stock_movements ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingredient_stock_movements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'purchase','dish_sale','dish_refund','sale_delete',
    'adjustment_add','adjustment_remove','manual_edit','other'
  )),
  reference_type TEXT NULL,
  reference_id UUID NULL,
  note TEXT NULL,
  actor_id UUID NULL,
  actor_name TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingredient_movements_business_created ON public.ingredient_stock_movements (business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ingredient_movements_ingredient_created ON public.ingredient_stock_movements (ingredient_id, created_at);

COMMENT ON TABLE public.ingredient_stock_movements IS 'Immutable audit trail of ingredients.stock';
COMMENT ON COLUMN public.ingredient_stock_movements.delta IS 'Positive = in, negative = out';
COMMENT ON COLUMN public.ingredient_stock_movements.quantity_after IS 'ingredients.stock value immediately after';
COMMENT ON COLUMN public.ingredient_stock_movements.reference_type IS 'sale, product, etc.';

ALTER TABLE public.ingredient_stock_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ingredient movements read for members" ON public.ingredient_stock_movements;
CREATE POLICY "Ingredient movements read for members"
  ON public.ingredient_stock_movements FOR SELECT
  TO authenticated
  USING (public.is_business_member(business_id));

DROP POLICY IF EXISTS "Ingredient movements managed by owner" ON public.ingredient_stock_movements;
CREATE POLICY "Ingredient movements managed by owner"
  ON public.ingredient_stock_movements FOR ALL
  TO authenticated
  USING (public.owns_business(business_id))
  WITH CHECK (public.owns_business(business_id));

DROP POLICY IF EXISTS "Ingredient movements managed by manager" ON public.ingredient_stock_movements;
CREATE POLICY "Ingredient movements managed by manager"
  ON public.ingredient_stock_movements FOR ALL
  TO authenticated
  USING (public.is_manager(business_id))
  WITH CHECK (public.is_manager(business_id));

-- ---------------------------------------------------------------------------
-- 4. products.is_dish
-- ---------------------------------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_dish BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 5. Dish costing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_dish_cost(p_product_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF p_product_id IS NOT NULL THEN
    UPDATE public.products p
    SET cost_price = COALESCE((
          SELECT SUM(ri.quantity * i.cost_per_unit)
          FROM public.recipe_ingredients ri
          JOIN public.ingredients i ON i.id = ri.ingredient_id
          WHERE ri.product_id = p.id
        ), 0),
        updated_at = now()
    WHERE p.id = p_product_id;
  ELSE
    UPDATE public.products p
    SET cost_price = COALESCE((
          SELECT SUM(ri.quantity * i.cost_per_unit)
          FROM public.recipe_ingredients ri
          JOIN public.ingredients i ON i.id = ri.ingredient_id
          WHERE ri.product_id = p.id
        ), 0),
        updated_at = now()
    WHERE p.is_dish = true;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recompute_dish_cost(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_dish_cost(uuid) TO service_role;

-- Recompute the affected dish whenever its recipe changes.
CREATE OR REPLACE FUNCTION public.recompute_dish_cost_on_recipe_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_product uuid;
BEGIN
  v_product := COALESCE(NEW.product_id, OLD.product_id);
  IF v_product IS NOT NULL THEN
    PERFORM public.recompute_dish_cost(v_product);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_dish_cost_recipe ON public.recipe_ingredients;
CREATE TRIGGER trg_recompute_dish_cost_recipe
  AFTER INSERT OR UPDATE OR DELETE ON public.recipe_ingredients
  FOR EACH ROW EXECUTE FUNCTION public.recompute_dish_cost_on_recipe_change();

-- Recompute all dishes that use an ingredient whose unit cost changed.
CREATE OR REPLACE FUNCTION public.recompute_dish_cost_on_ingredient_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  PERFORM public.recompute_dish_cost(p.id)
  FROM public.products p
  WHERE p.is_dish = true
    AND EXISTS (
      SELECT 1 FROM public.recipe_ingredients ri
      WHERE ri.product_id = p.id AND ri.ingredient_id = NEW.id AND ri.quantity > 0
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_dish_cost_ingredient ON public.ingredients;
CREATE TRIGGER trg_recompute_dish_cost_ingredient
  AFTER UPDATE OF cost_per_unit ON public.ingredients
  FOR EACH ROW EXECUTE FUNCTION public.recompute_dish_cost_on_ingredient_cost();

-- ---------------------------------------------------------------------------
-- 6. Ingredient deduction on dish sale + restore on sale delete
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_ingredients_for_sale(
  p_business_id uuid,
  p_items jsonb,
  p_direction integer,
  p_movement_type text,
  p_reference_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_item jsonb;
  v_product uuid;
  v_qty integer;
  v_recipe record;
  v_after integer;
  v_business_type text;
BEGIN
  SELECT business_type INTO v_business_type FROM public.businesses WHERE id = p_business_id;
  IF v_business_type <> 'restaurant' OR jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
    RETURN;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    v_product := (v_item->>'productId')::uuid;
    v_qty := COALESCE((v_item->>'quantity')::integer, 0);
    IF v_product IS NULL OR v_qty <= 0 THEN
      CONTINUE;
    END IF;
    FOR v_recipe IN
      SELECT ri.ingredient_id, ri.quantity AS per_serving, i.cost_per_unit
      FROM public.recipe_ingredients ri
      JOIN public.ingredients i ON i.id = ri.ingredient_id
      WHERE ri.product_id = v_product AND ri.quantity > 0
    LOOP
      UPDATE public.ingredients
      SET stock = stock + (p_direction * v_recipe.per_serving * v_qty),
          updated_at = now()
      WHERE id = v_recipe.ingredient_id
      RETURNING stock INTO v_after;
      INSERT INTO public.ingredient_stock_movements (
        business_id, ingredient_id, delta, quantity_after,
        movement_type, reference_type, reference_id, actor_id, actor_name
      ) VALUES (
        p_business_id, v_recipe.ingredient_id, p_direction * v_recipe.per_serving * v_qty,
        v_after, p_movement_type, 'sale', p_reference_id, auth.uid(), COALESCE(auth.jwt()->>'email', '')
      );
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.deduct_ingredients_on_sale_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  BEGIN
    PERFORM public.adjust_ingredients_for_sale(
      NEW.business_id, NEW.items, -1, 'dish_sale', NEW.id
    );
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'skipped ingredient deduction for sale %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deduct_ingredients_on_sale ON public.sales;
CREATE TRIGGER trg_deduct_ingredients_on_sale
  AFTER INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.deduct_ingredients_on_sale_insert();

CREATE OR REPLACE FUNCTION public.restore_ingredients_on_sale_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  BEGIN
    PERFORM public.adjust_ingredients_for_sale(
      OLD.business_id, OLD.items, 1, 'sale_delete', OLD.id
    );
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'skipped ingredient restore for sale %: %', OLD.id, SQLERRM;
  END;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_restore_ingredients_on_sale_delete ON public.sales;
CREATE TRIGGER trg_restore_ingredients_on_sale_delete
  AFTER DELETE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.restore_ingredients_on_sale_delete();

-- ---------------------------------------------------------------------------
-- 7. Quick restock RPC: bumps stock, records the purchase, optionally updates
--    the unit cost (owners / managers only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restock_ingredient(
  p_ingredient_id uuid,
  p_quantity integer,
  p_unit_cost numeric DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_business uuid;
  v_after integer;
BEGIN
  SELECT business_id INTO v_business FROM public.ingredients WHERE id = p_ingredient_id;
  IF v_business IS NULL THEN
    RAISE EXCEPTION 'Ingredient not found';
  END IF;
  IF NOT (public.owns_business(v_business) OR public.is_manager(v_business)) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  UPDATE public.ingredients
  SET stock = stock + p_quantity,
      cost_per_unit = COALESCE(p_unit_cost, cost_per_unit),
      updated_at = now()
  WHERE id = p_ingredient_id
  RETURNING stock INTO v_after;

  INSERT INTO public.ingredient_stock_movements (
    business_id, ingredient_id, delta, quantity_after,
    movement_type, note, actor_id, actor_name
  ) VALUES (
    v_business, p_ingredient_id, p_quantity, v_after,
    'purchase', NULL, auth.uid(), COALESCE(auth.jwt()->>'email', '')
  );

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.restock_ingredient(uuid, integer, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restock_ingredient(uuid, integer, numeric) TO service_role;

-- Live low-ingredient warnings for the kitchen/menu screens.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ingredients;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
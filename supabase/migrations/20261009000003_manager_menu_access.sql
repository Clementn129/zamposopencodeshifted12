-- Manager menu & stock access.
--
-- Managers run the shop: menu (products, categories, modifiers, dining tables,
-- product images) and stock. They are NOT owners: settings, reports, debtors,
-- subscription and other admin pages stay owner/super-admin only (enforced in
-- the client by RequireOwner). Everything here is additive; owner policies are
-- untouched, and the new permissive "managers can ..." policies OR with them.
--
-- Also fixes a latent GRANT bug: dining_tables was only ever granted SELECT to
-- `authenticated`, so owner table add/edit/delete silently failed at the
-- PostgREST layer despite the RLS policy. Managers need write access here too.

-- ---------------------------------------------------------------------------
-- 1. is_manager() helper: an active business_cashiers row with role 'manager'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_manager(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.business_cashiers
    WHERE business_id = p_business_id
      AND auth_user_id = auth.uid()
      AND is_active = true
      AND role = 'manager'
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Fix dining_tables GRANT so authenticated users can actually write.
-- ---------------------------------------------------------------------------
GRANT INSERT, UPDATE, DELETE ON public.dining_tables TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. products: managers can create / edit / delete menu items.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Managers can insert products" ON public.products;
CREATE POLICY "Managers can insert products" ON public.products FOR INSERT
  TO authenticated
  WITH CHECK (public.is_manager(business_id));

DROP POLICY IF EXISTS "Managers can update products" ON public.products;
CREATE POLICY "Managers can update products" ON public.products FOR UPDATE
  TO authenticated
  USING (public.is_manager(business_id))
  WITH CHECK (public.is_manager(business_id));

DROP POLICY IF EXISTS "Managers can delete products" ON public.products;
CREATE POLICY "Managers can delete products" ON public.products FOR DELETE
  TO authenticated
  USING (public.is_manager(business_id));

-- ---------------------------------------------------------------------------
-- 4. product_categories: managers can manage categories.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Managers can insert categories" ON public.product_categories;
CREATE POLICY "Managers can insert categories" ON public.product_categories FOR INSERT
  TO authenticated
  WITH CHECK (public.is_manager(business_id));

DROP POLICY IF EXISTS "Managers can update categories" ON public.product_categories;
CREATE POLICY "Managers can update categories" ON public.product_categories FOR UPDATE
  TO authenticated
  USING (public.is_manager(business_id))
  WITH CHECK (public.is_manager(business_id));

DROP POLICY IF EXISTS "Managers can delete categories" ON public.product_categories;
CREATE POLICY "Managers can delete categories" ON public.product_categories FOR DELETE
  TO authenticated
  USING (public.is_manager(business_id));

-- ---------------------------------------------------------------------------
-- 5. menu_modifier_groups / menu_modifiers / menu_item_modifiers.
-- Mirror the owner policies (modifier rows must reference a group in the same
-- business) but use is_manager().
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Managers can insert modifier groups" ON public.menu_modifier_groups;
CREATE POLICY "Managers can insert modifier groups" ON public.menu_modifier_groups FOR INSERT
  TO authenticated
  WITH CHECK (public.is_manager(business_id));

DROP POLICY IF EXISTS "Managers can update modifier groups" ON public.menu_modifier_groups;
CREATE POLICY "Managers can update modifier groups" ON public.menu_modifier_groups FOR UPDATE
  TO authenticated
  USING (public.is_manager(business_id))
  WITH CHECK (public.is_manager(business_id));

DROP POLICY IF EXISTS "Managers can delete modifier groups" ON public.menu_modifier_groups;
CREATE POLICY "Managers can delete modifier groups" ON public.menu_modifier_groups FOR DELETE
  TO authenticated
  USING (public.is_manager(business_id));

DROP POLICY IF EXISTS "Managers can insert modifiers" ON public.menu_modifiers;
CREATE POLICY "Managers can insert modifiers" ON public.menu_modifiers FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_manager(business_id)
    AND EXISTS (SELECT 1 FROM public.menu_modifier_groups g WHERE g.id = group_id AND g.business_id = business_id)
  );

DROP POLICY IF EXISTS "Managers can update modifiers" ON public.menu_modifiers;
CREATE POLICY "Managers can update modifiers" ON public.menu_modifiers FOR UPDATE
  TO authenticated
  USING (public.is_manager(business_id))
  WITH CHECK (
    public.is_manager(business_id)
    AND EXISTS (SELECT 1 FROM public.menu_modifier_groups g WHERE g.id = group_id AND g.business_id = business_id)
  );

DROP POLICY IF EXISTS "Managers can delete modifiers" ON public.menu_modifiers;
CREATE POLICY "Managers can delete modifiers" ON public.menu_modifiers FOR DELETE
  TO authenticated
  USING (public.is_manager(business_id));

DROP POLICY IF EXISTS "Managers can link menu item modifiers" ON public.menu_item_modifiers;
CREATE POLICY "Managers can link menu item modifiers" ON public.menu_item_modifiers FOR INSERT
  TO authenticated
  WITH CHECK (public.is_manager(business_id));

DROP POLICY IF EXISTS "Managers can unlink menu item modifiers" ON public.menu_item_modifiers;
CREATE POLICY "Managers can unlink menu item modifiers" ON public.menu_item_modifiers FOR DELETE
  TO authenticated
  USING (public.is_manager(business_id));

-- ---------------------------------------------------------------------------
-- 6. dining_tables: managers can manage the floor plan.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Managers can manage dining tables" ON public.dining_tables;
CREATE POLICY "Managers can manage dining tables" ON public.dining_tables FOR ALL
  TO authenticated
  USING (public.is_manager(business_id))
  WITH CHECK (public.is_manager(business_id));

-- ---------------------------------------------------------------------------
-- 7. product images (storage 'product-images' bucket, first path = business).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Managers can upload product images" ON storage.objects;
CREATE POLICY "Managers can upload product images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'product-images'
    AND public.is_manager((storage.foldername(name))[1]::uuid)
  );

DROP POLICY IF EXISTS "Managers can update product images" ON storage.objects;
CREATE POLICY "Managers can update product images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND public.is_manager((storage.foldername(name))[1]::uuid)
  )
  WITH CHECK (
    bucket_id = 'product-images'
    AND public.is_manager((storage.foldername(name))[1]::uuid)
  );

DROP POLICY IF EXISTS "Managers can delete product images" ON storage.objects;
CREATE POLICY "Managers can delete product images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND public.is_manager((storage.foldername(name))[1]::uuid)
  );
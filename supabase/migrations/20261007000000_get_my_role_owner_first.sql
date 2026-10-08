-- Fix: get_my_role() checked business_cashiers BEFORE businesses, so an owner
-- who also had an active cashier row (e.g. from testing cashier login) resolved
-- as 'cashier' and was bounced to /pos on every refresh. Owners now resolve
-- before any cashier/staff branch. super_admin still wins.
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN public.has_role(auth.uid(), 'super_admin') THEN 'super_admin'
    WHEN EXISTS (SELECT 1 FROM public.businesses WHERE user_id = auth.uid()) THEN 'owner'
    WHEN (SELECT role FROM public.business_cashiers
          WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1) = 'manager' THEN 'manager'
    WHEN (SELECT role FROM public.business_cashiers
          WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1) = 'kitchen_staff' THEN 'kitchen_staff'
    WHEN EXISTS (SELECT 1 FROM public.business_cashiers WHERE auth_user_id = auth.uid() AND is_active = true) THEN 'cashier'
    ELSE 'unknown'
  END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;

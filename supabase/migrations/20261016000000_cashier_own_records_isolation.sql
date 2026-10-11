-- =====================================================
-- Per-cashier record isolation
--
-- Before this migration every member of a business (owner, manager, kitchen
-- staff and cashier) could SELECT every row of `sales`, `sale_payments` and
-- `stock_adjustment_requests`. A cashier could therefore read a colleague's
-- records directly through the API — the "My Sales" screen is not a real
-- privacy boundary on its own.
--
-- This migration narrows those three SELECT policies so that an account whose
-- role is 'cashier' sees only the records it created, while owners, super
-- admins, managers and kitchen staff keep full business-wide access. INSERT /
-- UPDATE / DELETE policies are untouched.
--
-- Isolation is role-based (business_cashiers.role), not "is not an owner":
-- managers and kitchen staff also have business_cashiers rows but must keep
-- seeing the whole business.
-- =====================================================

-- ---------------------------------------------------------------------------
-- Helper: true only when the caller is an ACTIVE cashier (role = 'cashier')
-- of the given business. SECURITY DEFINER (like is_business_member /
-- owns_business) so policies may consult business_cashiers without recursing
-- into its own RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_plain_cashier(_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.business_cashiers bc
    WHERE bc.business_id = _business_id
      AND bc.auth_user_id = auth.uid()
      AND bc.is_active = true
      AND bc.role = 'cashier'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_plain_cashier(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_plain_cashier(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- sales: a cashier sees only the sales they personally created.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Members can view sales" ON public.sales;
CREATE POLICY "Members can view sales" ON public.sales
FOR SELECT
USING (
  public.is_business_member(business_id)
  AND (
    NOT public.is_plain_cashier(business_id)
    OR cashier_id = auth.uid()
  )
);

-- ---------------------------------------------------------------------------
-- sale_payments: a cashier sees only payments made against their own sales.
-- (The EXISTS sub-query is itself filtered by the sales SELECT policy above,
-- so for a cashier it can only resolve to their own sale ids.)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Members can view sale payments" ON public.sale_payments;
CREATE POLICY "Members can view sale payments" ON public.sale_payments
FOR SELECT
USING (
  public.is_business_member(business_id)
  AND (
    NOT public.is_plain_cashier(business_id)
    OR EXISTS (
      SELECT 1
      FROM public.sales s
      WHERE s.id = sale_payments.sale_id
        AND s.cashier_id = auth.uid()
    )
  )
);

-- ---------------------------------------------------------------------------
-- stock_adjustment_requests: a cashier sees only the requests they raised.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Business members can view adjustment requests" ON public.stock_adjustment_requests;
CREATE POLICY "Business members can view adjustment requests"
ON public.stock_adjustment_requests
FOR SELECT
TO authenticated
USING (
  public.is_business_member(business_id)
  AND (
    NOT public.is_plain_cashier(business_id)
    OR requested_by = auth.uid()
  )
);

-- =====================================================
-- Guard: make the migration fail loudly if any of the three SELECT policies
-- is not in the expected cashier-scoped shape. (Same spirit as
-- 20261014000000_isolation_hotfix.sql.)
-- =====================================================
DO $$
DECLARE
  v_qual text;
BEGIN
  -- Helper must exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_plain_cashier'
  ) THEN
    RAISE EXCEPTION 'cashier_own_records_isolation: is_plain_cashier was not created';
  END IF;

  -- Each SELECT policy must mention the helper (i.e. real cashier scoping).
  FOR v_qual IN
    SELECT pg_get_expr(polqual, polrelid)
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    WHERE c.relname IN ('sales', 'sale_payments', 'stock_adjustment_requests')
      AND pol.polcmd = 'r'
      AND pol.polname IN (
        'Members can view sales',
        'Members can view sale payments',
        'Business members can view adjustment requests'
      )
  LOOP
    IF v_qual IS NULL OR position('is_plain_cashier' in v_qual) = 0 THEN
      RAISE EXCEPTION 'cashier_own_records_isolation: a SELECT policy is missing cashier scoping (%)', v_qual;
    END IF;
  END LOOP;
END $$;

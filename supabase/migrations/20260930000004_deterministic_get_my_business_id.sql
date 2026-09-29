BEGIN;

-- get_my_business_id() used bare LIMIT 1 with no ORDER BY, so on accounts that
-- resolve more than one row it could return a different business on every call.
-- Make it stable: head office first, then oldest, for owners; oldest active
-- assignment for cashiers. Same signature, same LANGUAGE/SECURITY/search_path,
-- so existing grants and the single client caller keep working unchanged.
CREATE OR REPLACE FUNCTION public.get_my_business_id()
  RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(
      (SELECT id FROM public.businesses
        WHERE user_id = auth.uid()
        ORDER BY (parent_business_id IS NULL) DESC, created_at ASC
        LIMIT 1),
      (SELECT business_id FROM public.business_cashiers
        WHERE auth_user_id = auth.uid() AND is_active = true
        ORDER BY created_at ASC
        LIMIT 1)
    );
  $$;

COMMENT ON FUNCTION public.get_my_business_id() IS
  'Deterministic default business for the caller: head office first, then oldest. Never LIMIT 1 without ORDER BY.';

GRANT EXECUTE ON FUNCTION public.get_my_business_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_business_id() TO service_role;

COMMIT;

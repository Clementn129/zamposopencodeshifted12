-- =====================================================
-- Lock down EXECUTE on state-changing RPCs
--
-- Postgres grants EXECUTE to PUBLIC by default, so every SECURITY DEFINER
-- function in `public` that was created without an explicit REVOKE is callable
-- by the `anon` role through PostgREST. These functions bypass RLS, so an
-- unauthenticated caller must not reach them.
--
-- This migration only touches the mutating entrypoints (the ones the app
-- invokes with an authenticated session). Deliberately NOT touched:
--   * `get_affiliate_by_code` / `lookup_business_by_code` — used pre-auth by
--     the registration and cashier-login flows, so `anon` must keep them.
--   * RLS predicate helpers (`is_business_member`, `has_role`, `owns_business`,
--     …) and trigger functions — revoking EXECUTE there can break policy
--     evaluation for the roles that legitimately query under RLS.
--
-- Idempotent: re-running simply re-applies the same grants.
-- =====================================================

DO $$
DECLARE
  r record;
  protected text[] := ARRAY[
    'record_sale_payment',
    'create_invoice_with_items',
    'create_delivery_note_with_items',
    'update_invoice_status',
    'update_delivery_note_status',
    'update_kitchen_order_status',
    'approve_stock_adjustment',
    'reject_stock_adjustment',
    'adjust_product_stock',
    'restock_ingredient',
    'quick_add_product',
    'refund_sale',
    'pay_invoice'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY (protected)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;

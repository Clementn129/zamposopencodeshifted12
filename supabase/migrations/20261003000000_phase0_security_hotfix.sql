-- =====================================================
-- Phase 0 security hotfix
--
-- 1) pay_invoice is a SECURITY DEFINER RPC that converts an invoice into a
--    sale and deducts stock. It had been granted to `anon`, so an
--    unauthenticated caller could invoke it. Restrict execution to the
--    authenticated role only (matching the rest of the repo convention).
-- 2) Defensively re-lock the multi-branch SECURITY DEFINER RPCs. This is
--    idempotent with 20260906020000_harden_multi_branch_rpc.sql but keeps the
--    lockdown self-contained so a partially-applied history can't leave a gap.
-- =====================================================

-- 1) pay_invoice: authenticated only
REVOKE EXECUTE ON FUNCTION public.pay_invoice(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_invoice(text, text) TO authenticated;

-- 2) multi-branch RPCs: authenticated only
REVOKE EXECUTE ON FUNCTION public.get_my_business_group() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_branch(uuid, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_branch_overview(uuid[]) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_my_business_group() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_branch(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_overview(uuid[]) TO authenticated;

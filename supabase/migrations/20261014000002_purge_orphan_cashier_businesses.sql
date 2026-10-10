-- =====================================================
-- Purge phantom cashier businesses (Phase 1)
--
-- Every new auth.users row gets a business auto-created by the
-- handle_new_user trigger (named 'My Business' unless business_name metadata
-- was supplied). manage-cashier creates cashier auth users via the admin API
-- and then deletes that auto-created row — but the delete is not error-checked.
-- If it ever fails, the cashier ends up OWNING an empty business, which:
--   * flips get_my_role() to 'owner' (owner is checked first), and
--   * makes get_my_business_id()/get_my_business_group() resolve the phantom
--     instead of the employer's business,
-- so the cashier silently operates on the wrong tenant.
--
-- This removes only rows that are unambiguously phantom: named exactly
-- 'My Business', owned by a user who is a cashier for someone else, and
-- containing no products or sales. It is a no-op on current data.
-- =====================================================

DELETE FROM public.businesses b
WHERE b.name = 'My Business'
  AND EXISTS (
    SELECT 1 FROM public.business_cashiers c
    WHERE c.auth_user_id = b.user_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.products p WHERE p.business_id = b.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.sales s WHERE s.business_id = b.id
  );

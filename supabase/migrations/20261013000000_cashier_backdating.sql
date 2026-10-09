-- ---------------------------------------------------------------------------
-- Per-cashier back-dating grant
-- ---------------------------------------------------------------------------
-- The business master switch (`businesses.allow_backdating`) still gates the
-- feature globally. This column narrows it further: a cashier may only record
-- sales / stock movements against a past date when their own `business_cashiers`
-- row has `can_backdate = true`.
--
-- Owners, managers and super admins are unaffected — they inherit the master
-- switch directly. Enforcement is UI-side, mirroring the existing behaviour of
-- `allow_backdating`; this migration simply stores the per-person grant.
-- ---------------------------------------------------------------------------

ALTER TABLE public.business_cashiers
  ADD COLUMN IF NOT EXISTS can_backdate BOOLEAN NOT NULL DEFAULT false;

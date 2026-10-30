-- ---------------------------------------------------------------------------
-- Per-cashier My Sales visibility
-- ---------------------------------------------------------------------------
-- Some businesses do not want their cashiers reviewing (and reprinting) their
-- own sales at the till. This column controls whether the "My Sales" tab is
-- shown to that cashier.
--
-- Default TRUE so every existing and newly created cashier keeps today's
-- behaviour until an owner explicitly switches it off. Owners and managers are
-- unaffected: they never see the cashier "My Sales" tab; they use Sales History.
--
-- Enforcement is UI-side, mirroring `can_backdate` and `can_adjust_stock`. The
-- cashier still needs SELECT on their own sales rows for the post-sale receipt,
-- reprint and the offline sale queue, so this is a visibility preference rather
-- than a security boundary.
-- ---------------------------------------------------------------------------

ALTER TABLE public.business_cashiers
  ADD COLUMN IF NOT EXISTS can_view_my_sales BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.business_cashiers.can_view_my_sales IS
  'Whether this cashier sees the My Sales tab at the till. Defaults to true.';

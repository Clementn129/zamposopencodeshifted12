-- CAPEX register + per-cashier stock access toggle.
--
-- Deliberately ADDITIVE ONLY. No column is dropped, no table is renamed, no
-- existing policy is weakened. Everything here is safe to apply to a live
-- database that other clients are already using.
--
-- Why CAPEX gets its own table instead of living in `expenses`:
-- `expenses.category` has a hard CHECK of ('business','personal'), and every
-- existing profit calculation treats "not personal" as an operating expense.
-- Filing CAPEX in `expenses` would make older, un-updated clients silently
-- count capital spend as an operating expense and report lower profit. A
-- separate table is invisible to them, so their numbers cannot move.
--
-- Why existing cashiers are backfilled to TRUE:
-- today every cashier may submit a stock-adjustment request. Defaulting the new
-- flag to false and leaving it there would quietly revoke that ability on
-- upgrade. Backfilling preserves today's behaviour exactly; the owner can then
-- turn individual cashiers off from Settings.
--
-- No outer BEGIN/COMMIT on purpose: the SQL Editor wraps each run in its own
-- transaction, so a failure rolls back and the error points at the exact
-- statement. Every statement is idempotent, so re-running is safe regardless.

-- ---------------------------------------------------------------------------
-- 1. CAPEX on/off switch, per business. Defaults off everywhere.
-- ---------------------------------------------------------------------------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS capex_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.businesses.capex_enabled IS
  'True = show the CAPEX tab and its report box. Off everywhere by default; existing clients ignore this column.';

-- ---------------------------------------------------------------------------
-- 2. Per-cashier "may request stock adjustments" flag.
-- ---------------------------------------------------------------------------
ALTER TABLE public.business_cashiers
  ADD COLUMN IF NOT EXISTS can_adjust_stock BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.business_cashiers.can_adjust_stock IS
  'True = this cashier may submit stock-adjustment requests for owner approval. Owners are unaffected and always allowed.';

-- Preserve existing behaviour: every currently active cashier keeps the ability
-- they already have. Idempotent — after the first run the predicate is empty.
UPDATE public.business_cashiers
   SET can_adjust_stock = true
 WHERE can_adjust_stock = false
   AND is_active = true;

-- ---------------------------------------------------------------------------
-- 3. Gate the request behind the flag.
--
-- SECURITY DEFINER, matching the existing owns_business / is_cashier_of_business
-- helpers. Policies on business_cashiers call owns_business, and
-- is_cashier_of_business queries business_cashiers; without SECURITY DEFINER a
-- new helper risks re-entering that recursion. This breaks the cycle the same
-- way the existing helpers do.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cashier_can_adjust_stock(_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.business_cashiers
    WHERE business_id = _business_id
      AND auth_user_id = auth.uid()
      AND is_active = true
      AND can_adjust_stock = true
  );
$$;

DROP POLICY IF EXISTS "Business members can create adjustment requests"
  ON public.stock_adjustment_requests;

CREATE POLICY "Business members can create adjustment requests"
  ON public.stock_adjustment_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_business_member(business_id)
    AND requested_by = auth.uid()
    AND status = 'pending'
    AND (
      public.owns_business(business_id)
      OR public.cashier_can_adjust_stock(business_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 4. The CAPEX ledger.
--
-- Owner-only. There is no policy granting cashiers any access, so RLS denies
-- them by default without needing an explicit deny policy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.capex (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  amount         NUMERIC NOT NULL CHECK (amount > 0),
  -- Fixed vocabulary. Free text fragments into 'Van', 'van', 'Vehicle' and
  -- every breakdown becomes useless; 'other' is the escape hatch.
  capex_category TEXT NOT NULL CHECK (capex_category IN (
                  'equipment',
                  'vehicle',
                  'tools',
                  'furniture',
                  'it_software',
                  'renovation',
                  'land_building',
                  'other'
                )),
  vendor         TEXT,
  purchase_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.capex IS
  'Capital expenditure register. A pure record: excluded from revenue, cost of sales, profit and cash. Never feeds back into any existing figure.';
COMMENT ON COLUMN public.capex.capex_category IS
  'Fixed vocabulary enforced by CHECK. Same 8 values as the client picker.';

-- Period queries are the only read pattern (register list + report box).
CREATE INDEX IF NOT EXISTS idx_capex_business_date
  ON public.capex (business_id, purchase_date DESC);

-- Matches the other financial tables so future replication/edits behave.
ALTER TABLE public.capex REPLICA IDENTITY FULL;

ALTER TABLE public.capex ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners manage capex" ON public.capex;
CREATE POLICY "Owners manage capex"
  ON public.capex
  FOR ALL
  TO authenticated
  USING (public.owns_business(business_id))
  WITH CHECK (public.owns_business(business_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.capex TO authenticated;
GRANT ALL ON public.capex TO service_role;

DROP TRIGGER IF EXISTS update_capex_updated_at ON public.capex;
CREATE TRIGGER update_capex_updated_at
  BEFORE UPDATE ON public.capex
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

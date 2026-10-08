-- Price lock: freeze a business's monthly price so future pricing-table changes
-- do not move existing clients. NULL means "no lock yet — derive the price from
-- the current pricing table (plan_tier label first, else active cashier count)".
-- The renewal edge function writes the lock on the first successful payment, so
-- new clients are frozen at whatever price they actually paid.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS monthly_price_zmw numeric(10,2);

COMMENT ON COLUMN public.businesses.monthly_price_zmw IS
  'Locked monthly price in ZMW. NULL = derive from PRICING_TIERS / plan_tier. Owners cannot edit; super admin and server (service_role) can.';

-- Backfill every existing business at today's effective price.
WITH active_cashiers AS (
  SELECT b.id AS business_id,
         (SELECT count(*) FROM public.business_cashiers c
           WHERE c.business_id = b.id AND c.is_active = true) AS cashiers
  FROM public.businesses b
)
UPDATE public.businesses b
SET monthly_price_zmw = CASE
      WHEN b.plan_tier = '1 cashier' THEN 200
      WHEN b.plan_tier = '2 – 3 cashiers' THEN 350
      WHEN b.plan_tier = '4 cashiers' THEN 500
      WHEN b.plan_tier = '5+ cashiers (custom)' THEN 0
      WHEN ac.cashiers <= 1 THEN 200
      WHEN ac.cashiers <= 3 THEN 350
      WHEN ac.cashiers = 4 THEN 500
      ELSE 0
    END
FROM active_cashiers ac
WHERE b.id = ac.business_id
  AND b.monthly_price_zmw IS NULL;

-- Extend the owner-write guard so the locked price joins plan_tier as a field
-- only super admins / the server may change.
CREATE OR REPLACE FUNCTION public.protect_business_subscription_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF public.has_role(auth.uid(), 'super_admin') OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.expire_business_if_due_active', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
     OR NEW.subscription_expires_at IS DISTINCT FROM OLD.subscription_expires_at
     OR NEW.is_locked IS DISTINCT FROM OLD.is_locked
     OR NEW.trial_started_at IS DISTINCT FROM OLD.trial_started_at
     OR NEW.payment_code IS DISTINCT FROM OLD.payment_code
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.plan_tier IS DISTINCT FROM OLD.plan_tier
     OR NEW.monthly_price_zmw IS DISTINCT FROM OLD.monthly_price_zmw THEN
    RAISE EXCEPTION 'Not allowed to modify subscription or billing fields';
  END IF;

  RETURN NEW;
END;
$function$;
-- One-time-use Lenco payment references.
--
-- verifyAndExtendSubscription verifies a reference against Lenco's status
-- endpoint, which reports "successful" forever. The unique index below makes
-- every successful verification consume the reference exactly once, so a paid
-- reference can never be replayed to extend a subscription repeatedly.

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS lenco_reference text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_lenco_reference
  ON public.payments (lenco_reference)
  WHERE lenco_reference IS NOT NULL;

COMMENT ON COLUMN public.payments.lenco_reference IS
  'Lenco collection reference consumed by a successful subscription renewal (unique = one-time use)';

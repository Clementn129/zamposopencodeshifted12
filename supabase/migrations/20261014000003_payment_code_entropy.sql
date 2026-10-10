-- Widen business payment_code entropy.
--
-- Current format is 'POS-' || 4 hex chars (16^4 = 65,536 codes) which is
-- trivially enumerable. New businesses get a 6 hex char code (16^6 = 16.7M)
-- to make brute-force business-code guessing materially harder.
--
-- Existing 4-char codes remain valid: uniqueness is enforced only among the
-- codes that exist, and cashier_login looks codes up by exact match, so mixed
-- lengths are fine. Codes are never auto-rotated here.
CREATE OR REPLACE FUNCTION public.generate_payment_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_code TEXT;
  code_exists BOOLEAN;
BEGIN
  LOOP
    new_code := 'POS-' || UPPER(SUBSTRING(md5(random()::text || clock_timestamp()::text) FROM 1 FOR 6));
    SELECT EXISTS(SELECT 1 FROM public.businesses WHERE payment_code = new_code) INTO code_exists;
    IF NOT code_exists THEN
      RETURN new_code;
    END IF;
  END LOOP;
END;
$$;

-- Preserve the existing execute grants (the function is SECURITY DEFINER and is
-- invoked from the handle_new_user trigger, but keep the surface unchanged).
REVOKE EXECUTE ON FUNCTION public.generate_payment_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_payment_code() TO service_role;

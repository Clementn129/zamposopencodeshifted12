import { useEffect, useState } from 'react';
import { useAuthContext } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { supabase } from '@/integrations/supabase/client';

/**
 * Whether the signed-in user may record a sale or stock movement against a
 * past date.
 *
 * The business master switch (`allow_backdating`) must be ON first. Owners,
 * managers and super admins then pass automatically; a cashier needs an
 * explicit per-person grant on their `business_cashiers` row.
 *
 * Enforcement is UI-side, matching the existing back-dating behaviour. Fails
 * closed: any error, offline state or missing column reads as `false`.
 */
export const useBackdatePermission = () => {
  const { user, role } = useAuthContext();
  const { business } = useBusiness();
  const masterOn = business?.allowBackdating === true;
  const [canBackdate, setCanBackdate] = useState(false);

  useEffect(() => {
    if (!masterOn) {
      setCanBackdate(false);
      return;
    }
    if (role === 'owner' || role === 'manager' || role === 'super_admin') {
      // Owners/managers inherit the master switch directly.
      setCanBackdate(true);
      return;
    }
    if (role !== 'cashier' || !business?.id || !user) {
      setCanBackdate(false);
      return;
    }

    let cancelled = false;
    setCanBackdate(false);

    supabase
      .from('business_cashiers')
      .select('can_backdate')
      .eq('auth_user_id', user.id)
      .eq('business_id', business.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // Un-migrated database or offline. Stay locked.
          if (!/column .* does not exist|PGRST204|42703|fetch|network/i.test(error.message)) {
            console.warn('Could not read back-dating grant:', error.message);
          }
          setCanBackdate(false);
          return;
        }
        setCanBackdate(data?.can_backdate === true);
      })
      .catch(() => {
        if (!cancelled) setCanBackdate(false);
      });

    return () => { cancelled = true; };
  }, [masterOn, business?.id, role, user]);

  return { canBackdate };
};

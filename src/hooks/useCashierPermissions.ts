import { useEffect, useState } from 'react';
import { useAuthContext } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { supabase } from '@/integrations/supabase/client';

/**
 * Whether the signed-in cashier may submit stock-adjustment requests.
 *
 * Owners and managers are not cashiers, so they keep full access regardless.
 * A cashier's grant lives on their `business_cashiers` row and is enforced
 * again by the INSERT policy on `stock_adjustment_requests`, so this is a UI
 * convenience rather than the control itself.
 *
 * Fails closed: any error, offline state or missing column reads as `false`.
 */
export const useCashierPermissions = () => {
  const { user, role } = useAuthContext();
  const { business } = useBusiness();
  const [canAdjustStock, setCanAdjustStock] = useState(false);

  const isCashier = role === 'cashier';

  useEffect(() => {
    if (role === 'owner' || role === 'manager' || role === 'super_admin') {
      // Owners/managers retain full access.
      setCanAdjustStock(true);
      return;
    }
    // Kitchen staff are not stock operators; they have no grant to read.
    if (role !== 'cashier' || !business?.id || !user) {
      setCanAdjustStock(false);
      return;
    }

    let cancelled = false;
    setCanAdjustStock(false);

    supabase
      .from('business_cashiers')
      .select('can_adjust_stock')
      .eq('auth_user_id', user.id)
      .eq('business_id', business.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // Un-migrated database or offline. Stay locked.
          if (!/column .* does not exist|PGRST204|42703|fetch|network/i.test(error.message)) {
            console.warn('Could not read stock access grant:', error.message);
          }
          setCanAdjustStock(false);
          return;
        }
        setCanAdjustStock(data?.can_adjust_stock === true);
      })
      .catch(() => {
        if (!cancelled) setCanAdjustStock(false);
      });

    return () => { cancelled = true; };
  }, [business?.id, isCashier, user]);

  return { isCashier, canAdjustStock };
};

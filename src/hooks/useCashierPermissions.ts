import { useEffect, useState } from 'react';
import { useAuthContext } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { supabase } from '@/integrations/supabase/client';

/**
 * Per-cashier till permissions.
 *
 * `canAdjustStock` — whether the signed-in cashier may submit stock-adjustment
 * requests. Owners and managers keep full access. A cashier's grant lives on
 * their `business_cashiers` row and is enforced again by the INSERT policy on
 * `stock_adjustment_requests`, so this is a UI convenience rather than the
 * control itself. Fails closed: any error, offline state or missing column
 * reads as `false`.
 *
 * `canViewMySales` — whether the cashier sees the "My Sales" tab at the till.
 * Defaults to ON, because that is the behaviour every existing cashier already
 * has; an owner switches it off per cashier. Unlike the stock grant this fails
 * open (a visibility preference, not an entitlement), and the last known value
 * is cached so an offline login keeps the tab exactly as the owner left it.
 */

const mySalesCacheKey = (businessId: string, userId: string) =>
  `zampos.mySalesVisible.${businessId}.${userId}`;

const readCachedMySales = (businessId: string, userId: string): boolean | null => {
  try {
    const raw = window.localStorage.getItem(mySalesCacheKey(businessId, userId));
    if (raw === '0') return false;
    if (raw === '1') return true;
    return null;
  } catch {
    return null;
  }
};

const writeCachedMySales = (businessId: string, userId: string, value: boolean): void => {
  try {
    window.localStorage.setItem(mySalesCacheKey(businessId, userId), value ? '1' : '0');
  } catch {
    // Best effort — a blocked storage API just means the next online read wins.
  }
};

export const useCashierPermissions = () => {
  const { user, role } = useAuthContext();
  const { business } = useBusiness();
  const [canAdjustStock, setCanAdjustStock] = useState(false);
  const [canViewMySales, setCanViewMySales] = useState(true);

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
      }, () => {
        if (!cancelled) setCanAdjustStock(false);
      });

    return () => { cancelled = true; };
  }, [business?.id, isCashier, role, user]);

  useEffect(() => {
    if (role !== 'cashier' || !business?.id || !user) {
      // Owners/managers/kitchen never use the cashier tab; leave the default on.
      setCanViewMySales(true);
      return;
    }

    let cancelled = false;

    // Paint from cache first so an offline login (or a slow link) shows the tab
    // exactly as the owner last left it instead of flashing it on and off.
    const cached = readCachedMySales(business.id, user.id);
    setCanViewMySales(cached ?? true);

    const load = () => {
      supabase
        .from('business_cashiers')
        .select('can_view_my_sales')
        .eq('auth_user_id', user.id)
        .eq('business_id', business.id)
        .maybeSingle()
        .then(({ data, error }) => {
          if (cancelled) return;
          if (error) {
            // Offline, or the visibility migration has not landed yet. Keep the
            // cached value (or the default ON) — never hide the tab on error.
            if (!/column .* does not exist|PGRST204|42703|fetch|network/i.test(error.message)) {
              console.warn('Could not read My Sales visibility:', error.message);
            }
            return;
          }
          // Anything other than an explicit false keeps the tab visible.
          const visible = data?.can_view_my_sales !== false;
          writeCachedMySales(business.id, user.id, visible);
          setCanViewMySales(visible);
        }, () => {
          // Network failure: keep whatever the cache told us.
        });
    };

    load();

    // Tills stay signed in for days. Re-check when the tab regains focus so an
    // owner's switch-off reaches the cashier without a full reload.
    const onWake = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [business?.id, role, user]);

  return { isCashier, canAdjustStock, canViewMySales };
};

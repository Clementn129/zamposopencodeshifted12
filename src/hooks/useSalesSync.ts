import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getUnsyncedSales, markSaleAsSynced } from "@/lib/offlineStorage";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

export function useSalesSync(businessId: string | undefined) {
  const { isOnline } = useOnlineStatus();
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const syncInFlight = useRef(false);

  const checkPendingCount = useCallback(async () => {
    if (!businessId) {
      setPendingCount(0);
      return;
    }

    try {
      const unsynced = await getUnsyncedSales(businessId);
      setPendingCount(unsynced.length);
    } catch (e) {
      console.error("Error checking pending sales:", e);
    }
  }, [businessId]);

  const sync = useCallback(async () => {
    if (!businessId || !isOnline || syncInFlight.current) return;

    syncInFlight.current = true;
    setIsSyncing(true);
    setLastSyncError(null);

    let anySynced = false;

    try {
      const unsynced = await getUnsyncedSales(businessId);
      setPendingCount(unsynced.length);

      for (const sale of unsynced) {
        try {
          const { error: saleErr } = await (supabase.rpc as any)("sync_offline_sale", {
            p_business_id: businessId,
            p_offline_id: sale.id,
            p_items: sale.items,
            p_subtotal: sale.subtotal,
            p_total: sale.total,
            p_discount_amount: sale.discountAmount || 0,
            p_discount_type: sale.discountType || null,
            p_payment_method: sale.paymentMethod,
            p_created_at: sale.createdAt,
            p_tax_amount: (sale as any).taxAmount || 0,
            p_taxable_amount: (sale as any).taxableAmount || 0,
            p_zero_rated_amount: (sale as any).zeroRatedAmount || 0,
            p_exempt_amount: (sale as any).exemptAmount || 0,
            p_customer_name: (sale as any).customerName || null,
            p_customer_tpin: (sale as any).customerTpin || null,
            p_amount_paid: (sale as any).amountPaid ?? sale.total,
            p_due_date: (sale as any).dueDate || null,
            p_customer_phone: (sale as any).customerPhone || null,
            p_table_id: (sale as any).tableId || null,
            p_cashier_id: sale.cashierUserId || null,
          });

          if (saleErr) {
            throw saleErr;
          }

          await markSaleAsSynced(sale.id);
          setPendingCount((prev) => Math.max(0, prev - 1));
          anySynced = true;
        } catch (e: any) {
          console.error("Error syncing sale:", e);
          setLastSyncError(e?.message || "Failed to sync sale");
        }
      }

      // Stamp last_sync_at if any sale was synced
      if (anySynced && businessId) {
        supabase.from('businesses').update({ last_sync_at: new Date().toISOString() }).eq('id', businessId).then(() => {}).catch(() => {});
      }
    } catch (e: any) {
      console.error("Error in sync process:", e);
      setLastSyncError(e?.message || "Sync failed");
    } finally {
      syncInFlight.current = false;
      setIsSyncing(false);
      await checkPendingCount();
      // Notify the app that sync finished so dependent hooks (products, sales
      // history, debtors) can refresh their data from the server.
      if (anySynced) {
        try {
          window.dispatchEvent(new CustomEvent("zampos:sync-complete"));
        } catch {
          // ignore
        }
      }
    }
  }, [businessId, isOnline, checkPendingCount]);

  useEffect(() => {
    void checkPendingCount();
  }, [checkPendingCount]);

  useEffect(() => {
    if (!businessId || !isOnline) return;

    void sync();

    const interval = setInterval(() => {
      void sync();
    }, 30000);

    return () => {
      clearInterval(interval);
    };
  }, [businessId, isOnline, sync]);

  return { isSyncing, pendingCount, lastSyncError, refetchPending: checkPendingCount, syncNow: sync };
}

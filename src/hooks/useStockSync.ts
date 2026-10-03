import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getUnsyncedStockUpdates, markStockUpdateAsSynced } from "@/lib/offlineStorage";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

// Shared across every useStockSync instance for the same business so the two
// mounts (AppSyncManager + the Products page) cannot read the same pending
// stock deltas and apply them twice. Also guards re-entrant interval ticks.
const stockSyncInFlight = new Map<string, boolean>();

export function useStockSync(businessId: string | undefined, preventNegativeStock?: boolean) {
  const { isOnline } = useOnlineStatus();
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const checkPendingCount = useCallback(async () => {
    if (!businessId) {
      setPendingCount(0);
      return;
    }

    try {
      const unsynced = await getUnsyncedStockUpdates(businessId);
      setPendingCount(unsynced.length);
    } catch (e) {
      console.error("Error checking pending stock updates:", e);
    }
  }, [businessId]);

  const sync = useCallback(async () => {
    if (!businessId || !isOnline) return;
    if (stockSyncInFlight.get(businessId)) return;

    stockSyncInFlight.set(businessId, true);
    setIsSyncing(true);

    let syncedCount = 0;

    try {
      const unsynced = await getUnsyncedStockUpdates(businessId);
      setPendingCount(unsynced.length);

      const productChanges: Record<string, { netChange: number; updateIds: string[] }> = {};

      for (const update of unsynced) {
        if (!productChanges[update.productId]) {
          productChanges[update.productId] = { netChange: 0, updateIds: [] };
        }
        productChanges[update.productId].netChange += update.stockChange;
        productChanges[update.productId].updateIds.push(update.id);
      }

      for (const [productId, change] of Object.entries(productChanges)) {
        try {
          const { data: pRow, error: productError } = await supabase
            .from("products")
            .select("stock")
            .eq("id", productId)
            .maybeSingle();

          if (productError) throw productError;

          const currentStock = Number(pRow?.stock ?? 0);
          // Fail closed: only an explicit `false` lets stock go below zero.
          const newStock = preventNegativeStock === false
            ? currentStock + change.netChange
            : Math.max(0, currentStock + change.netChange);
          const { error: stockError } = await supabase
            .from("products")
            .update({ stock: newStock })
            .eq("id", productId);

          if (stockError) throw stockError;

          for (const id of change.updateIds) {
            await markStockUpdateAsSynced(id);
            syncedCount += 1;
          }
        } catch (e) {
          console.error(`Error syncing stock for product ${productId}:`, e);
        }
      }

      setPendingCount((prev) => Math.max(0, prev - syncedCount));
    } catch (e: any) {
      console.error("Error in stock sync process:", e);
    } finally {
      stockSyncInFlight.set(businessId, false);
      setIsSyncing(false);
      await checkPendingCount();
      if (syncedCount > 0) {
        try {
          window.dispatchEvent(new CustomEvent("zampos:sync-complete"));
        } catch {
          // ignore
        }
      }
    }
  }, [businessId, isOnline, checkPendingCount, preventNegativeStock]);

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

  return { isSyncing, pendingCount, refetchPending: checkPendingCount, syncNow: sync };
}

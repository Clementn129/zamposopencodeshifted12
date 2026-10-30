import { ReactNode, useEffect, useRef } from "react";
import { useAuthContext } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useBusiness } from "@/hooks/useBusiness";
import { useSalesSync } from "@/hooks/useSalesSync";
import { useStockSync } from "@/hooks/useStockSync";
import { useRealtimeSync } from "@/hooks/useRealtimeSync";
import { usePendingOpsSync } from "@/hooks/usePendingOpsSync";
import { useDownstreamSync } from "@/hooks/useDownstreamSync";
import { SyncStatusProvider, SyncStatusValue } from "@/contexts/SyncStatusContext";
import { supabase } from "@/integrations/supabase/client";

// Single owner of the sync stack. Pages (POS) read sync state/actions via
// SyncStatusProvider instead of mounting duplicate hook instances — duplicates
// each ran their own mount-time sync/pull plus their own intervals, so a POS
// load used to trigger the same RPCs and the heavy downstream pull twice.
export const AppSyncManager = ({ children }: { children?: ReactNode }) => {
  const { user, isLoading, role, signOut } = useAuthContext();
  const { toast } = useToast();
  const { business, refetch: refetchBusiness } = useBusiness(!isLoading ? user?.id : undefined);

  useStockSync(business?.id, business?.preventNegativeStock);
  useRealtimeSync(business?.id);
  const salesSync = useSalesSync(business?.id);
  const opsSync = usePendingOpsSync(business?.id, business?.preventNegativeStock);
  const downstreamSync = useDownstreamSync(business?.id);

  const syncStatus: SyncStatusValue = {
    isSyncing: salesSync.isSyncing,
    pendingCount: salesSync.pendingCount,
    lastSyncError: salesSync.lastSyncError,
    syncNow: salesSync.syncNow,
    failedOps: opsSync.failedOps,
    retryFailedOps: opsSync.retryFailedOps,
    clearFailedOps: opsSync.clearFailedOps,
    syncOpsNow: opsSync.syncNow,
    isPulling: downstreamSync.isPulling,
    pullNow: downstreamSync.pullNow,
  };

  // Stable ref so the effect doesn't re-create the channel when refetchBusiness
  // identity changes (e.g. on isOnline toggle).
  const refetchRef = useRef(refetchBusiness);
  refetchRef.current = refetchBusiness;

  // Single realtime subscription for business row changes — owned here so
  // multiple useBusiness consumers don't fight over the same channel topic.
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`business-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'businesses',
        },
        (payload) => {
          const next = payload.new as Record<string, any> | null;
          const prev = payload.old as Record<string, any> | null;
          if (next?.user_id !== user.id) return;
          const ignore = new Set(['last_sync_at', 'updated_at']);
          const hasPrev = !!prev && Object.keys(prev).length > 1;
          const changed = hasPrev
            ? Object.keys(next ?? {}).some((k) => k !== 'id' && !ignore.has(k) && next?.[k] !== prev?.[k])
            : true;
          if (changed) {
            void refetchRef.current();
            window.dispatchEvent(new CustomEvent('zampos:business-changed'));
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id]);

  // If the owner disables this cashier (is_active -> false), sign them out
  // immediately instead of letting them keep working until the next login.
  useEffect(() => {
    if (role !== "cashier" || !user?.id) return;
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail as { new?: Record<string, any> } | undefined;
      const row = detail?.new;
      if (!row || row.auth_user_id !== user.id) return;
      if (row.is_active === false) {
        toast({
          variant: "destructive",
          title: "Access disabled",
          description: "Your cashier access has been disabled by the owner.",
        });
        await signOut().catch(() => {});
      }
    };
    window.addEventListener("zampos:cashier-changed", handler);
    return () => window.removeEventListener("zampos:cashier-changed", handler);
  }, [role, user?.id, signOut, toast]);

  return <SyncStatusProvider value={syncStatus}>{children}</SyncStatusProvider>;
};

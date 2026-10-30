import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Single source of truth for realtime sync. Mount ONCE at app root.
 *
 * Performance strategy: instead of invalidating entire query caches on every
 * change (which triggers a full refetch + re-render storm), we apply the
 * payload delta directly to the cached arrays. Components subscribed to those
 * queries re-render with the updated row only — no extra network round-trip.
 *
 * Window events are still dispatched so non-react-query consumers (e.g. plain
 * useState-based pages like SalesHistory) can listen and refetch if needed.
 */
type Row = Record<string, any>;

function applyDelta<T extends Row>(
  prev: T[] | undefined,
  payload: { eventType: string; new: T | null; old: T | null }
): T[] | undefined {
  if (!prev) return prev;
  const { eventType, new: nextRow, old: oldRow } = payload;
  if (eventType === "INSERT" && nextRow) {
    if (prev.some((r) => r.id === nextRow.id)) return prev;
    return [nextRow, ...prev];
  }
  if (eventType === "UPDATE" && nextRow) {
    return prev.map((r) => (r.id === nextRow.id ? { ...r, ...nextRow } : r));
  }
  if (eventType === "DELETE" && oldRow) {
    return prev.filter((r) => r.id !== oldRow.id);
  }
  return prev;
}

export function useRealtimeSync(businessId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!businessId) return;

    const channel = supabase
      .channel(`biz-${businessId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sales", filter: `business_id=eq.${businessId}` },
        (payload: any) => {
          // Incremental: patch any cached ["sales", ...] arrays in place.
          queryClient.setQueriesData<Row[]>({ queryKey: ["sales"] }, (prev) =>
            applyDelta(prev, payload)
          );
          window.dispatchEvent(new CustomEvent("zampos:sales-changed", { detail: payload }));
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "products", filter: `business_id=eq.${businessId}` },
        (payload: any) => {
          queryClient.setQueriesData<Row[]>({ queryKey: ["products"] }, (prev) =>
            applyDelta(prev, payload)
          );
          window.dispatchEvent(new CustomEvent("zampos:products-changed", { detail: payload }));
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "quotations", filter: `business_id=eq.${businessId}` },
        (payload: any) => {
          queryClient.setQueriesData<Row[]>({ queryKey: ["quotations"] }, (prev) =>
            applyDelta(prev, payload)
          );
          window.dispatchEvent(new CustomEvent("zampos:quotations-changed", { detail: payload }));
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sale_payments", filter: `business_id=eq.${businessId}` },
        (payload: any) => {
          queryClient.setQueriesData<Row[]>({ queryKey: ["sale_payments"] }, (prev) =>
            applyDelta(prev, payload)
          );
          // Sale row also gets updated by RPC — but fire a sales-changed event so
          // history screens refetch fresh amount_paid/balance immediately.
          window.dispatchEvent(new CustomEvent("zampos:sale-payment-changed", { detail: payload }));
          window.dispatchEvent(new CustomEvent("zampos:sales-changed", { detail: payload }));
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "expenses", filter: `business_id=eq.${businessId}` },
        (payload: any) => {
          queryClient.setQueriesData<Row[]>({ queryKey: ["expenses"] }, (prev) =>
            applyDelta(prev, payload)
          );
          window.dispatchEvent(new CustomEvent("zampos:expenses-changed", { detail: payload }));
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "debtors", filter: `business_id=eq.${businessId}` },
        (payload: any) => {
          queryClient.setQueriesData<Row[]>({ queryKey: ["debtors"] }, (prev) =>
            applyDelta(prev, payload)
          );
          window.dispatchEvent(new CustomEvent("zampos:debtors-changed", { detail: payload }));
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "business_cashiers", filter: `business_id=eq.${businessId}` },
        (payload: any) => {
          // Per-cashier grants (can_view_my_sales, can_adjust_stock, can_backdate)
          // and is_active changes. Dispatched so the permission hooks and the
          // active guard react immediately instead of waiting for focus/reload.
          window.dispatchEvent(new CustomEvent("zampos:cashier-changed", { detail: payload }));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [businessId, queryClient]);
}

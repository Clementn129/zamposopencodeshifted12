import { useEffect, useCallback, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { mergeServerProducts, cacheDebtors, cacheSalesHistory, getPendingOps } from "@/lib/offlineStorage";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

// Reconnect pull-down: when the app comes back online, grab the latest server
// state and refresh the local caches. Never drops local pending work — the
// merge helper keeps local stock/results intact while anything is unsynced,
// and the whole pull is skipped while push syncs still have items queued.
export function useDownstreamSync(businessId: string | undefined) {
  const { isOnline } = useOnlineStatus();
  const [isPulling, setIsPulling] = useState(false);
  const pulling = useRef(false);

  // Cadence bookkeeping so we don't re-fetch the whole catalog on every pull.
  const lastCatalogPull = useRef<number>(0);
  const lastSalesPull = useRef<number | null>(null);
  const catalogDirty = useRef<boolean>(false);
  const CATALOG_MIN_AGE = 30 * 60 * 1000; // 30 min unless a change event marks it dirty
  const SALES_OVERLAP = 10 * 60 * 1000;   // 10 min overlap so late updates aren't missed

  const expLastSyncAt = useCallback(() => {
    if (!businessId) return;
    const now = new Date().toISOString();
    supabase.from("businesses").update({ last_sync_at: now }).eq("id", businessId).then(() => {}, () => {});
  }, [businessId]);

  const pull = useCallback(async () => {
    if (!businessId || !isOnline || pulling.current) return;
    // Don't pull while the tab is hidden — saves egress on backgrounded tills.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

    pulling.current = true;
    setIsPulling(true);
    let touchedAnything = false;

    try {
      // Wait for push syncs to drain first so this pull reflects their output.
      const pending = await getPendingOps(businessId);
      const hasPendingDebtorWork = pending.some((op) =>
        op.type === 'debtor_create' || op.type === 'debtor_payment' || op.type === 'debtor_delete'
      );

      const now = Date.now();
      const doCatalog = (now - lastCatalogPull.current > CATALOG_MIN_AGE) || catalogDirty.current;

      const since90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
      const salesSince = lastSalesPull.current
        ? new Date(lastSalesPull.current - SALES_OVERLAP).toISOString()
        : since90;
      // Never pull older than the 90-day window even on a stale cursor.
      const salesFloor = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
      const salesGte = salesSince > salesFloor ? salesSince : salesFloor;

      try {
        const queries: any[] = [];

        // Products + debtors only when the catalog is stale or marked dirty.
        if (doCatalog) {
          queries.push(
            supabase
              .from("products")
              .select("id, business_id, created_at, name, price, cost_price, stock, opening_stock, minimum_stock, category, barcode, is_active, tax_category, image_url, parent_id, variant_label, item_type, track_expiry, track_stock, expiry_date")
              .eq("business_id", businessId)
              .order("created_at", { ascending: false })
              .order("id", { ascending: true })
              .limit(25000)
          );
          if (hasPendingDebtorWork) {
            queries.push(Promise.resolve({ data: null }));
          } else {
            queries.push(
              supabase
                .from("debtors")
                .select("id, business_id, customer_name, customer_phone, amount_owed, amount_paid, status, notes, created_at, due_date")
                .eq("business_id", businessId)
                .limit(1000)
            );
          }
        } else {
          // Keep slot alignment: placeholders so Promise.all indices stay stable.
          queries.push(Promise.resolve({ data: null }));
          queries.push(Promise.resolve({ data: null }));
        }

        queries.push(
          supabase
            .from("sales")
            .select("id, items, subtotal, total, discount_amount, payment_method, created_at, status, tax_amount, taxable_amount, zero_rated_amount, exempt_amount, customer_name, customer_tpin, customer_phone, amount_paid, balance_due, payment_status, due_date")
            .eq("business_id", businessId)
            .gte("created_at", salesGte)
            .order("created_at", { ascending: false })
            .limit(2000)
        );

        const results = await Promise.all(queries);
        const products = doCatalog ? results[0]?.data : null;
        const debtors = doCatalog ? results[1]?.data : null;
        const serverSales = results[results.length - 1]?.data;

        if (doCatalog && products) {
          const mapped = products.map((p: any) => ({
            id: p.id,
            businessId: p.business_id,
            createdAt: p.created_at,
            name: p.name,
            price: Number(p.price),
            costPrice: p.cost_price != null ? Number(p.cost_price) : null,
            stock: Number(p.stock),
            openingStock: Number(p.opening_stock ?? 0),
            minimumStock: Number(p.minimum_stock ?? 5),
            category: p.category,
            barcode: p.barcode ?? null,
            isActive: p.is_active,
            taxCategory: p.tax_category || 'taxable',
            imageUrl: p.image_url,
            imagePath: p.image_url,
            parentId: p.parent_id,
            variantLabel: p.variant_label,
            trackExpiry: p.track_expiry ?? false,
            trackStock: p.track_stock ?? true,
            expiryDate: p.expiry_date ?? null,
          }));

          await mergeServerProducts(businessId, mapped);
          touchedAnything = true;
          lastCatalogPull.current = now;
          catalogDirty.current = false;
        }

        if (doCatalog && debtors) {
          await cacheDebtors(debtors.map((d: any) => ({
            id: d.id,
            businessId: d.business_id,
            customerName: d.customer_name,
            customerPhone: d.customer_phone,
            amountOwed: Number(d.amount_owed),
            amountPaid: Number(d.amount_paid),
            status: d.status,
            notes: d.notes,
            createdAt: d.created_at,
            dueDate: d.due_date,
          })));
          touchedAnything = true;
          lastCatalogPull.current = now;
        }

        if (serverSales) {
          await cacheSalesHistory(businessId, serverSales.map((s: any) => ({
            id: s.id,
            businessId,
            items: s.items,
            subtotal: Number(s.subtotal),
            total: Number(s.total),
            discountAmount: Number(s.discount_amount || 0),
            paymentMethod: s.payment_method,
            createdAt: s.created_at,
            synced: true,
            status: s.status || 'completed',
            taxAmount: Number(s.tax_amount || 0),
            taxableAmount: Number(s.taxable_amount || 0),
            zeroRatedAmount: Number(s.zero_rated_amount || 0),
            exemptAmount: Number(s.exempt_amount || 0),
            customerName: s.customer_name,
            customerTpin: s.customer_tpin,
            customerPhone: s.customer_phone,
            amountPaid: Number(s.amount_paid ?? s.total ?? 0),
            balanceDue: Number(s.balance_due ?? 0),
            paymentStatus: (s.payment_status as string) || 'paid',
            dueDate: s.due_date,
          })));
          touchedAnything = true;
          lastSalesPull.current = now;
        }
      } catch (e) {
        console.warn("Downstream pull failed:", e);
      }

      if (touchedAnything) {
        expLastSyncAt();
        try {
          window.dispatchEvent(new CustomEvent("zampos:sync-complete"));
        } catch {
          // ignore
        }
      }
    } finally {
      pulling.current = false;
      setIsPulling(false);
    }
  }, [businessId, isOnline, expLastSyncAt]);

  useEffect(() => {
    if (!businessId || !isOnline) return;

    // Mark catalog dirty when remote changes arrive, and pull promptly (debounced)
    // so the offline cache (IndexedDB) catches up within a few seconds instead
    // of waiting for the 5-min poll.
    let catalogPullTimer: ReturnType<typeof setTimeout> | null = null;
    const markCatalogDirty = () => {
      catalogDirty.current = true;
      if (catalogPullTimer) clearTimeout(catalogPullTimer);
      catalogPullTimer = setTimeout(() => {
        catalogPullTimer = null;
        if (typeof document !== "undefined" && document.visibilityState === "visible") void pull();
      }, 3000);
    };
    window.addEventListener("zampos:products-changed", markCatalogDirty);
    window.addEventListener("zampos:debtors-changed", markCatalogDirty);

    // The initial pull is heavy (products + debtors + sales in one round),
    // so hold it back until the first paint has settled.
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let cancelled = false;
    let idleHandle: number | null = null;
    const startPull = () => {
      if (!cancelled) void pull();
    };
    if (typeof win.requestIdleCallback === "function") {
      idleHandle = win.requestIdleCallback(startPull, { timeout: 4000 });
    } else {
      idleHandle = window.setTimeout(startPull, 1500);
    }

    // Slower fallback poll — the realtime channel already refreshes on changes.
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void pull();
    }, 5 * 60 * 1000);

    // Pull promptly when the tab becomes visible again.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - (lastSalesPull.current ?? 0) > 2 * 60 * 1000) void pull();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      catalogDirty.current = false;
      if (catalogPullTimer) clearTimeout(catalogPullTimer);
      window.removeEventListener("zampos:products-changed", markCatalogDirty);
      window.removeEventListener("zampos:debtors-changed", markCatalogDirty);
      document.removeEventListener("visibilitychange", onVisible);
      if (idleHandle !== null) {
        if (typeof win.cancelIdleCallback === "function" && typeof win.requestIdleCallback === "function") {
          win.cancelIdleCallback(idleHandle);
        } else {
          window.clearTimeout(idleHandle);
        }
      }
      clearInterval(interval);
    };
  }, [businessId, isOnline, pull]);

  return { isPulling, pullNow: pull };
}

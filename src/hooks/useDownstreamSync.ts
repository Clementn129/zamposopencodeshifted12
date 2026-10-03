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

  const expLastSyncAt = useCallback(() => {
    if (!businessId) return;
    const now = new Date().toISOString();
    supabase.from("businesses").update({ last_sync_at: now }).eq("id", businessId).then(() => {}).catch(() => {});
  }, [businessId]);

  const pull = useCallback(async () => {
    if (!businessId || !isOnline || pulling.current) return;

    pulling.current = true;
    setIsPulling(true);
    let touchedAnything = false;

    try {
      // Wait for push syncs to drain first so this pull reflects their output.
      const pending = await getPendingOps(businessId);
      const hasPendingDebtorWork = pending.some((op) =>
        op.type === 'debtor_create' || op.type === 'debtor_payment' || op.type === 'debtor_delete'
      );

      try {
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const [{ data: products }, { data: debtors }, { data: serverSales }] = await Promise.all([
          supabase
            .from("products")
            .select("id, business_id, created_at, name, price, cost_price, stock, minimum_stock, category, barcode, is_active, tax_category, image_url, parent_id, variant_label, item_type, track_expiry, track_stock, expiry_date")
            .eq("business_id", businessId)
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .limit(25000),
          hasPendingDebtorWork
            ? Promise.resolve({ data: null })
            : supabase
                .from("debtors")
                .select("id, business_id, customer_name, customer_phone, amount_owed, amount_paid, status, notes, created_at, due_date")
                .eq("business_id", businessId)
                .limit(1000),
          supabase
            .from("sales")
            .select("id, items, subtotal, total, discount_amount, payment_method, created_at, status, tax_amount, taxable_amount, zero_rated_amount, exempt_amount, customer_name, customer_tpin, customer_phone, amount_paid, balance_due, payment_status, due_date")
            .eq("business_id", businessId)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(20000),
        ]);

        if (products) {
          const mapped = products.map((p: any) => ({
            id: p.id,
            businessId: p.business_id,
            createdAt: p.created_at,
            name: p.name,
            price: Number(p.price),
            costPrice: p.cost_price != null ? Number(p.cost_price) : null,
            stock: Number(p.stock),
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

          // Merge is always safe: it never drops local rows and preserves
          // local stock for anything still pending; once the push drain
          // catches up, subsequent pulls overwrite cleanly.
          await mergeServerProducts(businessId, mapped);
          touchedAnything = true;
        }

        if (debtors) {
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

    void pull();

    const interval = setInterval(() => {
      void pull();
    }, 60000);

    return () => {
      clearInterval(interval);
    };
  }, [businessId, isOnline, pull]);

  return { isPulling, pullNow: pull };
}
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChefHat, LogOut, RotateCcw, Clock, ShoppingCart, Utensils, Boxes } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBusiness } from "@/hooks/useBusiness";
import { useProducts } from "@/hooks/useProducts";
import { useAuthContext } from "@/contexts/AuthContext";
import type { Database } from "@/integrations/supabase/types";

type KitchenOrderRow = Database["public"]["Tables"]["kitchen_orders"]["Row"];
export type KitchenStatus = "pending" | "preparing" | "ready" | "served" | "cancelled";

interface LineItem {
  productId?: string;
  name?: string;
  quantity?: number;
  modifiers?: Array<{ name: string; priceAdjustment?: number }>;
}

const STATUS_FLOW: KitchenStatus[] = ["pending", "preparing", "ready", "served"];
const STATUS_LABEL: Record<KitchenStatus, string> = {
  pending: "Pending",
  preparing: "Preparing",
  ready: "Ready to serve",
  served: "Served",
  cancelled: "Cancelled",
};
const STATUS_COLOR: Record<KitchenStatus, string> = {
  pending: "bg-amber-500/15 text-amber-600",
  preparing: "bg-blue-500/15 text-blue-600",
  ready: "bg-green-500/15 text-green-600",
  served: "bg-muted text-muted-foreground",
  cancelled: "bg-destructive/10 text-destructive",
};

const Kitchen = () => {
  const navigate = useNavigate();
  const { user, role, signOut } = useAuthContext();
  const { business, isLoading: bizLoading, refetch: refetchBusiness } = useBusiness(user?.id);
  const { activeProducts } = useProducts(business?.id ?? undefined);

  const [orders, setOrders] = useState<KitchenOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);

  const productNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of activeProducts) map[p.id] = p.variantLabel ? `${p.name} · ${p.variantLabel}` : p.name;
    return map;
  }, [activeProducts]);

  const loadOrders = async () => {
    if (!business?.id) return;
    try {
      const { data, error } = await supabase
        .from("kitchen_orders")
        .select("*")
        .eq("business_id", business.id)
        .neq("status", "served")
        .neq("status", "cancelled")
        .order("created_at", { ascending: true });
      if (error) throw error;
      setOrders(data ?? []);
      setLastError(null);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Failed to load kitchen orders");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!business?.id) return;
    void loadOrders();
  }, [business?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates
  useEffect(() => {
    if (!business?.id) return;
    const channel = supabase
      .channel("kitchen-orders-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "kitchen_orders", filter: `business_id=eq.${business.id}` },
        (payload) => {
          const row = payload.new as KitchenOrderRow;
          if (!row) return;
          if (payload.eventType === "DELETE") {
            setOrders((prev) => prev.filter((o) => o.id !== row.id));
          } else {
            if (row.status === "served" || row.status === "cancelled") {
              setOrders((prev) => prev.filter((o) => o.id !== row.id));
            } else {
              setOrders((prev) => {
                const exists = prev.some((o) => o.id === row.id);
                return exists ? prev.map((o) => (o.id === row.id ? row : o)) : [...prev, row];
              });
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [business?.id]);

  const advanceStatus = async (order: KitchenOrderRow) => {
    const current = order.status as KitchenStatus;
    const idx = STATUS_FLOW.indexOf(current);
    const next = STATUS_FLOW[idx + 1] as KitchenStatus;
    await setStatus(order, next ?? order.status);
  };

  const setStatus = async (order: KitchenOrderRow, status: KitchenStatus) => {
    const { error } = await supabase.rpc("update_kitchen_order_status", {
      p_order_id: order.id,
      p_status: status,
    });
    if (error) {
      setLastError(error.message || "Failed to update");
      void refetchBusiness();
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card border-b border-border px-4 py-3 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <ChefHat className="h-5 w-5" />
            </span>
            <div>
              <h1 className="font-display font-bold text-lg leading-tight">Kitchen</h1>
              <p className="text-xs text-muted-foreground">{business?.name ?? "…"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:inline">{orders.length} open</span>
            <button
              onClick={() => void loadOrders()}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border hover:bg-secondary"
              aria-label="Refresh"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            {role === 'owner' || role === 'super_admin' ? (
              <button
                onClick={() => navigate('/dashboard')}
                className="inline-flex items-center gap-1 h-9 rounded-lg border border-border px-3 text-sm hover:bg-secondary"
              >
                Dashboard
              </button>
            ) : role === 'manager' ? (
              <>
                <button
                  onClick={() => navigate('/pos')}
                  className="inline-flex items-center gap-1 h-9 rounded-lg border border-border px-3 text-sm hover:bg-secondary"
                >
                  <ShoppingCart className="h-4 w-4" /> Till
                </button>
                <button
                  onClick={() => navigate('/products')}
                  className="inline-flex items-center gap-1 h-9 rounded-lg border border-border px-3 text-sm hover:bg-secondary"
                >
                  <Utensils className="h-4 w-4" /> Menu
                </button>
                <button
                  onClick={() => navigate('/stock')}
                  className="inline-flex items-center gap-1 h-9 rounded-lg border border-border px-3 text-sm hover:bg-secondary"
                >
                  <Boxes className="h-4 w-4" /> Stock
                </button>
                <button
                  onClick={async () => { await signOut(); navigate("/auth"); }}
                  className="inline-flex items-center gap-1 h-9 rounded-lg border border-border px-3 text-sm hover:bg-secondary"
                >
                  <LogOut className="h-4 w-4" /> Logout
                </button>
              </>
            ) : (
              <button
                onClick={async () => { await signOut(); navigate("/auth"); }}
                className="inline-flex items-center gap-1 h-9 rounded-lg border border-border px-3 text-sm hover:bg-secondary"
              >
                <LogOut className="h-4 w-4" /> Logout
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4">
        {lastError && (
          <div className="mb-4 rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
            {lastError}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Clock className="h-5 w-5 animate-spin mr-2" /> Loading orders…
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <ChefHat className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <p className="text-lg font-medium">No open orders</p>
            <p className="text-sm text-muted-foreground">New sale tickets will appear here.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {orders.map((order) => {
              const status = (order.status as KitchenStatus) || "pending";
              const items = (order.items ?? []) as unknown as LineItem[];
              return (
                <div key={order.id} className="rounded-xl border border-border bg-card overflow-hidden">
                  <div className="px-4 py-3 flex items-center justify-between border-b border-border">
                    <div>
                      <p className="font-bold text-lg">#{order.ticket_number}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(order.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {order.table_name && (
                        <span className="text-xs font-semibold px-2 py-1 rounded-full bg-primary/10 text-primary">
                          {order.table_name}
                        </span>
                      )}
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${STATUS_COLOR[status]}`}>
                        {STATUS_LABEL[status]}
                      </span>
                    </div>
                  </div>
                  <ul className="px-4 py-3 space-y-2 divide-y divide-border/60">
                    {items.map((it, i) => (
                      <li key={i} className="pt-2 first:pt-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">
                            {it.name || (it.productId ? productNames[it.productId] : "Item")}
                          </span>
                          <span className="text-sm font-semibold">× {it.quantity ?? 1}</span>
                        </div>
                        {Array.isArray(it.modifiers) && it.modifiers.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {it.modifiers.map((m, mi) => (
                              <span key={mi} className="text-[11px] bg-secondary/60 rounded px-1.5 py-0.5 text-muted-foreground">
                                {m.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="px-4 py-3 border-t border-border flex gap-2">
                    <button
                      onClick={() => void advanceStatus(order)}
                      className="flex-1 rounded-lg bg-primary text-primary-foreground font-semibold py-2 text-sm hover:opacity-90 transition"
                    >
                      {status === "pending" ? "Start preparing" : status === "preparing" ? "Mark ready" : status === "ready" ? "Mark served" : "Next"}
                    </button>
                    {status !== "served" && (
                      <button
                        onClick={() => void setStatus(order, "cancelled")}
                        className="rounded-lg border border-destructive/30 text-destructive px-3 py-2 text-sm hover:bg-destructive/10 transition"
                        aria-label="Cancel ticket"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default Kitchen;

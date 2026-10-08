import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LayoutGrid, LogOut, RotateCcw, Clock, User, ChefHat, ShoppingCart, Utensils, Boxes } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBusiness } from "@/hooks/useBusiness";
import { useProducts } from "@/hooks/useProducts";
import { useBusinessType } from "@/hooks/useBusinessType";
import { useDiningTables } from "@/hooks/useDiningTables";
import { useAuthContext } from "@/contexts/AuthContext";
import type { Database } from "@/integrations/supabase/types";

type KitchenOrderRow = Database["public"]["Tables"]["kitchen_orders"]["Row"];
type KitchenStatus = "pending" | "preparing" | "ready" | "served" | "cancelled";

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

const DiningTabs = () => {
  const navigate = useNavigate();
  const { user, role, signOut } = useAuthContext();
  const { business, isLoading: bizLoading } = useBusiness(user?.id);
  const { isRestaurant } = useBusinessType(business?.id, business?.businessType);
  const { activeProducts } = useProducts(business?.id ?? undefined);
  const { tables, isLoading: tablesLoading } = useDiningTables(business?.id);

  const [orders, setOrders] = useState<KitchenOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [selectedFloor, setSelectedFloor] = useState<string>("");

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
      setLastError(e instanceof Error ? e.message : "Failed to load orders");
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
      .channel("dining-tabs-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "kitchen_orders", filter: `business_id=eq.${business.id}` },
        (payload) => {
          const row = payload.new as KitchenOrderRow;
          if (!row) return;
          if (payload.eventType === "DELETE") {
            setOrders((prev) => prev.filter((o) => o.id !== row.id));
          } else if (row.status === "served" || row.status === "cancelled") {
            setOrders((prev) => prev.filter((o) => o.id !== row.id));
          } else {
            setOrders((prev) => {
              const exists = prev.some((o) => o.id === row.id);
              return exists ? prev.map((o) => (o.id === row.id ? row : o)) : [...prev, row];
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [business?.id]);

  const setStatus = async (order: KitchenOrderRow, status: KitchenStatus) => {
    const { error } = await supabase.rpc("update_kitchen_order_status", {
      p_order_id: order.id,
      p_status: status,
    });
    if (error) {
      setLastError(error.message || "Failed to update");
    }
  };

  const advanceStatus = async (order: KitchenOrderRow) => {
    const current = (order.status as KitchenStatus) || "pending";
    const idx = STATUS_FLOW.indexOf(current);
    const next = STATUS_FLOW[idx + 1];
    if (next) await setStatus(order, next);
  };

  // Floors derived from tables (any linked active table ever used + managed floors)
  const floors = useMemo(() => {
    const set = new Set<string>();
    for (const t of tables) set.add(t.floor?.trim() ?? "");
    const visible = selectedFloor ? (selectedFloor === "" ? [...set] : [selectedFloor]) : [...set];
    return visible.sort();
  }, [tables, selectedFloor]);

  const ordersByTable = useMemo(() => {
    const map: Record<string, KitchenOrderRow[]> = {};
    for (const o of orders) {
      if (!o.table_id) continue;
      (map[o.table_id] ??= []).push(o);
    }
    return map;
  }, [orders]);

  const activeTables = tables.filter((t) => t.is_active);
  const occupiedIds = new Set(Object.keys(ordersByTable));

  if (bizLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card border-b border-border px-4 py-3 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <LayoutGrid className="h-5 w-5" />
            </span>
            <div>
              <h1 className="font-display font-bold text-lg leading-tight">Tables</h1>
              <p className="text-xs text-muted-foreground">{business?.name ?? "…"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:inline">{orders.length} open orders</span>
            <button
              onClick={() => void loadOrders()}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border hover:bg-secondary"
              aria-label="Refresh"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            {(role === "owner" || role === "super_admin") && (
              <button
                onClick={() => navigate("/dashboard")}
                className="inline-flex items-center gap-1 h-9 rounded-lg border border-border px-3 text-sm hover:bg-secondary"
              >
                Dashboard
              </button>
            )}
            {role === "manager" && (
              <>
                <button
                  onClick={() => navigate("/pos")}
                  className="inline-flex items-center gap-1 h-9 rounded-lg border border-border px-3 text-sm hover:bg-secondary"
                >
                  <ShoppingCart className="h-4 w-4" /> Till
                </button>
                <button
                  onClick={() => navigate("/products")}
                  className="inline-flex items-center gap-1 h-9 rounded-lg border border-border px-3 text-sm hover:bg-secondary"
                >
                  <Utensils className="h-4 w-4" /> Menu
                </button>
                <button
                  onClick={() => navigate("/stock")}
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
            )}
            {role !== "owner" && role !== "manager" && role !== "super_admin" && (
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

        {!isRestaurant ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <LayoutGrid className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <p className="text-lg font-medium">Tables are for restaurant businesses</p>
            <p className="text-sm text-muted-foreground mb-4">Switch your business type to Restaurant to manage tables.</p>
            <button
              onClick={() => navigate("/settings")}
              className="rounded-lg bg-primary text-primary-foreground font-semibold px-4 py-2 text-sm hover:opacity-90 transition"
            >
              Open Settings
            </button>
          </div>
        ) : (
          <>
            {/* Floor filter */}
            {floors.length > 1 && (
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  onClick={() => setSelectedFloor("")}
                  className={`rounded-full px-3 py-1 text-sm border border-border hover:bg-secondary transition ${selectedFloor === "" ? "bg-primary text-primary-foreground border-primary" : ""}`}
                >
                  All floors
                </button>
                {floors.map((f) => (
                  <button
                    key={f}
                    onClick={() => setSelectedFloor(f === selectedFloor ? "" : f)}
                    className={`rounded-full px-3 py-1 text-sm border border-border hover:bg-secondary transition ${selectedFloor === f ? "bg-primary text-primary-foreground border-primary" : ""}`}
                  >
                    {f || "General"}
                  </button>
                ))}
              </div>
            )}

            {tablesLoading || loading ? (
              <div className="flex items-center justify-center py-20 text-muted-foreground">
                <Clock className="h-5 w-5 animate-spin mr-2" /> Loading tables…
              </div>
            ) : activeTables.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <LayoutGrid className="h-12 w-12 text-muted-foreground/40 mb-4" />
                <p className="text-lg font-medium">No tables yet</p>
                <p className="text-sm text-muted-foreground mb-4">Add tables in Settings → Dining Tables.</p>
                <button
                  onClick={() => navigate("/settings")}
                  className="rounded-lg bg-primary text-primary-foreground font-semibold px-4 py-2 text-sm hover:opacity-90 transition"
                >
                  Manage tables
                </button>
              </div>
            ) : (
              floors.map((floor) => {
                const floorTables = activeTables.filter((t) => (t.floor?.trim() ?? "") === (floor === "General" ? "" : floor));
                if (floorTables.length === 0) return null;
                return (
                  <div key={floor} className="mb-8">
                    <h2 className="font-display font-semibold text-sm uppercase tracking-wide text-muted-foreground mb-3">
                      {floor || "General"}
                    </h2>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                      {floorTables.map((t) => {
                        const tableOrders = ordersByTable[t.id] ?? [];
                        const occupied = tableOrders.length > 0;
                        const expanded = expandedTable === t.id;
                        return (
                          <div
                            key={t.id}
                            className={`rounded-xl border bg-card overflow-hidden transition ${
                              occupied
                                ? expanded
                                  ? "border-amber-500 ring-2 ring-amber-500/30"
                                  : "border-amber-500/60 shadow-sm"
                                : "border-border"
                            }`}
                          >
                            <button
                              onClick={() => setExpandedTable(expanded ? null : t.id)}
                              className={`w-full px-4 py-4 flex items-center justify-between gap-2 ${occupied ? "hover:bg-amber-500/5" : "hover:bg-secondary/40"} transition`}
                            >
                              <div className="text-left min-w-0">
                                <p className="font-semibold truncate">{t.name}</p>
                                <p className="text-xs text-muted-foreground flex items-center gap-1">
                                  <User className="h-3 w-3" /> Seats {t.capacity}
                                </p>
                              </div>
                              {occupied ? (
                                <span className="shrink-0 text-xs font-semibold px-2 py-1 rounded-full bg-amber-500/15 text-amber-600">
                                  {tableOrders.length} open
                                </span>
                              ) : (
                                <span className="shrink-0 text-xs font-semibold px-2 py-1 rounded-full bg-green-500/15 text-green-600">
                                  Free
                                </span>
                              )}
                            </button>

                            {expanded && (
                              <div className="border-t border-border px-3 py-3 space-y-2">
                                {tableOrders.length === 0 ? (
                                  <p className="text-sm text-muted-foreground">Table is free.</p>
                                ) : (
                                  tableOrders.map((order) => {
                                    const status = (order.status as KitchenStatus) || "pending";
                                    const items = (order.items ?? []) as unknown as LineItem[];
                                    return (
                                      <div key={order.id} className="rounded-lg bg-secondary/40 p-2.5">
                                        <div className="flex items-center justify-between gap-2">
                                          <div>
                                            <p className="text-sm font-semibold">#{order.ticket_number}</p>
                                            <p className="text-[11px] text-muted-foreground">
                                              {new Date(order.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                            </p>
                                          </div>
                                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                            {STATUS_LABEL[status]}
                                          </span>
                                        </div>
                                        <ul className="mt-2 space-y-1">
                                          {items.map((it, i) => (
                                            <li key={i} className="text-sm flex items-center justify-between gap-2">
                                              <span className="truncate">
                                                {it.name || (it.productId ? productNames[it.productId] : "Item")}
                                                {Array.isArray(it.modifiers) && it.modifiers.length > 0 && (
                                                  <span className="text-xs text-muted-foreground">
                                                    {" "}({it.modifiers.map((m) => m.name).join(", ")})
                                                  </span>
                                                )}
                                              </span>
                                              <span className="shrink-0 font-semibold">× {it.quantity ?? 1}</span>
                                            </li>
                                          ))}
                                        </ul>
                                        <div className="mt-2 flex gap-2">
                                          <button
                                            onClick={() => void advanceStatus(order)}
                                            className="flex-1 rounded-lg bg-primary text-primary-foreground font-semibold py-1.5 text-xs hover:opacity-90 transition"
                                          >
                                            {status === "pending" ? "Start preparing" : status === "preparing" ? "Mark ready" : status === "ready" ? "Mark served · free table" : "Next"}
                                          </button>
                                          {status !== "served" && status !== "cancelled" && (
                                            <button
                                              onClick={() => void setStatus(order, "cancelled")}
                                              className="rounded-lg border border-destructive/30 text-destructive px-3 py-1.5 text-xs hover:bg-destructive/10 transition"
                                            >
                                              Cancel
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}

            {/* Order routing hint */}
            <div className="rounded-lg bg-muted/40 border border-border px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
              <ChefHat className="h-4 w-4 shrink-0" />
              Served or cancelled orders automatically free the table. Assign a table from the POS before completing a sale to seat a party.
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default DiningTabs;
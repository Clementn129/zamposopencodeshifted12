import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Factory, Coins, TrendingUp, Boxes, ArrowUpRight, Sparkles, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { formatZMW } from "@/lib/currency";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

/** A completed production order in the selected period. */
type Order = {
  id: string;
  product_id: string;
  quantity_to_produce: number;
  unit_cost: number;
  total_cost: number;
  completed_at: string | null;
  created_at: string;
};

type ProductLite = {
  id: string;
  name: string;
  price: number;
  cost_price: number | null;
  stock: number;
  product_type: string;
};

interface ProductionReportProps {
  businessId: string;
  from: Date;
  to: Date;
  periodLabel: string;
}

const ProductionReport = ({ businessId, from, to, periodLabel }: ProductionReportProps) => {
  const { isOnline } = useOnlineStatus();
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!businessId) return;
    if (!isOnline) {
      setOrders([]);
      setProducts([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const [orderRes, prodRes] = await Promise.all([
          supabase
            .from("production_orders")
            .select("id, product_id, quantity_to_produce, unit_cost, total_cost, completed_at, created_at")
            .eq("business_id", businessId)
            .eq("status", "COMPLETED")
            .gte("completed_at", from.toISOString())
            .lte("completed_at", to.toISOString())
            .order("completed_at", { ascending: false })
            .limit(5000),
          supabase
            .from("products")
            .select("id, name, price, cost_price, stock, product_type")
            .eq("business_id", businessId)
            .limit(5000),
        ]);
        if (cancelled) return;
        if (orderRes.error) throw orderRes.error;
        if (prodRes.error) throw prodRes.error;
        setOrders((orderRes.data ?? []) as Order[]);
        setProducts((prodRes.data ?? []) as ProductLite[]);
      } catch (e) {
        console.error("Production report failed:", e);
        if (!cancelled) {
          setOrders([]);
          setProducts([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [businessId, from, to, isOnline]);

  const productById = useMemo(() => {
    const m = new Map<string, ProductLite>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const summary = useMemo(() => {
    let units = 0;
    let cost = 0;
    for (const o of orders) {
      units += Number(o.quantity_to_produce) || 0;
      cost += Number(o.total_cost) || 0;
    }
    const avgUnit = units > 0 ? cost / units : 0;

    // Raw material value currently on hand (cost basis).
    let rawValue = 0;
    for (const p of products) {
      if (p.product_type === "RAW_MATERIAL") {
        rawValue += (Number(p.stock) || 0) * (Number(p.cost_price) || 0);
      }
    }
    return { units, cost, avgUnit, rawValue, orderCount: orders.length };
  }, [orders, products]);

  // Per-finished-good roll-up for the period.
  const byProduct = useMemo(() => {
    const map = new Map<string, { qty: number; cost: number }>();
    for (const o of orders) {
      const cur = map.get(o.product_id) ?? { qty: 0, cost: 0 };
      cur.qty += Number(o.quantity_to_produce) || 0;
      cur.cost += Number(o.total_cost) || 0;
      map.set(o.product_id, cur);
    }
    return [...map.entries()]
      .map(([productId, v]) => {
        const p = productById.get(productId);
        const unitCost = v.qty > 0 ? v.cost / v.qty : 0;
        const price = Number(p?.price) || 0;
        const retailValue = price * v.qty;
        return {
          productId,
          name: p?.name ?? "Unknown product",
          qty: v.qty,
          cost: v.cost,
          unitCost,
          retailValue,
          valueAdded: retailValue - v.cost,
          price,
        };
      })
      .sort((a, b) => b.cost - a.cost);
  }, [orders, productById]);

  // Value-added totals (estimate at current selling price, tax-inclusive).
  const valueAdded = useMemo(() => {
    let retailTotal = 0;
    let materialTotal = 0;
    for (const r of byProduct) {
      retailTotal += r.retailValue;
      materialTotal += r.cost;
    }
    return { retailTotal, materialTotal, added: retailTotal - materialTotal };
  }, [byProduct]);

  if (!isOnline) {
    return (
      <p className="text-center text-sm text-muted-foreground py-8">
        Production reports need a connection.
      </p>
    );
  }

  if (loading) {
    return <p className="text-center text-sm text-muted-foreground py-8">Loading...</p>;
  }

  if (orders.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground py-8">
        No completed production in {periodLabel.toLowerCase()}. Complete a work order on the
        Production page to see costs here.
      </p>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={<Factory className="w-4 h-4" />} label={`Units Produced · ${periodLabel}`} value={summary.units.toString()} highlight />
        <StatCard icon={<Coins className="w-4 h-4" />} label="Production Cost" value={formatZMW(summary.cost)} />
        <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Avg Cost / Unit" value={formatZMW(summary.avgUnit)} />
        <StatCard icon={<Boxes className="w-4 h-4" />} label="Raw Material On Hand" value={formatZMW(summary.rawValue)} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Boxes className="h-4 w-4" /> Production by Product · {periodLabel}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {byProduct.map((r) => (
            <div key={r.productId} className="flex items-center justify-between gap-2 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
              <span className="truncate pr-2">{r.name}</span>
              <span className="tabular-nums text-right shrink-0">
                {r.qty} units · {formatZMW(r.cost)}{" "}
                <span className="text-muted-foreground">({formatZMW(r.unitCost)}/unit)</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Estimated Value Added · {periodLabel}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Material Cost</p>
              <p className="font-semibold tabular-nums">{formatZMW(valueAdded.materialTotal)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Retail Value</p>
              <p className="font-semibold tabular-nums">{formatZMW(valueAdded.retailTotal)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Value Added</p>
              <p className="font-semibold tabular-nums text-green-600">{formatZMW(valueAdded.added)}</p>
            </div>
          </div>
          <div className="space-y-1">
            {byProduct.map((r) => (
              <div key={r.productId} className="flex items-center justify-between gap-2 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
                <span className="truncate pr-2">{r.name}</span>
                <span className="tabular-nums text-right shrink-0">
                  {formatZMW(r.cost)} → {formatZMW(r.retailValue)}{" "}
                  <span className="text-green-600">(+{formatZMW(r.valueAdded)})</span>
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Estimated value added — based on the current selling price of each finished good, not a
            guarantee. Tax and unsold stock are not accounted for.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" /> Production Runs · {periodLabel}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {orders.map((o) => {
            const p = productById.get(o.product_id);
            return (
              <div key={o.id} className="flex items-start justify-between gap-2 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
                <div className="min-w-0 flex items-start gap-2">
                  <ArrowUpRight className="h-4 w-4 mt-0.5 shrink-0 text-green-600" />
                  <div className="min-w-0">
                    <p className="truncate">
                      <span className="font-medium">+{Number(o.quantity_to_produce) || 0}</span> · {p?.name ?? "Unknown product"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {format(new Date(o.completed_at ?? o.created_at), "dd MMM yyyy, HH:mm")}
                    </p>
                  </div>
                </div>
                <span className="tabular-nums text-xs text-muted-foreground shrink-0">
                  {formatZMW(Number(o.total_cost) || 0)}
                </span>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </>
  );
};

const StatCard = ({ icon, label, value, highlight }: { icon: React.ReactNode; label: string; value: string; highlight?: boolean }) => (
  <Card>
    <CardContent className="p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <p className={`mt-1 font-semibold tabular-nums ${highlight ? "text-base" : "text-sm"}`}>{value}</p>
    </CardContent>
  </Card>
);

export default ProductionReport;

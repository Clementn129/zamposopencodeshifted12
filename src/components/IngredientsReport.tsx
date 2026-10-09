import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Boxes, AlertTriangle, PackageX, Coins, TrendingDown, History, ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { formatZMW } from "@/lib/currency";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

/** Normalised ingredient row used by the ingredient report. */
type Ingredient = {
  id: string;
  name: string;
  unit: string;
  stock: number;
  cost_per_unit: number;
  low_stock_warning: number;
};

/** One row of the ingredient_stock_movements ledger. */
type Movement = {
  id: string;
  ingredient_id: string;
  delta: number;
  quantity_after: number;
  movement_type: string;
  note: string | null;
  actor_name: string | null;
  created_at: string;
};

const MOVEMENT_LABELS: Record<string, string> = {
  purchase: "Restock",
  dish_sale: "Used in dish",
  dish_refund: "Dish refund",
  sale_delete: "Sale voided",
  adjustment_add: "Adjustment +",
  adjustment_remove: "Adjustment −",
  manual_edit: "Manual edit",
  other: "Other",
};

interface IngredientsReportProps {
  businessId: string;
  from: Date;
  to: Date;
  periodLabel: string;
}

const IngredientsReport = ({ businessId, from, to, periodLabel }: IngredientsReportProps) => {
  const { isOnline } = useOnlineStatus();
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>("all");

  useEffect(() => {
    if (!businessId) return;
    if (!isOnline) {
      setIngredients([]);
      setMovements([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const [ingRes, mvRes] = await Promise.all([
          supabase
            .from("ingredients")
            .select("id, name, unit, stock, cost_per_unit, low_stock_warning")
            .eq("business_id", businessId)
            .eq("is_active", true)
            .order("name"),
          supabase
            .from("ingredient_stock_movements")
            .select("id, ingredient_id, delta, quantity_after, movement_type, note, actor_name, created_at")
            .eq("business_id", businessId)
            .gte("created_at", from.toISOString())
            .lte("created_at", to.toISOString())
            .order("created_at", { ascending: false })
            .limit(5000),
        ]);
        if (cancelled) return;
        if (ingRes.error) throw ingRes.error;
        setIngredients((ingRes.data ?? []) as Ingredient[]);
        if (mvRes.error) {
          console.warn("Ingredient movements unavailable:", mvRes.error.message);
          setMovements([]);
        } else {
          setMovements((mvRes.data ?? []) as Movement[]);
        }
      } catch (e) {
        console.error("Ingredient report failed:", e);
        if (!cancelled) {
          setIngredients([]);
          setMovements([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [businessId, from, to, isOnline]);

  const costById = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of ingredients) m.set(i.id, Number(i.cost_per_unit) || 0);
    return m;
  }, [ingredients]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of ingredients) m.set(i.id, i.name);
    return m;
  }, [ingredients]);

  const summary = useMemo(() => {
    let value = 0;
    let low = 0;
    let out = 0;
    for (const i of ingredients) {
      const s = Number(i.stock) || 0;
      value += s * (Number(i.cost_per_unit) || 0);
      if (s <= 0) out++;
      else if (s <= (Number(i.low_stock_warning) || 0)) low++;
    }
    let consumedQty = 0;
    let consumedValue = 0;
    for (const m of movements) {
      const d = Number(m.delta) || 0;
      if (d < 0) {
        consumedQty += -d;
        consumedValue += -d * (costById.get(m.ingredient_id) ?? 0);
      }
    }
    return { value, low, out, consumedQty, consumedValue };
  }, [ingredients, movements, costById]);

  const sortedIngredients = useMemo(() => {
    return [...ingredients].sort((a, b) => {
      const rank = (i: Ingredient) => {
        const s = Number(i.stock) || 0;
        if (s <= 0) return 0;
        if (s <= (Number(i.low_stock_warning) || 0)) return 1;
        return 2;
      };
      const r = rank(a) - rank(b);
      return r !== 0 ? r : a.name.localeCompare(b.name);
    });
  }, [ingredients]);

  const selected = useMemo(
    () => (selectedId === "all" ? null : ingredients.find((i) => i.id === selectedId) ?? null),
    [ingredients, selectedId],
  );

  const rows = useMemo(
    () => (selectedId === "all" ? movements : movements.filter((m) => m.ingredient_id === selectedId)),
    [movements, selectedId],
  );

  if (!isOnline) {
    return (
      <p className="text-center text-sm text-muted-foreground py-8">
        Ingredient reports need a connection.
      </p>
    );
  }

  if (loading) {
    return <p className="text-center text-sm text-muted-foreground py-8">Loading...</p>;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={<Coins className="w-4 h-4" />} label="Stock Value (Cost)" value={formatZMW(summary.value)} highlight />
        <StatCard icon={<TrendingDown className="w-4 h-4" />} label={`Used · ${periodLabel}`} value={formatZMW(summary.consumedValue)} />
        <StatCard icon={<AlertTriangle className="w-4 h-4" />} label="Low Stock" value={summary.low.toString()} />
        <StatCard icon={<PackageX className="w-4 h-4" />} label="Out of Stock" value={summary.out.toString()} />
      </div>

      {ingredients.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-8">
          No ingredients yet. Add them under Products → Ingredients.
        </p>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Boxes className="h-4 w-4" /> Current Stock
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {sortedIngredients.map((i) => {
                const s = Number(i.stock) || 0;
                const low = s <= (Number(i.low_stock_warning) || 0);
                return (
                  <div key={i.id} className="flex items-center justify-between gap-2 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
                    <span className="truncate pr-2 flex items-center gap-2">
                      {i.name}
                      {s <= 0 ? (
                        <Badge variant="destructive" className="text-[10px] font-normal">Out</Badge>
                      ) : low ? (
                        <Badge variant="outline" className="text-[10px] font-normal text-amber-600 border-amber-600">Low</Badge>
                      ) : null}
                    </span>
                    <span className="tabular-nums text-right shrink-0">
                      {s} {i.unit} · {formatZMW(s * (Number(i.cost_per_unit) || 0))}
                    </span>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <History className="h-4 w-4" /> Ingredient Activity · {periodLabel}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Select value={selectedId} onValueChange={setSelectedId}>
                <SelectTrigger>
                  <SelectValue placeholder="All ingredients" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All ingredients</SelectItem>
                  {ingredients.map((i) => (
                    <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selected && (
                <p className="text-xs text-muted-foreground">
                  {selected.name}: {Number(selected.stock) || 0} {selected.unit} on hand ·{" "}
                  {formatZMW((Number(selected.stock) || 0) * (Number(selected.cost_per_unit) || 0))} at cost
                </p>
              )}

              {rows.length === 0 ? (
                <p className="text-muted-foreground">No movements in this period.</p>
              ) : (
                rows.map((m) => {
                  const d = Number(m.delta) || 0;
                  return (
                    <div key={m.id} className="flex items-start justify-between gap-2 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
                      <div className="min-w-0 flex items-start gap-2">
                        {d >= 0 ? (
                          <ArrowDownRight className="h-4 w-4 mt-0.5 shrink-0 text-green-600" />
                        ) : (
                          <ArrowUpRight className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate">
                            <span className="font-medium">{d >= 0 ? "+" : "-"}{Math.abs(d)}</span> · {MOVEMENT_LABELS[m.movement_type] ?? m.movement_type}
                            {selectedId === "all" && nameById.get(m.ingredient_id) ? ` · ${nameById.get(m.ingredient_id)}` : ""}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {format(new Date(m.created_at), "dd MMM yyyy, HH:mm")}
                            {m.actor_name ? ` · ${m.actor_name}` : ""}
                            {m.note ? ` · ${m.note}` : ""}
                          </p>
                        </div>
                      </div>
                      <span className="tabular-nums text-xs text-muted-foreground shrink-0">bal {Number(m.quantity_after) || 0}</span>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground px-1">
            “Used” is the estimated cost of ingredients consumed in the period (restocks excluded).
            Movements are dated by when they were recorded.
          </p>
        </>
      )}
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

export default IngredientsReport;

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Download, TrendingUp, ShoppingCart, Receipt, Wallet, AlertCircle, HardHat, Boxes, AlertTriangle, PackageX, Coins, ChefHat, Clock, History, ArrowDownRight, ArrowUpRight } from "lucide-react";
import { format, subDays, subMonths, startOfMonth, endOfMonth, startOfYear, endOfYear, startOfDay, endOfDay } from "date-fns";
import { lusakaDayRange, lusakaWeekRange, lusakaMonthRange, lusakaDateLabel } from "@/lib/dateRange";
import { useBusinessType } from "@/hooks/useBusinessType";
import IngredientsReport from "@/components/IngredientsReport";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import ConnectionStatus from "@/components/ConnectionStatus";
import { useAuthContext } from "@/contexts/AuthContext";
import { useBusiness } from "@/hooks/useBusiness";
import { supabase } from "@/integrations/supabase/client";
import { formatZMW } from "@/lib/currency";
import { useToast } from "@/hooks/use-toast";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { getCachedSalesHistory, getCachedExpenses, getCachedDebtors, getCachedProducts } from "@/lib/offlineStorage";
import { CAPEX_CATEGORY_LABELS } from "@/lib/capex";

type Period = "today" | "week" | "month";

/** Normalised product row used only by the Stock report. */
type StockRow = {
  id: string;
  name: string;
  stock: number;
  cost: number;
  price: number;
  minimum: number;
  itemType: string;
  active: boolean;
  trackStock: boolean;
};

/** Minimal shape of a `products` row as selected for the Stock report. */
type ProductRow = {
  id: string;
  name: string;
  price: number | null;
  cost_price: number | null;
  stock: number | null;
  minimum_stock: number | null;
  is_active: boolean | null;
  item_type: string | null;
  track_stock: boolean | null;
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** One row in the Item History timeline (a stock-in, a stock-out or a sale). */
type ItemEvent = {
  ts: string;
  direction: "in" | "out";
  label: string;
  qty: number;
  value: number | null;
  note: string | null;
  balance: number | null;
};

const MOVEMENT_LABELS: Record<string, string> = {
  sale: "Sale",
  sale_return: "Sale return",
  sale_delete: "Sale voided",
  delivery_note: "Delivery note",
  adjustment_add: "Stock added",
  adjustment_remove: "Stock removed",
  manual_edit: "Manual edit",
  import: "Import",
  variant_create: "Variant created",
  product_create: "Opening stock",
  restoration: "Restored",
  other: "Other",
};

type ItemRange = { from: Date; to: Date; label: string };

const ITEM_PERIOD_PRESETS = [
  { value: "15", label: "Last 15 days" },
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
  { value: "specific_month", label: "Specific month…" },
  { value: "custom", label: "Custom range…" },
] as const;

const ITEM_YEARS = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i);

const Reports = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { isOnline } = useOnlineStatus();
  const { user, isLoading: authLoading } = useAuthContext();
  const { business, isLoading: bizLoading } = useBusiness(user?.id);
  const { isRestaurant } = useBusinessType(business?.id, business?.businessType);
  const [period, setPeriod] = useState<Period>("today");
  const [reportView, setReportView] = useState<"sales" | "stock" | "tickets" | "items" | "ingredients">(
    (location.state as { view?: string } | null)?.view === "tickets" ? "tickets" : "sales"
  );
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [sales, setSales] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [debtors, setDebtors] = useState<any[]>([]);
  // CAPEX is fetched separately and never blocks the report: a missing `capex`
  // table must not take revenue/profit down with it.
  const [capex, setCapex] = useState<any[]>([]);
  // Current stock snapshot for the Stock report (not period-bound).
  const [stock, setStock] = useState<StockRow[]>([]);
  // Kitchen tickets for the selected period (restaurant businesses only).
  const [tickets, setTickets] = useState<any[]>([]);
  // Item-level history: one product over a chosen period, stock in/out + sales.
  const [itemProductId, setItemProductId] = useState<string>("");
  const [itemPreset, setItemPreset] = useState<string>("30");
  const [itemMonth, setItemMonth] = useState<number>(() => new Date().getMonth());
  const [itemYear, setItemYear] = useState<number>(() => new Date().getFullYear());
  const [itemCustomFrom, setItemCustomFrom] = useState<string>(() => format(subDays(new Date(), 30), "yyyy-MM-dd"));
  const [itemCustomTo, setItemCustomTo] = useState<string>(() => format(new Date(), "yyyy-MM-dd"));
  const [itemEvents, setItemEvents] = useState<ItemEvent[]>([]);
  const [itemBoundary, setItemBoundary] = useState<{ sumGeFrom: number; sumGtTo: number }>({ sumGeFrom: 0, sumGtTo: 0 });
  const [itemLoading, setItemLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  const range = useMemo(() => {
    if (period === "today") return lusakaDayRange();
    if (period === "week") return lusakaWeekRange();
    return lusakaMonthRange(new Date(selectedYear, selectedMonth, 1));
  }, [period, selectedMonth, selectedYear]);

  const periodLabel = useMemo(() => {
    if (period === "today") return "Today";
    if (period === "week") return "This Week";
    return `${MONTHS[selectedMonth]} ${selectedYear}`;
  }, [period, selectedMonth, selectedYear]);

  const itemRange = useMemo<ItemRange>(() => {
    const now = new Date();
    const endNow = endOfDay(now);
    switch (itemPreset) {
      case "15":
        return { from: startOfDay(subDays(now, 15)), to: endNow, label: "Last 15 days" };
      case "60":
        return { from: startOfDay(subDays(now, 60)), to: endNow, label: "Last 60 days" };
      case "this_month":
        return { from: startOfMonth(now), to: endNow, label: `This month · ${MONTHS[now.getMonth()]} ${now.getFullYear()}` };
      case "last_month": {
        const d = subMonths(now, 1);
        return { from: startOfMonth(d), to: endOfMonth(d), label: `Last month · ${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
      }
      case "this_year":
        return { from: startOfYear(now), to: endNow, label: `This year · ${now.getFullYear()}` };
      case "last_year": {
        const y = now.getFullYear() - 1;
        return { from: startOfYear(new Date(y, 0, 1)), to: endOfYear(new Date(y, 11, 31)), label: `Last year · ${y}` };
      }
      case "specific_month": {
        const d = new Date(itemYear, itemMonth, 1);
        return { from: startOfMonth(d), to: endOfMonth(d), label: `${MONTHS[itemMonth]} ${itemYear}` };
      }
      case "custom": {
        const f = new Date(`${itemCustomFrom}T00:00:00`);
        const t = new Date(`${itemCustomTo}T23:59:59.999`);
        const from = isNaN(f.getTime()) ? startOfDay(subDays(now, 30)) : startOfDay(f);
        const to = isNaN(t.getTime()) ? endNow : endOfDay(t);
        return { from, to, label: `${format(from, "dd MMM yyyy")} – ${format(to, "dd MMM yyyy")}` };
      }
      case "30":
      default:
        return { from: startOfDay(subDays(now, 30)), to: endNow, label: "Last 30 days" };
    }
  }, [itemPreset, itemMonth, itemYear, itemCustomFrom, itemCustomTo]);


  const fetchAll = async () => {
    if (!business?.id) return;
    setLoading(true);
    try {
      if (!isOnline) {
        const [cachedSales, cachedExpenses, cachedDebtors, cachedProducts] = await Promise.all([
          getCachedSalesHistory(business.id),
          getCachedExpenses(business.id),
          getCachedDebtors(business.id),
          getCachedProducts(business.id),
        ]);
        const from = range.from.getTime();
        const to = range.to.getTime();
        setTickets([]);
        setSales(cachedSales.filter(s => {
          const t = new Date(s.createdAt).getTime();
          return t >= from && t <= to;
        }));
        setExpenses(cachedExpenses.filter(e => {
          const t = new Date(e.expense_date).getTime();
          return t >= from && t <= to;
        }));
        setDebtors(cachedDebtors.map(d => ({ id: d.id, amount_owed: d.amountOwed, amount_paid: d.amountPaid, balance_due: d.amountOwed - d.amountPaid, status: d.status })));
        setStock(cachedProducts.map((p) => ({
          id: p.id,
          name: p.name,
          stock: Number(p.stock) || 0,
          cost: Number(p.costPrice) || 0,
          price: Number(p.price) || 0,
          minimum: Number(p.minimumStock) || 0,
          itemType: (p as { itemType?: string }).itemType ?? "product",
          active: p.isActive !== false,
          trackStock: p.trackStock !== false,
        })));
        toast({ title: "Offline data", description: "Showing cached report data." });
        return;
      }

      const [{ data: s }, { data: e }, { data: d }, { data: p }] = await Promise.all([
        supabase
          .from("sales")
          .select("id, total, items, tax_amount, payment_method, cashier_name, status, created_at")
          .eq("business_id", business.id)
          .gte("created_at", range.from.toISOString())
          .lte("created_at", range.to.toISOString())
          .limit(1000),
        supabase
          .from("expenses")
          .select("id, amount, category, expense_date")
          .eq("business_id", business.id)
          .gte("expense_date", lusakaDateLabel(range.from))
          .lte("expense_date", lusakaDateLabel(range.to))
          .limit(1000),
        supabase
          .from("debtors")
          .select("id, amount_owed, amount_paid, status")
          .eq("business_id", business.id)
          .limit(5000),
        supabase
          .from("products")
          .select("id, name, price, cost_price, stock, minimum_stock, is_active, item_type, track_stock")
          .eq("business_id", business.id)
          .limit(5000),
      ]);
      setSales(s ?? []);
      setExpenses(e ?? []);
      setDebtors(d ?? []);
      setStock(((p ?? []) as ProductRow[]).map((r) => ({
        id: r.id,
        name: r.name,
        stock: Number(r.stock) || 0,
        cost: Number(r.cost_price) || 0,
        price: Number(r.price) || 0,
        minimum: Number(r.minimum_stock) || 0,
        itemType: r.item_type ?? "product",
        active: r.is_active !== false,
        trackStock: r.track_stock !== false,
      })));

      // Kitchen tickets (restaurant only). Filtered by created_at within range;
      // the one-to-one sales embed gives the authoritative ticket value.
      setTickets([]);
      if (isRestaurant) {
        const { data: t, error: tkErr } = await supabase
          .from("kitchen_orders")
          .select("id, status, created_at, served_at, cancelled_at, ticket_number, table_name, sales(total)")
          .eq("business_id", business.id)
          .gte("created_at", range.from.toISOString())
          .lte("created_at", range.to.toISOString())
          .limit(2000);
        if (tkErr) {
          console.warn("Kitchen tickets unavailable:", tkErr.message);
        } else {
          setTickets(t ?? []);
        }
      }

      // CAPEX only when the feature is on. Offline it simply stays empty rather
      // than showing a stale figure for a period the user can no longer verify.
      if (business.capexEnabled && isOnline) {
        const { data: capexData, error: capexErr } = await supabase
          .from("capex")
          .select("id, amount, capex_category, purchase_date")
          .eq("business_id", business.id)
          .gte("purchase_date", lusakaDateLabel(range.from))
          .lte("purchase_date", lusakaDateLabel(range.to))
          .limit(1000);
        if (capexErr) {
          // Silent by design. The box just stays hidden.
          console.warn("CAPEX unavailable:", capexErr.message);
          setCapex([]);
        } else {
          setCapex(capexData ?? []);
        }
      } else {
        setCapex([]);
      }
    } catch (e: any) {
      console.error("Failed to fetch report data:", e);
      toast({ variant: "destructive", title: "Failed to load reports", description: e?.message ?? "Could not load data" });
    } finally {
      setLoading(false);
    }
  };

  const fetchAllRef = useRef(fetchAll);
  fetchAllRef.current = fetchAll;

  useEffect(() => {
    void fetchAllRef.current();
    const onChange = () => { void fetchAllRef.current(); };
    window.addEventListener("zampos:sales-changed", onChange);
    window.addEventListener("zampos:expenses-changed", onChange);
    window.addEventListener("zampos:debtors-changed", onChange);
    window.addEventListener("zampos:sync-complete", onChange);
    return () => {
      window.removeEventListener("zampos:sales-changed", onChange);
      window.removeEventListener("zampos:expenses-changed", onChange);
      window.removeEventListener("zampos:debtors-changed", onChange);
      window.removeEventListener("zampos:sync-complete", onChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business?.id, range.from, range.to]);


  // ── Item history (per-product stock in/out + sales) ──────────────────────
  useEffect(() => {
    if (reportView !== "items" || !business?.id || !itemProductId) {
      setItemEvents([]);
      setItemBoundary({ sumGeFrom: 0, sumGtTo: 0 });
      return;
    }
    let cancelled = false;
    const run = async () => {
      setItemLoading(true);
      try {
        const fromIso = itemRange.from.toISOString();
        const toIso = itemRange.to.toISOString();
        const fromMs = itemRange.from.getTime();
        const toMs = itemRange.to.getTime();
        const [{ data: mv }, { data: salesRows }] = await Promise.all([
          supabase
            .from("stock_movements")
            .select("id, delta, quantity_after, movement_type, note, created_at, effective_at")
            .eq("business_id", business.id)
            .eq("product_id", itemProductId)
            .or(`created_at.gte.${fromIso},effective_at.gte.${fromIso}`)
            .order("created_at", { ascending: false })
            .limit(5000),
          supabase
            .from("sales")
            .select("id, created_at, items, customer_name")
            .eq("business_id", business.id)
            .gte("created_at", fromIso)
            .lte("created_at", toIso)
            .order("created_at", { ascending: false })
            .limit(2000),
        ]);
        if (cancelled) return;
        const events: ItemEvent[] = [];
        // Sale/manual deductions are represented by the sales lines below, so
        // only non-sale outs are taken from the ledger to avoid double counting.
        const ledgerOutTypes = new Set(["adjustment_remove", "delivery_note"]);
        // Opening/closing balances come from the ledger: with a complete ledger,
        // stock_before(from) = current - sum(delta where ts >= from). We keep the
        // sum of deltas at/after each boundary to derive both edges exactly.
        let sumGeFrom = 0;
        let sumGtTo = 0;
        for (const m of (mv ?? []) as any[]) {
          const delta = Number(m.delta) || 0;
          const ts = m.effective_at ?? m.created_at;
          const tsMs = new Date(ts).getTime();
          if (tsMs >= fromMs) sumGeFrom += delta;
          if (tsMs > toMs) sumGtTo += delta;
          if (delta === 0 || tsMs < fromMs || tsMs > toMs) continue;
          const type = String(m.movement_type ?? "other");
          if (delta < 0 && !ledgerOutTypes.has(type)) continue;
          events.push({
            ts,
            direction: delta > 0 ? "in" : "out",
            label: MOVEMENT_LABELS[type] ?? type,
            qty: Math.abs(delta),
            value: null,
            note: m.note ?? null,
            balance: Number(m.quantity_after) || 0,
          });
        }
        for (const s of (salesRows ?? []) as any[]) {
          const items = Array.isArray(s.items) ? s.items : [];
          for (const it of items) {
            if (it?.productId !== itemProductId) continue;
            const qty = Number(it.quantity) || 0;
            if (qty <= 0) continue;
            const price = Number(it.finalSalePrice ?? it.price ?? 0) || 0;
            events.push({
              ts: s.created_at,
              direction: "out",
              label: "Sale",
              qty,
              value: price * qty,
              note: s.customer_name ?? null,
              balance: null,
            });
          }
        }
        events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
        setItemBoundary({ sumGeFrom, sumGtTo });
        setItemEvents(events);
      } catch (e) {
        console.error("Item history failed:", e);
        if (!cancelled) {
          setItemEvents([]);
          setItemBoundary({ sumGeFrom: 0, sumGtTo: 0 });
        }
      } finally {
        if (!cancelled) setItemLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportView, business?.id, itemProductId, itemRange.from, itemRange.to, isOnline]);

  const itemProduct = useMemo(
    () => stock.find((s) => s.id === itemProductId) ?? null,
    [stock, itemProductId],
  );

  const itemStats = useMemo(() => {
    let totalIn = 0;
    let totalOut = 0;
    let valueOut = 0;
    for (const e of itemEvents) {
      if (e.direction === "in") totalIn += e.qty;
      else {
        totalOut += e.qty;
        valueOut += e.value ?? 0;
      }
    }
    const current = Number(itemProduct?.stock) || 0;
    const starting = current - itemBoundary.sumGeFrom;
    const closing = current - itemBoundary.sumGtTo;
    return { totalIn, totalOut, net: closing - starting, valueOut, starting, closing };
  }, [itemEvents, itemBoundary, itemProduct]);


  const stats = useMemo(() => {
    const active = sales.filter((s) => s.status !== "refunded");
    const revenue = active.reduce((sum, s) => sum + (Number(s.total) || 0), 0);
    const tax = active.reduce((sum, s) => sum + (Number(s.tax_amount) || 0), 0);
    const cogs = active.reduce((sum, s) => {
      const items = Array.isArray(s.items) ? s.items : [];
      return sum + items.reduce((c: number, it: any) => {
        const unitCost = Number(it.costPrice ?? it.cost_price ?? it.cost ?? 0) || 0;
        return c + unitCost * (Number(it.quantity) || 0);
      }, 0);
    }, 0);
    const businessExp = expenses.filter((e) => e.category !== "personal").reduce((s, e) => s + Number(e.amount || 0), 0);
    const drawings = expenses.filter((e) => e.category === "personal").reduce((s, e) => s + Number(e.amount || 0), 0);
    // Tax collected is owed onward, not profit — exclude it from gross profit.
    const grossProfit = revenue - tax - cogs;
    const netProfit = grossProfit - businessExp;
    const outstanding = debtors.reduce((s, d) => s + Math.max(0, Number(d.amount_owed || 0) - Number(d.amount_paid || 0)), 0);
    const byPayment: Record<string, number> = {};
    active.forEach((s) => {
      const k = s.payment_method || "unknown";
      byPayment[k] = (byPayment[k] || 0) + Number(s.total || 0);
    });
    const byCashier: Record<string, { count: number; revenue: number }> = {};
    active.forEach((s) => {
      const k = s.cashier_name || "Owner";
      const cur = byCashier[k] || { count: 0, revenue: 0 };
      cur.count += 1;
      cur.revenue += Number(s.total || 0);
      byCashier[k] = cur;
    });
    return { revenue, tax, cogs, grossProfit, netProfit, businessExp, drawings, outstanding, count: active.length, byPayment, byCashier };
  }, [sales, expenses, debtors]);

  // CAPEX is deliberately absent from every figure above. It is shown as its
  // own box so a capital purchase never silently moves profit or cash.
  const capexTotal = useMemo(
    () => capex.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
    [capex],
  );

  const capexByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of capex) {
      const key = r.capex_category || 'other';
      map.set(key, (map.get(key) ?? 0) + (Number(r.amount) || 0));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [capex]);

  // Price-override leakage: lines sold above or below their catalogue price.
  // Older sales carry no catalogPrice/finalSalePrice at all, so they are
  // skipped rather than treated as zero — the card hides until real data exists.
  const overrides = useMemo(() => {
    let comparableLines = 0;
    let overrideLines = 0;
    let givenAway = 0;
    let chargedExtra = 0;
    for (const s of sales) {
      if (s.status === "refunded") continue;
      const items = Array.isArray(s.items) ? s.items : [];
      for (const it of items) {
        const qty = Number(it?.quantity) || 0;
        const catalog = it?.catalogPrice;
        const final = it?.finalSalePrice;
        if (qty <= 0 || catalog == null || final == null) continue;
        const c = Number(catalog);
        const f = Number(final);
        if (!Number.isFinite(c) || !Number.isFinite(f)) continue;
        comparableLines++;
        const diff = (c - f) * qty;
        if (Math.abs(diff) < 0.005) continue;
        overrideLines++;
        if (diff > 0) givenAway += diff;
        else chargedExtra += -diff;
      }
    }
    return { comparableLines, overrideLines, givenAway, chargedExtra };
  }, [sales]);

  // Stock snapshot: current on-hand value and the items that need attention.
  // Service items don't carry stock, so they are excluded from every figure.
  const stockStats = useMemo(() => {
    const rows = stock.filter((r) => r.active && r.itemType !== "service");
    let costValue = 0;
    let retailValue = 0;
    let units = 0;
    const low: StockRow[] = [];
    const out: StockRow[] = [];
    for (const r of rows) {
      costValue += r.cost * r.stock;
      retailValue += r.price * r.stock;
      units += r.stock;
      if (r.stock <= 0) out.push(r);
      else if (r.stock <= r.minimum) low.push(r);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    low.sort((a, b) => a.stock - b.stock);
    return {
      items: rows.length,
      costValue,
      retailValue,
      potentialProfit: retailValue - costValue,
      units,
      low,
      out,
    };
  }, [stock]);

  // Kitchen tickets: counts for the period (by created_at) plus the value of
  // the linked sales. "Served"/"Cancelled" use their respective timestamps.
  const ticketStats = useMemo(() => {
    let created = 0;
    let served = 0;
    let cancelled = 0;
    let open = 0;
    let value = 0;
    let servedValue = 0;
    const recent: Array<{ ticket_number: number | null; created_at: string; served_at: string | null; cancelled_at: string | null; status: string; value: number; table_name: string | null }> = [];
    for (const t of tickets) {
      const tkt = t as any;
      created += 1;
      const status: string = tkt.status ?? "pending";
      const numeric = (tkt.sales?.total ?? tkt.sales?.[0]?.total ?? 0);
      const v = Number(numeric) || 0;
      value += v;
      if (tkt.served_at) served += 1;
      if (status === "served" && tkt.served_at) servedValue += v;
      if (tkt.cancelled_at) cancelled += 1;
      if (status !== "served" && status !== "cancelled") open += 1;
      recent.push({
        ticket_number: tkt.ticket_number ?? null,
        created_at: tkt.created_at ?? "",
        served_at: tkt.served_at ?? null,
        cancelled_at: tkt.cancelled_at ?? null,
        status,
        value: v,
        table_name: tkt.table_name ?? null,
      });
    }
    recent.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { created, served, cancelled, open, value, servedValue, recent: recent.slice(0, 20) };
  }, [tickets]);

  const exportCsv = () => {
    const rows: string[] = [];
    rows.push("Sale Point Report");
    rows.push(`Business,${business?.name ?? ""}`);
    rows.push(`Period,${period}`);
    rows.push(`From,${format(range.from, "yyyy-MM-dd HH:mm")}`);
    rows.push(`To,${format(range.to, "yyyy-MM-dd HH:mm")}`);
    rows.push("");
    rows.push("Metric,Value");
    rows.push(`Sales count,${stats.count}`);
    rows.push(`Revenue,${stats.revenue.toFixed(2)}`);
    rows.push(`Tax collected,${stats.tax.toFixed(2)}`);
    rows.push(`Cost of goods,${stats.cogs.toFixed(2)}`);
    rows.push(`Gross profit,${stats.grossProfit.toFixed(2)}`);
    rows.push(`Business expenses,${stats.businessExp.toFixed(2)}`);
    rows.push(`Owner drawings,${stats.drawings.toFixed(2)}`);
    rows.push(`Net profit,${stats.netProfit.toFixed(2)}`);
    rows.push(`Outstanding debtors,${stats.outstanding.toFixed(2)}`);
    rows.push("");
    rows.push("Payment Method,Total");
    Object.entries(stats.byPayment).forEach(([k, v]) => rows.push(`${k},${v.toFixed(2)}`));
    rows.push("");
    rows.push("Cashier,Sales,Revenue");
    Object.entries(stats.byCashier).forEach(([k, v]) => rows.push(`${k},${v.count},${v.revenue.toFixed(2)}`));

    if (business.capexEnabled) {
      rows.push("");
      rows.push("CAPEX (excluded from profit)");
      rows.push("Category,Total");
      capexByCategory.forEach(([k, v]) => rows.push(`${CAPEX_CATEGORY_LABELS[k] ?? k},${v.toFixed(2)}`));
      rows.push(`Total CAPEX,${capexTotal.toFixed(2)}`);
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `salepoint-report-${period}-${format(new Date(), "yyyyMMdd-HHmm")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Report exported" });
  };

  const exportStockCsv = () => {
    const rows: string[] = [];
    rows.push("Sale Point Stock Report");
    rows.push(`Business,${business?.name ?? ""}`);
    rows.push(`Generated,${format(new Date(), "yyyy-MM-dd HH:mm")}`);
    rows.push("");
    rows.push("Metric,Value");
    rows.push(`Items tracked,${stockStats.items}`);
    rows.push(`Units on hand,${stockStats.units}`);
    rows.push(`Stock value (cost),${stockStats.costValue.toFixed(2)}`);
    rows.push(`Stock value (retail),${stockStats.retailValue.toFixed(2)}`);
    rows.push(`Potential profit,${stockStats.potentialProfit.toFixed(2)}`);
    rows.push(`Low stock items,${stockStats.low.length}`);
    rows.push(`Out of stock items,${stockStats.out.length}`);
    rows.push("");
    rows.push("Out of stock,Stock,Min,Cost value");
    stockStats.out.forEach((r) => rows.push(`"${r.name}",${r.stock},${r.minimum},${(r.cost * r.stock).toFixed(2)}`));
    rows.push("");
    rows.push("Low stock,Stock,Min,Cost value");
    stockStats.low.forEach((r) => rows.push(`"${r.name}",${r.stock},${r.minimum},${(r.cost * r.stock).toFixed(2)}`));

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `salepoint-stock-${format(new Date(), "yyyyMMdd-HHmm")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Stock report exported" });
  };

  const exportTicketsCsv = () => {
    const rows: string[] = [];
    rows.push("Kitchen Ticket Report");
    rows.push(`Business,${business?.name ?? ""}`);
    rows.push(`Period,${period}`);
    rows.push(`From,${format(range.from, "yyyy-MM-dd HH:mm")}`);
    rows.push(`To,${format(range.to, "yyyy-MM-dd HH:mm")}`);
    rows.push("");
    rows.push("Metric,Value");
    rows.push(`Tickets created,${ticketStats.created}`);
    rows.push(`Served,${ticketStats.served}`);
    rows.push(`Cancelled,${ticketStats.cancelled}`);
    rows.push(`Still open,${ticketStats.open}`);
    rows.push(`Ticket value,${ticketStats.value.toFixed(2)}`);
    rows.push(`Served value,${ticketStats.servedValue.toFixed(2)}`);
    rows.push("");
    rows.push("Ticket #,Status,Table,Created,Served,Cancelled,Value");
    ticketStats.recent.forEach((r) => rows.push(
      `${r.ticket_number ?? ""},${r.status},${r.table_name ?? ""},` +
      `${r.created_at ? format(new Date(r.created_at), "yyyy-MM-dd HH:mm") : ""},` +
      `${r.served_at ? format(new Date(r.served_at), "yyyy-MM-dd HH:mm") : ""},` +
      `${r.cancelled_at ? format(new Date(r.cancelled_at), "yyyy-MM-dd HH:mm") : ""},` +
      `${r.value.toFixed(2)}`
    ));

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kitchen-tickets-${period}-${format(new Date(), "yyyyMMdd-HHmm")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Ticket report exported" });
  };

  const exportItemHistoryCsv = () => {
    const rows: string[] = [];
    rows.push("Item History Report");
    rows.push(`Business,${business?.name ?? ""}`);
    rows.push(`Product,${itemProduct?.name ?? ""}`);
    rows.push(`Period,"${itemRange.label}"`);
    rows.push(`From,${format(itemRange.from, "yyyy-MM-dd HH:mm")}`);
    rows.push(`To,${format(itemRange.to, "yyyy-MM-dd HH:mm")}`);
    rows.push(`Generated,${format(new Date(), "yyyy-MM-dd HH:mm")}`);
    rows.push("");
    rows.push(`Starting stock,${itemStats.starting}`);
    rows.push(`Closing stock,${itemStats.closing}`);
    rows.push(`Current stock,${itemProduct?.stock ?? 0}`);
    rows.push(`Total in,${itemStats.totalIn}`);
    rows.push(`Total out,${itemStats.totalOut}`);
    rows.push(`Net change,${itemStats.net}`);
    rows.push("");
    rows.push("Date,Type,In/Out,Qty,Value (ZMW),Stock after,Reference");
    itemEvents.forEach((e) => rows.push([
      format(new Date(e.ts), "yyyy-MM-dd HH:mm"),
      `"${(e.label ?? "").replace(/"/g, '""')}"`,
      e.direction,
      String(e.qty),
      e.value != null ? e.value.toFixed(2) : "",
      e.balance != null ? String(e.balance) : "",
      `"${(e.note ?? "").replace(/"/g, '""')}"`,
    ].join(",")));

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `item-history-${(itemProduct?.name ?? "product").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${format(itemRange.from, "yyyyMMdd")}-${format(itemRange.to, "yyyyMMdd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Item history exported" });
  };

  if (authLoading || bizLoading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  if (!business) return null;

  return (
    <>
      <ConnectionStatus />
      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-4 py-4">
          <div className="flex items-center justify-between max-w-4xl mx-auto">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}><ArrowLeft className="w-5 h-5" /></Button>
              <div>
                <h1 className="font-display font-bold text-lg">Reports</h1>
                <p className="text-xs text-muted-foreground">Sales, profit, stock & kitchen tickets</p>
              </div>
            </div>
            {reportView !== "ingredients" && (
              <Button size="sm" variant="outline" onClick={reportView === "stock" ? exportStockCsv : reportView === "tickets" ? exportTicketsCsv : reportView === "items" ? exportItemHistoryCsv : exportCsv}><Download className="w-4 h-4 mr-1" /> CSV</Button>
            )}
          </div>
        </header>

        <main className="p-4 max-w-4xl mx-auto space-y-4">
          <Tabs value={reportView} onValueChange={(v) => setReportView(v as "sales" | "stock" | "tickets" | "items" | "ingredients")}>
            <TabsList className={`grid w-full ${isRestaurant ? "grid-cols-5" : "grid-cols-3"}`}>
              <TabsTrigger value="sales">Sales & Profit</TabsTrigger>
              <TabsTrigger value="stock">Stock</TabsTrigger>
              {isRestaurant && <TabsTrigger value="tickets">Tickets</TabsTrigger>}
              <TabsTrigger value="items">Item History</TabsTrigger>
              {isRestaurant && <TabsTrigger value="ingredients">Ingredients</TabsTrigger>}
            </TabsList>
          </Tabs>

          {reportView === "sales" && (
          <>
          <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <TabsList className="grid grid-cols-3 w-full">
              <TabsTrigger value="today">Today</TabsTrigger>
              <TabsTrigger value="week">This Week</TabsTrigger>
              <TabsTrigger value="month">{MONTHS[selectedMonth]} {selectedYear}</TabsTrigger>
            </TabsList>
          </Tabs>

          {period === "month" && (
            <div className="flex gap-2">
              <Select value={String(selectedMonth)} onValueChange={(v) => setSelectedMonth(Number(v))}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Month" /></SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={i} value={String(i)}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
                <SelectTrigger className="w-28"><SelectValue placeholder="Year" /></SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 10 }, (_, i) => selectedYear - 5 + i).map((y) => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {loading ? (
            <p className="text-center text-sm text-muted-foreground py-8">Loading...</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Revenue" value={formatZMW(stats.revenue)} />
                <StatCard icon={<ShoppingCart className="w-4 h-4" />} label="Sales" value={stats.count.toString()} />
                <StatCard icon={<Receipt className="w-4 h-4" />} label="Tax Collected" value={formatZMW(stats.tax)} />
                <StatCard icon={<Wallet className="w-4 h-4" />} label="Cost of Goods" value={formatZMW(stats.cogs)} />
                <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Gross Profit" value={formatZMW(stats.grossProfit)} />
                <StatCard icon={<Wallet className="w-4 h-4" />} label="Business Expenses" value={formatZMW(stats.businessExp)} />
                <StatCard icon={<Wallet className="w-4 h-4" />} label="Owner Drawings" value={formatZMW(stats.drawings)} />
                <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Net Profit" value={formatZMW(stats.netProfit)} highlight />
                <StatCard icon={<AlertCircle className="w-4 h-4" />} label="Outstanding Debts" value={formatZMW(stats.outstanding)} />
              </div>

              {/* CAPEX: its own box, deliberately outside every figure above. */}
              {business?.capexEnabled && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <HardHat className="h-4 w-4" /> CAPEX
                      <Badge variant="outline" className="text-[10px] font-normal">Not in profit</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex justify-between text-base">
                      <span className="text-muted-foreground">Capital spend this period</span>
                      <span className="font-semibold tabular-nums">{formatZMW(capexTotal)}</span>
                    </div>
                    {capexByCategory.length > 0 ? (
                      <div className="space-y-1 border-t pt-2 text-sm">
                        {capexByCategory.map(([key, value]) => (
                          <div key={key} className="flex justify-between">
                            <span>{CAPEX_CATEGORY_LABELS[key] ?? key}</span>
                            <span className="tabular-nums">{formatZMW(value)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No CAPEX recorded in this period.</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Shown as a record only. Capital spend is not an operating expense and does not
                      change gross or net profit.
                    </p>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">By Payment Method</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {Object.keys(stats.byPayment).length === 0 && <p className="text-muted-foreground">No sales in this period.</p>}
                  {Object.entries(stats.byPayment).map(([k, v]) => (
                    <div key={k} className="flex justify-between"><span className="capitalize">{k.replace(/_/g, " ")}</span><span>{formatZMW(v)}</span></div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">By Cashier</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {Object.keys(stats.byCashier).length === 0 && <p className="text-muted-foreground">No sales in this period.</p>}
                  {Object.entries(stats.byCashier).map(([k, v]) => (
                    <div key={k} className="flex justify-between"><span>{k}</span><span>{v.count} sales · {formatZMW(v.revenue)}</span></div>
                  ))}
                </CardContent>
              </Card>

              {overrides.comparableLines > 0 && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-base">Price Overrides</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span>Priced differently from the catalogue</span>
                      <span>{overrides.overrideLines} of {overrides.comparableLines} lines</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Sold below catalogue price</span>
                      <span className={overrides.givenAway > 0 ? "text-destructive" : undefined}>{formatZMW(overrides.givenAway)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Sold above catalogue price</span>
                      <span>{formatZMW(overrides.chargedExtra)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground pt-1">
                      Ignores discounts applied at the line or sale level.
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
          </>
          )}

          {reportView === "stock" && (
            loading ? (
              <p className="text-center text-sm text-muted-foreground py-8">Loading...</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <StatCard icon={<Boxes className="w-4 h-4" />} label="Items Tracked" value={stockStats.items.toString()} />
                  <StatCard icon={<Wallet className="w-4 h-4" />} label="Units On Hand" value={stockStats.units.toString()} />
                  <StatCard icon={<Wallet className="w-4 h-4" />} label="Stock Value (Cost)" value={formatZMW(stockStats.costValue)} />
                  <StatCard icon={<Coins className="w-4 h-4" />} label="Stock Value (Retail)" value={formatZMW(stockStats.retailValue)} />
                  <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Expected Profit" value={formatZMW(stockStats.potentialProfit)} highlight />
                  <StatCard icon={<AlertTriangle className="w-4 h-4" />} label="Low Stock" value={stockStats.low.length.toString()} />
                  <StatCard icon={<PackageX className="w-4 h-4" />} label="Out of Stock" value={stockStats.out.length.toString()} />
                </div>

                {stockStats.out.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <PackageX className="h-4 w-4 text-destructive" /> Out of Stock
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1 text-sm">
                      {stockStats.out.map((r) => (
                        <div key={r.id} className="flex justify-between">
                          <span className="truncate pr-2">{r.name}</span>
                          <span className="tabular-nums text-destructive">0 on hand</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

                {stockStats.low.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-600" /> Low Stock
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1 text-sm">
                      {stockStats.low.map((r) => (
                        <div key={r.id} className="flex justify-between">
                          <span className="truncate pr-2">{r.name}</span>
                          <span className="tabular-nums">{r.stock} left · min {r.minimum}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

                {stockStats.items === 0 && (
                  <p className="text-center text-sm text-muted-foreground py-8">No stock-tracked items found.</p>
                )}

                <p className="text-xs text-muted-foreground px-1">
                  Stock value reflects current on-hand quantities. Items without stock tracking are excluded.
                </p>
              </>
            )
          )}

          {reportView === "tickets" && (
            loading ? (
              <p className="text-center text-sm text-muted-foreground py-8">Loading...</p>
            ) : !isOnline ? (
              <p className="text-center text-sm text-muted-foreground py-8">Kitchen ticket reports need a connection.</p>
            ) : (
              <>
                <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
                  <TabsList className="grid grid-cols-3 w-full">
                    <TabsTrigger value="today">Today</TabsTrigger>
                    <TabsTrigger value="week">This Week</TabsTrigger>
                    <TabsTrigger value="month">{MONTHS[selectedMonth]} {selectedYear}</TabsTrigger>
                  </TabsList>
                </Tabs>

                {period === "month" && (
                  <div className="flex gap-2">
                    <Select value={String(selectedMonth)} onValueChange={(v) => setSelectedMonth(Number(v))}>
                      <SelectTrigger className="flex-1"><SelectValue placeholder="Month" /></SelectTrigger>
                      <SelectContent>
                        {MONTHS.map((m, i) => (
                          <SelectItem key={i} value={String(i)}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
                      <SelectTrigger className="w-28"><SelectValue placeholder="Year" /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 10 }, (_, i) => selectedYear - 5 + i).map((y) => (
                          <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <StatCard icon={<ChefHat className="w-4 h-4" />} label="Tickets" value={ticketStats.created.toString()} />
                  <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Served" value={ticketStats.served.toString()} />
                  <StatCard icon={<AlertCircle className="w-4 h-4" />} label="Cancelled" value={ticketStats.cancelled.toString()} />
                  <StatCard icon={<Clock className="w-4 h-4" />} label="Still Open" value={ticketStats.open.toString()} />
                  <StatCard icon={<Coins className="w-4 h-4" />} label="Ticket Value" value={formatZMW(ticketStats.value)} highlight />
                  <StatCard icon={<ShoppingCart className="w-4 h-4" />} label="Served Value" value={formatZMW(ticketStats.servedValue)} />
                </div>

                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-base">Latest Tickets</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {ticketStats.recent.length === 0 && <p className="text-muted-foreground">No kitchen tickets in this period.</p>}
                    {ticketStats.recent.map((r) => (
                      <div key={`${r.ticket_number}-${r.created_at}`} className="flex justify-between gap-2 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
                        <div className="min-w-0">
                          <p className="truncate">
                            #{r.ticket_number ?? "—"}{r.table_name ? ` · ${r.table_name}` : ""} · <span className="capitalize">{r.status}</span>
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            Created {r.created_at ? format(new Date(r.created_at), "dd MMM yyyy, HH:mm") : "—"}
                            {r.served_at ? ` · served ${format(new Date(r.served_at), "HH:mm")}` : ""}
                            {r.cancelled_at ? ` · cancelled ${format(new Date(r.cancelled_at), "HH:mm")}` : ""}
                          </p>
                        </div>
                        <span className="tabular-nums shrink-0">{formatZMW(r.value)}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <p className="text-xs text-muted-foreground px-1">
                  Counted by the ticket&apos;s creation date. Served/cancelled use their own timestamps; values come from the linked sale.
                </p>
              </>
            )
          )}

          {reportView === "ingredients" && (
            <>
              <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
                <TabsList className="grid grid-cols-3 w-full">
                  <TabsTrigger value="today">Today</TabsTrigger>
                  <TabsTrigger value="week">This Week</TabsTrigger>
                  <TabsTrigger value="month">{MONTHS[selectedMonth]} {selectedYear}</TabsTrigger>
                </TabsList>
              </Tabs>

              {period === "month" && (
                <div className="flex gap-2">
                  <Select value={String(selectedMonth)} onValueChange={(v) => setSelectedMonth(Number(v))}>
                    <SelectTrigger className="flex-1"><SelectValue placeholder="Month" /></SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m, i) => (
                        <SelectItem key={i} value={String(i)}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
                    <SelectTrigger className="w-28"><SelectValue placeholder="Year" /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 10 }, (_, i) => selectedYear - 5 + i).map((y) => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {business?.id && (
                <IngredientsReport
                  businessId={business.id}
                  from={range.from}
                  to={range.to}
                  periodLabel={periodLabel}
                />
              )}
            </>
          )}

          {reportView === "items" && (
            <>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Select value={itemProductId} onValueChange={setItemProductId}>
                    <SelectTrigger className="flex-1"><SelectValue placeholder="Choose a product" /></SelectTrigger>
                    <SelectContent>
                      {[...stock]
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Select value={itemPreset} onValueChange={setItemPreset}>
                    <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ITEM_PERIOD_PRESETS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {itemPreset === "specific_month" && (
                  <div className="flex gap-2">
                    <Select value={String(itemMonth)} onValueChange={(v) => setItemMonth(Number(v))}>
                      <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {MONTHS.map((m, i) => (
                          <SelectItem key={m} value={String(i)}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={String(itemYear)} onValueChange={(v) => setItemYear(Number(v))}>
                      <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ITEM_YEARS.map((y) => (
                          <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {itemPreset === "custom" && (
                  <div className="flex gap-2">
                    <Input type="date" value={itemCustomFrom} max={itemCustomTo} onChange={(e) => setItemCustomFrom(e.target.value)} className="flex-1" />
                    <Input type="date" value={itemCustomTo} max={format(new Date(), "yyyy-MM-dd")} onChange={(e) => setItemCustomTo(e.target.value)} className="flex-1" />
                  </div>
                )}
              </div>

              {!itemProductId ? (
                <p className="text-center text-sm text-muted-foreground py-8">Pick a product to see its stock-in and stock-out history.</p>
              ) : itemLoading ? (
                <p className="text-center text-sm text-muted-foreground py-8">Loading...</p>
              ) : !isOnline ? (
                <p className="text-center text-sm text-muted-foreground py-8">Item history needs a connection.</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <StatCard icon={<Boxes className="w-4 h-4" />} label="Starting Stock" value={String(itemStats.starting)} />
                    <StatCard icon={<Boxes className="w-4 h-4" />} label="Closing Stock" value={String(itemStats.closing)} highlight />
                    <StatCard icon={<ArrowDownRight className="w-4 h-4" />} label="Total In" value={String(itemStats.totalIn)} />
                    <StatCard icon={<ArrowUpRight className="w-4 h-4" />} label="Total Out" value={String(itemStats.totalOut)} />
                    <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Net Change" value={String(itemStats.net)} />
                    <StatCard icon={<Boxes className="w-4 h-4" />} label="Current Stock" value={String(itemProduct?.stock ?? 0)} />
                    <StatCard icon={<Coins className="w-4 h-4" />} label="Stock Value (Cost)" value={formatZMW((itemProduct?.stock ?? 0) * (itemProduct?.cost ?? 0))} />
                    <StatCard icon={<ShoppingCart className="w-4 h-4" />} label="Sales Value" value={formatZMW(itemStats.valueOut)} />
                  </div>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <History className="h-4 w-4" /> {itemProduct?.name ?? "Item"} · {itemRange.label}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      {itemEvents.length === 0 && (
                        <p className="text-muted-foreground">No movements in this window.</p>
                      )}
                      {itemEvents.map((e, i) => {
                        const after = e.balance;
                        const before = after != null ? after - (e.direction === "in" ? e.qty : -e.qty) : null;
                        return (
                          <div key={`${e.ts}-${e.label}-${i}`} className="flex items-start justify-between gap-2 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
                            <div className="min-w-0 flex items-start gap-2">
                              {e.direction === "in" ? (
                                <ArrowDownRight className="h-4 w-4 mt-0.5 shrink-0 text-green-600" />
                              ) : (
                                <ArrowUpRight className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                              )}
                              <div className="min-w-0">
                                <p className="truncate">
                                  <span className="font-medium">{e.direction === "in" ? "+" : "-"}{e.qty}</span> · {e.label}
                                </p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {format(new Date(e.ts), "dd MMM yyyy, HH:mm")}
                                  {e.note ? ` · ${e.note}` : ""}
                                  {before != null && after != null ? ` · ${before} → ${after}` : ""}
                                </p>
                              </div>
                            </div>
                            <span className="tabular-nums shrink-0 text-muted-foreground">
                              {e.value != null ? formatZMW(e.value) : ""}
                            </span>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>

                  <p className="text-xs text-muted-foreground px-1">
                    Starting/Closing stock are derived from the movement ledger. Stock-in comes from
                    the ledger; stock-out combines sales lines with non-sale removals, counted once.
                  </p>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </>
  );
};

const StatCard = ({ icon, label, value, highlight }: { icon: React.ReactNode; label: string; value: string; highlight?: boolean }) => (
  <Card className={highlight ? "border-primary" : undefined}>
    <CardContent className="p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">{icon}{label}</div>
      <div className={`font-bold ${highlight ? "text-primary text-lg" : ""}`}>{value}</div>
    </CardContent>
  </Card>
);

export default Reports;

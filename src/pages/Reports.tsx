import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Download, TrendingUp, ShoppingCart, Receipt, Wallet, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { lusakaDayRange, lusakaWeekRange, lusakaMonthRange, lusakaDateLabel } from "@/lib/dateRange";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ConnectionStatus from "@/components/ConnectionStatus";
import { useAuthContext } from "@/contexts/AuthContext";
import { useBusiness } from "@/hooks/useBusiness";
import { supabase } from "@/integrations/supabase/client";
import { formatZMW } from "@/lib/currency";
import { useToast } from "@/hooks/use-toast";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { getCachedSalesHistory, getCachedExpenses, getCachedDebtors } from "@/lib/offlineStorage";

type Period = "today" | "week" | "month";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const Reports = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isOnline } = useOnlineStatus();
  const { user, isLoading: authLoading } = useAuthContext();
  const { business, isLoading: bizLoading } = useBusiness(user?.id);
  const [period, setPeriod] = useState<Period>("today");
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [sales, setSales] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [debtors, setDebtors] = useState<any[]>([]);

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  const range = useMemo(() => {
    if (period === "today") return lusakaDayRange();
    if (period === "week") return lusakaWeekRange();
    return lusakaMonthRange(new Date(selectedYear, selectedMonth, 1));
  }, [period, selectedMonth, selectedYear]);


  const fetchAll = async () => {
    if (!business?.id) return;
    setLoading(true);
    try {
      if (!isOnline) {
        const [cachedSales, cachedExpenses, cachedDebtors] = await Promise.all([
          getCachedSalesHistory(business.id),
          getCachedExpenses(business.id),
          getCachedDebtors(business.id),
        ]);
        const from = range.from.getTime();
        const to = range.to.getTime();
        setSales(cachedSales.filter(s => {
          const t = new Date(s.createdAt).getTime();
          return t >= from && t <= to;
        }));
        setExpenses(cachedExpenses.filter(e => {
          const t = new Date(e.expense_date).getTime();
          return t >= from && t <= to;
        }));
        setDebtors(cachedDebtors.map(d => ({ id: d.id, amount_owed: d.amountOwed, amount_paid: d.amountPaid, balance_due: d.amountOwed - d.amountPaid, status: d.status })));
        toast({ title: "Offline data", description: "Showing cached report data." });
        return;
      }

      const [{ data: s }, { data: e }, { data: d }] = await Promise.all([
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
      ]);
      setSales(s ?? []);
      setExpenses(e ?? []);
      setDebtors(d ?? []);
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


  const stats = useMemo(() => {
    const active = sales.filter((s) => s.status !== "refunded");
    const revenue = active.reduce((sum, s) => sum + (Number(s.total) || 0), 0);
    const tax = active.reduce((sum, s) => sum + (Number(s.tax_amount) || 0), 0);
    const cogs = active.reduce((sum, s) => {
      const items = Array.isArray(s.items) ? s.items : [];
      return sum + items.reduce((c: number, it: any) => c + (Number(it.costPrice) || 0) * (Number(it.quantity) || 0), 0);
    }, 0);
    const businessExp = expenses.filter((e) => e.category !== "personal").reduce((s, e) => s + Number(e.amount || 0), 0);
    const drawings = expenses.filter((e) => e.category === "personal").reduce((s, e) => s + Number(e.amount || 0), 0);
    const grossProfit = revenue - cogs;
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

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `salepoint-report-${period}-${format(new Date(), "yyyyMMdd-HHmm")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Report exported" });
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
                <p className="text-xs text-muted-foreground">Sales, profit & cash flow</p>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={exportCsv}><Download className="w-4 h-4 mr-1" /> CSV</Button>
          </div>
        </header>

        <main className="p-4 max-w-4xl mx-auto space-y-4">
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

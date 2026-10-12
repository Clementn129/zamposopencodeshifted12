import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { formatZMW } from '@/lib/currency';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { getCachedSalesHistory, getCachedExpenses, getCachedDebtors, getCachedProducts } from '@/lib/offlineStorage';
import { todayLocal, localDayBounds, parseDateString } from '@/lib/dates';
import {
  TrendingUp,
  ShoppingCart,
  AlertTriangle,
  PackageX,
  Wallet,
  Banknote,
  PiggyBank,
} from 'lucide-react';

interface DashboardStatsProps {
  businessId: string;
  isService: boolean;
}

interface Stats {
  todayRevenue: number;
  todaySalesCount: number;
  outstandingDebts: number;
  lowStockCount: number;
  businessExpensesToday: number;
  ownerDrawingsToday: number;
}

const DashboardStats = ({ businessId, isService }: DashboardStatsProps) => {
  const { isOnline } = useOnlineStatus();
  const [stats, setStats] = useState<Stats>({
    todayRevenue: 0,
    todaySalesCount: 0,
    outstandingDebts: 0,
    lowStockCount: 0,
    businessExpensesToday: 0,
    ownerDrawingsToday: 0,
  });
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    if (!businessId) return;
    const today = todayLocal();
    const { from: todayStartIso, to: todayEndIso } = localDayBounds();

    if (!isOnline) {
      const [cachedSales, cachedExpenses, cachedDebtors, cachedProducts] = await Promise.all([
        getCachedSalesHistory(businessId),
        getCachedExpenses(businessId),
        getCachedDebtors(businessId),
        isService ? Promise.resolve([]) : getCachedProducts(businessId),
      ]);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const todaysSales = cachedSales.filter(s => {
        const t = new Date(s.createdAt).getTime();
        return t >= todayStart.getTime() && t <= todayEnd.getTime();
      });

      const todaysExpenses = cachedExpenses.filter(e => {
        const t = parseDateString(e.expense_date).getTime();
        return t >= todayStart.getTime() && t <= todayEnd.getTime();
      });

      const businessExpensesToday = todaysExpenses
        .filter((e) => (e.category ?? 'business') === 'business')
        .reduce((sum, e) => sum + e.amount, 0);
      const ownerDrawingsToday = todaysExpenses
        .filter((e) => e.category === 'personal')
        .reduce((sum, e) => sum + e.amount, 0);

      const lowStockCount = isService ? 0 : (cachedProducts as any[])
        .filter((p: any) => (p.itemType ?? 'product') !== 'service' && Number(p.stock) <= Number(p.minimumStock))
        .length;

      setStats({
        todayRevenue: todaysSales.reduce((sum, s) => sum + Number(s.total), 0),
        todaySalesCount: todaysSales.length,
        outstandingDebts: cachedDebtors
          .filter((d) => d.status !== 'paid')
          .reduce((sum, d) => sum + (d.amountOwed - d.amountPaid), 0),
        lowStockCount,
        businessExpensesToday,
        ownerDrawingsToday,
      });
      setLoading(false);
      return;
    }

    const [salesRes, debtorsRes, expensesRes, productsRes] = await Promise.all([
      supabase
        .from('sales')
        .select('total')
        .eq('business_id', businessId)
        .eq('status', 'completed')
        .gte('created_at', todayStartIso)
        .lte('created_at', todayEndIso),
      supabase
        .from('debtors')
        .select('amount_owed, amount_paid')
        .eq('business_id', businessId)
        .neq('status', 'paid'),
      supabase
        .from('expenses')
        .select('amount, category')
        .eq('business_id', businessId)
        .eq('expense_date', today),
      isService
        ? Promise.resolve({ data: [] as any[] })
        : supabase
            .from('products')
            .select('stock, minimum_stock, item_type')
            .eq('business_id', businessId)
            .eq('is_active', true),
    ]);

    const sales = salesRes.data || [];
    const debtors = debtorsRes.data || [];
    const expenses = (expensesRes.data || []) as Array<{ amount: number; category: string | null }>;
    const products = (productsRes.data || []) as Array<{
      stock: number;
      minimum_stock: number;
      item_type?: string | null;
    }>;

    const businessExpensesToday = expenses
      .filter((e) => (e.category ?? 'business') === 'business')
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const ownerDrawingsToday = expenses
      .filter((e) => e.category === 'personal')
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);

    const lowStockCount = isService
      ? 0
      : products.filter(
          (p) => (p.item_type ?? 'product') !== 'service' && Number(p.stock) <= Number(p.minimum_stock),
        ).length;

    setStats({
      todayRevenue: sales.reduce((sum, s) => sum + Number(s.total), 0),
      todaySalesCount: sales.length,
      outstandingDebts: debtors.reduce(
        (sum, d) => sum + (Number(d.amount_owed) - Number(d.amount_paid)),
        0,
      ),
      lowStockCount,
      businessExpensesToday,
      ownerDrawingsToday,
    });
    setLoading(false);
  }, [businessId, isService, isOnline]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  // Refresh on realtime events so the dashboard reflects every change live.
  useEffect(() => {
    const handler = () => void fetchStats();
    const events = [
      'zampos:sales-changed',
      'zampos:sale-payment-changed',
      'zampos:expenses-changed',
      'zampos:debtors-changed',
      'zampos:products-changed',
      'zampos:sync-complete',
    ];
    events.forEach((e) => window.addEventListener(e, handler));
    return () => events.forEach((e) => window.removeEventListener(e, handler));
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-20 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  // Net Cash Position = Sales − Business Expenses − Owner Drawings (today)
  const netCashToday =
    stats.todayRevenue - stats.businessExpensesToday - stats.ownerDrawingsToday;

  const statCards = [
    {
      label: "Today's Revenue",
      value: formatZMW(stats.todayRevenue),
      icon: TrendingUp,
      color: 'text-emerald-600',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'Sales Today',
      value: stats.todaySalesCount.toString(),
      icon: ShoppingCart,
      color: 'text-blue-600',
      bg: 'bg-blue-500/10',
    },
    {
      label: 'Business Expenses (Today)',
      value: formatZMW(stats.businessExpensesToday),
      icon: Wallet,
      color: 'text-rose-600',
      bg: 'bg-rose-500/10',
    },
    {
      label: 'Owner Drawings (Today)',
      value: formatZMW(stats.ownerDrawingsToday),
      icon: PiggyBank,
      color: 'text-purple-600',
      bg: 'bg-purple-500/10',
    },
    {
      label: 'Net Cash (Today)',
      value: formatZMW(netCashToday),
      icon: Banknote,
      color: netCashToday >= 0 ? 'text-emerald-600' : 'text-destructive',
      bg: netCashToday >= 0 ? 'bg-emerald-500/10' : 'bg-destructive/10',
    },
    {
      label: 'Outstanding Debts',
      value: formatZMW(stats.outstandingDebts),
      icon: AlertTriangle,
      color: 'text-amber-600',
      bg: 'bg-amber-500/10',
    },
    ...(!isService
      ? [
          {
            label: 'Low Stock Items',
            value: stats.lowStockCount.toString(),
            icon: PackageX,
            color: 'text-red-600',
            bg: 'bg-red-500/10',
          },
        ]
      : []),
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
      {statCards.map((stat) => (
        <div
          key={stat.label}
          className="rounded-xl border bg-card p-3 flex items-start gap-3"
        >
          <div
            className={`w-9 h-9 rounded-lg ${stat.bg} flex items-center justify-center shrink-0`}
          >
            <stat.icon className={`w-4 h-4 ${stat.color}`} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">{stat.label}</p>
            <p className="text-sm font-bold truncate">{stat.value}</p>
          </div>
        </div>
      ))}
    </div>
  );
};

export default DashboardStats;

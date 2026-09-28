import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, BarChart3, Calendar, Download, Edit, Receipt, TrendingUp, Trash2, RotateCcw, Check, Clock, DollarSign, Tag, Wallet, Eye, Search, X } from "lucide-react";
import { format, startOfDay, startOfWeek, startOfMonth, endOfMonth, getMonth, getYear, setMonth, setYear } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ConnectionStatus from "@/components/ConnectionStatus";
import LockScreen from "@/components/LockScreen";
import EditSaleModal from "@/components/EditSaleModal";
import ExpensesSection from "@/components/ExpensesSection";
import ReceiptModal from "@/components/ReceiptModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthContext } from "@/contexts/AuthContext";
import { useBusiness } from "@/hooks/useBusiness";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { supabase } from "@/integrations/supabase/client";
import { getUnsyncedSales, cacheSalesHistory, getCachedSalesHistory, cacheExpenses, getCachedExpenses, cacheDebtorPayments, getCachedDebtorPayments, markSaleAsSynced, generateOfflineId, queuePendingOp } from "@/lib/offlineStorage";
import { exportSalesToCsv } from "@/lib/csvExport";
import { useToast } from "@/hooks/use-toast";


type SaleItem = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  costPrice?: number | null;
  discountType?: string | null;
  discountValue?: number;
};

type PaymentStatus = "paid" | "partially_paid" | "pending" | "overdue";

type Sale = {
  id: string;
  items: SaleItem[];
  subtotal: number;
  total: number;
  discountAmount: number;
  paymentMethod: string;
  createdAt: string;
  synced: boolean;
  status: 'completed' | 'refunded' | 'partially_refunded';
  taxAmount?: number;
  taxableAmount?: number;
  zeroRatedAmount?: number;
  exemptAmount?: number;
  customerName?: string | null;
  customerTpin?: string | null;
  customerPhone?: string | null;
  amountPaid?: number;
  balanceDue?: number;
  paymentStatus?: PaymentStatus;
  dueDate?: string | null;
  cashierName?: string | null;
  cashierUsername?: string | null;
};

type Expense = {
  id: string;
  name: string;
  amount: number;
  expense_date: string;
  notes: string | null;
  category: 'business' | 'personal';
};

type DebtorPayment = {
  id: string;
  amount: number;
  payment_date: string;
};

type FilterPeriod = "today" | "week" | "month" | "all";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const SalesHistory = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isLoading: authLoading } = useAuthContext();
  const { business, isLoading: bizLoading, refetch: refetchBusiness, checkSubscriptionStatus } = useBusiness(user?.id);
  const { isLocked } = checkSubscriptionStatus();
  const { isOnline } = useOnlineStatus();

  const [sales, setSales] = useState<Sale[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [debtorPayments, setDebtorPayments] = useState<DebtorPayment[]>([]);
  const [offlineSales, setOfflineSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<FilterPeriod>("today");
  const [editingSale, setEditingSale] = useState<Sale | null>(null);
  const [viewingSale, setViewingSale] = useState<Sale | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  
  // Monthly view state
  const [activeTab, setActiveTab] = useState<"quick" | "monthly">("quick");
  const [topSellingSortBy, setTopSellingSortBy] = useState<"qty" | "revenue">("qty");
  const [selectedMonth, setSelectedMonth] = useState<number>(getMonth(new Date()));
  const [selectedYear, setSelectedYear] = useState<number>(getYear(new Date()));
  const [receiptSearch, setReceiptSearch] = useState("");

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  // Server-side date window — never load more than the active period needs.
  const dateWindow = useMemo(() => {
    const now = new Date();
    if (activeTab === "monthly") {
      const start = startOfMonth(setYear(setMonth(now, selectedMonth), selectedYear));
      const end = endOfMonth(start);
      return { from: start.toISOString(), to: end.toISOString() };
    }
    if (period === "today") return { from: startOfDay(now).toISOString(), to: null as string | null };
    if (period === "week") return { from: startOfWeek(now, { weekStartsOn: 1 }).toISOString(), to: null as string | null };
    if (period === "month") return { from: startOfMonth(now).toISOString(), to: null as string | null };
    return { from: null as string | null, to: null as string | null }; // "all" — still hard-capped below
  }, [activeTab, period, selectedMonth, selectedYear]);

  const PAGE_LIMIT = 500; // hard cap to protect the client even on "all"

  const fetchData = async () => {
    if (!business?.id) return;

    setLoading(true);
    try {
      let onlineSalesFetched = false;
      let onlineExpensesFetched = false;
      let onlinePaymentsFetched = false;

      if (isOnline) {
        // Sales — server-filtered by business + date window, explicit columns, capped.
        let salesQ = supabase
          .from("sales")
          .select("id, items, subtotal, total, discount_amount, payment_method, created_at, status, tax_amount, taxable_amount, zero_rated_amount, exempt_amount, customer_name, customer_tpin, customer_phone, amount_paid, balance_due, payment_status, due_date, cashier_name, cashier_username")
          .eq("business_id", business.id)
          .order("created_at", { ascending: false })
          .limit(PAGE_LIMIT);
        if (dateWindow.from) salesQ = salesQ.gte("created_at", dateWindow.from);
        if (dateWindow.to) salesQ = salesQ.lte("created_at", dateWindow.to);
        const { data: salesData, error: salesError } = await salesQ;

        if (!salesError && salesData) {
          const mapped = salesData.map((s: any) => ({
            id: s.id,
            items: s.items as SaleItem[],
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
            paymentStatus: (s.payment_status as PaymentStatus) || 'paid',
            dueDate: s.due_date,
            cashierName: s.cashier_name,
            cashierUsername: s.cashier_username,
          }));
          setSales(mapped);
          onlineSalesFetched = true;
          cacheSalesHistory(business.id, mapped).catch(console.error);
        }

        // Expenses — server-filtered by date window
        let expQ = supabase
          .from("expenses")
          .select("id, name, amount, expense_date, notes, category")
          .eq("business_id", business.id)
          .order("expense_date", { ascending: false })
          .limit(PAGE_LIMIT);
        if (dateWindow.from) expQ = expQ.gte("expense_date", dateWindow.from.slice(0, 10));
        if (dateWindow.to) expQ = expQ.lte("expense_date", dateWindow.to.slice(0, 10));
        const { data: expensesData, error: expensesError } = await expQ;

        if (!expensesError && expensesData) {
          setExpenses(expensesData as any);
          onlineExpensesFetched = true;
          cacheExpenses(
            business.id,
            expensesData.map((e: any) => ({
              id: e.id,
              businessId: business.id,
              name: e.name,
              amount: Number(e.amount),
              expense_date: e.expense_date,
              notes: e.notes,
              category: e.category || 'business',
            }))
          ).catch(console.error);
        }

        // Debtor payments — single query with inner join (fixes N+1, server-side filter)
        let payQ = supabase
          .from("debtor_payments")
          .select("id, amount, payment_date, debtor_id, debtors!inner(business_id)")
          .eq("debtors.business_id", business.id)
          .order("payment_date", { ascending: false })
          .limit(PAGE_LIMIT);
        if (dateWindow.from) payQ = payQ.gte("payment_date", dateWindow.from);
        if (dateWindow.to) payQ = payQ.lte("payment_date", dateWindow.to);
        const { data: paymentsData, error: paymentsError } = await payQ;

        if (!paymentsError && paymentsData) {
          const mapped = paymentsData.map((p: any) => ({
            id: p.id,
            amount: Number(p.amount),
            payment_date: p.payment_date,
          }));
          setDebtorPayments(mapped);
          onlinePaymentsFetched = true;
          cacheDebtorPayments(
            business.id,
            paymentsData.map((p: any) => ({
              id: p.id,
              businessId: business.id,
              amount: Number(p.amount),
              payment_date: p.payment_date,
            }))
          ).catch(console.error);
        }
      }

      // Fall back to cached sales when offline or online fetch didn't produce results
      if (!onlineSalesFetched) {
        const cached = await getCachedSalesHistory(business.id);
        if (cached.length > 0) {
          const filtered = cached
            .filter((s) => {
              if (dateWindow.from && s.createdAt < dateWindow.from) return false;
              if (dateWindow.to && s.createdAt > dateWindow.to) return false;
              return true;
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          if (filtered.length > 0) {
            setSales(filtered as Sale[]);
          }
        }
      }

      // Fall back to cached expenses
      if (!onlineExpensesFetched) {
        const cached = await getCachedExpenses(business.id);
        if (cached.length > 0) {
          setExpenses(cached as any);
        }
      }

      // Fall back to cached debtor payments
      if (!onlinePaymentsFetched) {
        const cached = await getCachedDebtorPayments(business.id);
        if (cached.length > 0) {
          setDebtorPayments(cached.map((p) => ({
            id: p.id,
            amount: p.amount,
            payment_date: p.payment_date,
          })));
        }
      }

      // Fetch offline unsynced sales
      let unsynced = await getUnsyncedSales(business.id);

      // Clean up orphaned offline sales: if online and the server already has a
      // matching sale (same total, customer, payment method), mark it synced.
      if (isOnline && unsynced.length > 0 && onlineSalesFetched) {
        const { data: serverSales } = await supabase
          .from("sales")
          .select("id, total, customer_name, payment_method")
          .eq("business_id", business.id)
          .limit(500);
        if (serverSales) {
          for (const u of unsynced) {
            const match = serverSales.find((s) => {
              const sTotal = Number(s.total);
              const uTotal = Number(u.total);
              return Math.abs(sTotal - uTotal) < 0.01 &&
                (s.customer_name ?? null) === (u.customerName ?? null) &&
                s.payment_method === u.paymentMethod;
            });
            if (match) {
              await markSaleAsSynced(u.id);
            }
          }
          // Re-fetch unsynced after marking some as synced
          unsynced = await getUnsyncedSales(business.id);
        }
      }

      setOfflineSales(
        unsynced.map((s) => ({
          id: s.id,
          items: s.items,
          subtotal: s.subtotal,
          total: s.total,
          discountAmount: s.discountAmount ?? 0,
          paymentMethod: s.paymentMethod,
          createdAt: s.createdAt,
          synced: false,
          status: 'completed' as const,
        }))
      );
    } catch (e) {
      console.error("Failed to fetch data:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (business?.id) fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business?.id, isOnline, period, activeTab, selectedMonth, selectedYear]);

  // Refresh after offline sales finish syncing or after realtime sale / payment changes
  const fetchDataRef = useRef(fetchData);
  fetchDataRef.current = fetchData;

  useEffect(() => {
    const handler = () => {
      if (business?.id) void fetchDataRef.current();
    };
    window.addEventListener("zampos:sync-complete", handler);
    window.addEventListener("zampos:sales-changed", handler);
    window.addEventListener("zampos:sale-payment-changed", handler);
    return () => {
      window.removeEventListener("zampos:sync-complete", handler);
      window.removeEventListener("zampos:sales-changed", handler);
      window.removeEventListener("zampos:sale-payment-changed", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business?.id]);

  const allSales = useMemo(() => {
    const combined = [...offlineSales, ...sales];
    // Remove duplicates (offline sales that got synced)
    const seen = new Set<string>();
    return combined.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }, [sales, offlineSales]);

  const filteredSales = useMemo(() => {
    const now = new Date();
    let startDate: Date;

    switch (period) {
      case "today":
        startDate = startOfDay(now);
        break;
      case "week":
        startDate = startOfWeek(now, { weekStartsOn: 1 });
        break;
      case "month":
        startDate = startOfMonth(now);
        break;
      default:
        return allSales;
    }

    const periodFiltered = allSales.filter((s) => new Date(s.createdAt) >= startDate);
    if (!receiptSearch.trim()) return periodFiltered;
    const q = receiptSearch.trim().toLowerCase();
    return periodFiltered.filter((s) =>
      s.id.toLowerCase().includes(q) ||
      `INV-${s.id.replace(/-/g, '').slice(-6).toUpperCase()}`.toLowerCase().includes(q) ||
      s.id.slice(-8).toUpperCase().toLowerCase().includes(q)
    );
  }, [allSales, period, receiptSearch]);

  const filteredExpenses = useMemo(() => {
    const now = new Date();
    let startDate: Date;

    switch (period) {
      case "today":
        startDate = startOfDay(now);
        break;
      case "week":
        startDate = startOfWeek(now, { weekStartsOn: 1 });
        break;
      case "month":
        startDate = startOfMonth(now);
        break;
      default:
        return expenses;
    }

    return expenses.filter((e) => new Date(e.expense_date) >= startDate);
  }, [expenses, period]);

  // Monthly filtered data
  const monthlyFilteredSales = useMemo(() => {
    const targetDate = setYear(setMonth(new Date(), selectedMonth), selectedYear);
    const monthStart = startOfMonth(targetDate);
    const monthEnd = endOfMonth(targetDate);
    
    const periodFiltered = allSales.filter((s) => {
      const saleDate = new Date(s.createdAt);
      return saleDate >= monthStart && saleDate <= monthEnd;
    });
    if (!receiptSearch.trim()) return periodFiltered;
    const q = receiptSearch.trim().toLowerCase();
    return periodFiltered.filter((s) =>
      s.id.toLowerCase().includes(q) ||
      `INV-${s.id.replace(/-/g, '').slice(-6).toUpperCase()}`.toLowerCase().includes(q) ||
      s.id.slice(-8).toUpperCase().toLowerCase().includes(q)
    );
  }, [allSales, selectedMonth, selectedYear, receiptSearch]);

  const monthlyFilteredExpenses = useMemo(() => {
    const targetDate = setYear(setMonth(new Date(), selectedMonth), selectedYear);
    const monthStart = startOfMonth(targetDate);
    const monthEnd = endOfMonth(targetDate);
    
    return expenses.filter((e) => {
      const expenseDate = new Date(e.expense_date);
      return expenseDate >= monthStart && expenseDate <= monthEnd;
    });
  }, [expenses, selectedMonth, selectedYear]);

  const monthlyDebtorPayments = useMemo(() => {
    const targetDate = setYear(setMonth(new Date(), selectedMonth), selectedYear);
    const monthStart = startOfMonth(targetDate);
    const monthEnd = endOfMonth(targetDate);
    
    return debtorPayments.filter((p) => {
      const paymentDate = new Date(p.payment_date);
      return paymentDate >= monthStart && paymentDate <= monthEnd;
    });
  }, [debtorPayments, selectedMonth, selectedYear]);

  // Monthly stats calculation
  const monthlyStats = useMemo(() => {
    // Only count completed and partially_refunded sales
    const countableSales = monthlyFilteredSales.filter(s => s.status !== 'refunded');
    const refundedSales = monthlyFilteredSales.filter(s => s.status === 'refunded');

    const totalRevenue = countableSales.reduce((sum, s) => sum + (s.total || 0), 0);
    const refundedAmount = refundedSales.reduce((sum, s) => sum + (s.total || 0), 0);
    const businessExpenses = monthlyFilteredExpenses
      .filter(e => (e.category ?? 'business') === 'business')
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const ownerDrawings = monthlyFilteredExpenses
      .filter(e => e.category === 'personal')
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const totalOutflows = businessExpenses + ownerDrawings;
    const totalDiscounts = countableSales.reduce((sum, s) => sum + (s.discountAmount || 0), 0);

    // Cash received: PAID sales (cash + mobile) that are NOT credit
    const cashFromSales = countableSales
      .filter(s => s.paymentMethod === 'cash' || s.paymentMethod === 'mobile_money')
      .reduce((sum, s) => sum + (s.total || 0), 0);

    // Cash from debtor payments
    const cashFromDebtors = monthlyDebtorPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const totalCashReceived = cashFromSales + cashFromDebtors;

    // Calculate profit from cost prices, accounting for discounts
    let totalProfit = 0;
    let totalCost = 0;
    let hasCostData = false;
    countableSales.forEach(sale => {
      const saleDiscount = Number(sale.discountAmount) || 0;
      const saleSubtotal = Number(sale.subtotal) || 0;

      (sale.items || []).forEach(item => {
        const costPrice = Number(item.costPrice) || 0;
        const sellingPrice = Number(item.price) || 0;
        const qty = Number(item.quantity) || 0;
        const itemTotal = sellingPrice * qty;

        const itemDiscountShare = saleSubtotal > 0 ? (itemTotal / saleSubtotal) * saleDiscount : 0;
        const itemRevenue = itemTotal - itemDiscountShare;

        totalCost += costPrice * qty;
        if (costPrice > 0) {
          hasCostData = true;
          const itemCost = costPrice * qty;
          totalProfit += itemRevenue - itemCost;
        }
      });
    });

    // Net Profit subtracts BOTH business expenses AND owner drawings — owner
    // drawings aren't a true expense in accounting terms, but they reduce
    // available business cash so business owners need to see them netted out.
    const netProfit = hasCostData
      ? totalProfit - totalOutflows
      : totalRevenue - totalOutflows;
    const netCashPosition = totalCashReceived - totalOutflows;

    const taxCollected = countableSales.reduce((s, x) => s + (Number(x.taxAmount) || 0), 0);
    const taxableSales = countableSales.reduce((s, x) => s + (Number(x.taxableAmount) || 0), 0);
    const zeroRatedSales = countableSales.reduce((s, x) => s + (Number(x.zeroRatedAmount) || 0), 0);
    const exemptSales = countableSales.reduce((s, x) => s + (Number(x.exemptAmount) || 0), 0);

    return {
      totalRevenue,
      refundedAmount,
      totalExpenses: businessExpenses,
      ownerDrawings,
      totalOutflows,
      totalDiscounts,
      totalCashReceived,
      cashFromSales,
      cashFromDebtors,
      netProfit,
      netCashPosition,
      totalProfit,
      totalCost,
      hasCostData,
      transactionCount: countableSales.length,
      refundCount: refundedSales.length,
      taxCollected, taxableSales, zeroRatedSales, exemptSales,
    };
  }, [monthlyFilteredSales, monthlyFilteredExpenses, monthlyDebtorPayments]);

  const stats = useMemo(() => {
    // Only count completed and partially_refunded sales
    const countableSales = filteredSales.filter(s => s.status !== 'refunded');
    const totalRevenue = countableSales.reduce((sum, s) => sum + (s.total || 0), 0);
    const totalSales = countableSales.length;
    const cashSales = countableSales.filter((s) => s.paymentMethod === "cash").length;
    const mobileSales = countableSales.filter((s) => s.paymentMethod === "mobile_money").length;
    const avgSale = totalSales > 0 ? totalRevenue / totalSales : 0;
    const businessExpenses = filteredExpenses
      .filter(e => (e.category ?? 'business') === 'business')
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const ownerDrawings = filteredExpenses
      .filter(e => e.category === 'personal')
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const totalOutflows = businessExpenses + ownerDrawings;

    // Calculate profit from cost prices, accounting for discounts
    let totalProfit = 0;
    let totalCost = 0;
    let hasCostData = false;
    countableSales.forEach(sale => {
      const saleDiscount = Number(sale.discountAmount) || 0;
      const saleSubtotal = Number(sale.subtotal) || 0;

      (sale.items || []).forEach(item => {
        const costPrice = Number(item.costPrice) || 0;
        const sellingPrice = Number(item.price) || 0;
        const qty = Number(item.quantity) || 0;
        const itemTotal = sellingPrice * qty;

        // Proportionally distribute discount across items
        const itemDiscountShare = saleSubtotal > 0 ? (itemTotal / saleSubtotal) * saleDiscount : 0;
        const itemRevenue = itemTotal - itemDiscountShare;

        totalCost += costPrice * qty;
        if (costPrice > 0) {
          hasCostData = true;
          const itemCost = costPrice * qty;
          totalProfit += itemRevenue - itemCost;
        }
      });
    });

    // Both business expenses and owner drawings reduce business cash
    const netProfit = hasCostData
      ? totalProfit - totalOutflows
      : totalRevenue - totalOutflows;

    const taxCollected = countableSales.reduce((s, x) => s + (Number(x.taxAmount) || 0), 0);
    const taxableSales = countableSales.reduce((s, x) => s + (Number(x.taxableAmount) || 0), 0);
    const zeroRatedSales = countableSales.reduce((s, x) => s + (Number(x.zeroRatedAmount) || 0), 0);
    const exemptSales = countableSales.reduce((s, x) => s + (Number(x.exemptAmount) || 0), 0);

    return {
      totalRevenue, totalSales, cashSales, mobileSales, avgSale,
      totalExpenses: businessExpenses,
      ownerDrawings,
      totalOutflows,
      netProfit, totalProfit, totalCost, hasCostData,
      taxCollected, taxableSales, zeroRatedSales, exemptSales,
    };
  }, [filteredSales, filteredExpenses]);

  const handleDeleteSale = async (sale: Sale) => {
    if (!confirm("Delete this sale? This will reverse the stock changes. Use this only for entry mistakes.")) return;

    setDeleting(sale.id);
    try {
      if (!isOnline) {
        await queuePendingOp({
          id: generateOfflineId(),
          businessId: business.id,
          type: 'sale_delete',
          payload: { saleId: sale.id, items: sale.items },
          createdAt: new Date().toISOString(),
        });
        toast({ title: "Sale deletion queued", description: "Sale will be deleted and stock restored when online." });
        setDeleting(null);
        return;
      }

      // Return stock to products (batched, avoids N+1)
      const productIds = [...new Set(sale.items.map((i: any) => i.productId).filter(Boolean))];
      if (productIds.length > 0) {
        const { data: products } = await supabase
          .from("products")
          .select("id, stock")
          .in("id", productIds);
        if (products) {
          const stockMap = Object.fromEntries(products.map((p: any) => [p.id, Number(p.stock ?? 0)]));
          const updates = sale.items.map((item: any) => item.productId && stockMap[item.productId] !== undefined
            ? supabase.from("products").update({ stock: stockMap[item.productId] + (item.quantity || 0) }).eq("id", item.productId)
            : null
          ).filter(Boolean);
          await Promise.all(updates);
        }
      }

      // Delete the sale
      const { error } = await supabase
        .from("sales")
        .delete()
        .eq("id", sale.id);

      if (error) throw error;

      toast({ title: "Sale Deleted", description: "Stock has been restored." });
      await fetchData();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not delete sale" });
    } finally {
      setDeleting(null);
    }
  };

  const getStatusBadge = (sale: Sale) => {
    if (sale.status === 'refunded') {
      return <Badge variant="destructive" className="text-xs"><RotateCcw className="h-3 w-3 mr-1" /> Refunded</Badge>;
    }
    if (sale.status === 'partially_refunded') {
      return <Badge className="bg-amber-500 text-xs"><Clock className="h-3 w-3 mr-1" /> Partial Refund</Badge>;
    }
    const ps = sale.paymentStatus || (sale.paymentMethod === 'credit' ? 'pending' : 'paid');
    if (ps === 'overdue') {
      return <Badge variant="destructive" className="text-xs">Overdue</Badge>;
    }
    if (ps === 'pending') {
      return <Badge className="text-xs bg-orange-500/20 text-orange-700 border border-orange-500/40">Pending</Badge>;
    }
    if (ps === 'partially_paid') {
      return <Badge className="text-xs bg-amber-500/20 text-amber-700 border border-amber-500/40">Partially Paid</Badge>;
    }
    return <Badge variant="outline" className="text-xs bg-green-500/20 text-green-700"><Check className="h-3 w-3 mr-1" />Paid</Badge>;
  };

  // Short invoice label from sale id
  const invoiceLabel = (id: string) => `INV-${id.replace(/-/g, '').slice(-6).toUpperCase()}`;

  // ---- Record-payment dialog state ----
  const [payingSale, setPayingSale] = useState<Sale | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("cash");
  const [paySubmitting, setPaySubmitting] = useState(false);

  const submitPayment = async () => {
    if (!payingSale || !business) return;
    const amt = Number(payAmount);
    if (!amt || amt <= 0) {
      toast({ variant: "destructive", title: "Enter amount", description: "Payment must be greater than 0." });
      return;
    }
    const balance = Number(payingSale.balanceDue ?? 0);
    if (amt > balance + 0.001) {
      toast({ variant: "destructive", title: "Exceeds balance", description: `Balance is ZMW ${balance.toFixed(2)}.` });
      return;
    }
    setPaySubmitting(true);
    try {
      const { error } = await (supabase.rpc as any)("record_sale_payment", {
        p_sale_id: payingSale.id,
        p_amount: amt,
        p_payment_method: payMethod,
      });
      if (error) throw error;
      toast({ title: "Payment recorded", description: `ZMW ${amt.toFixed(2)} applied.` });
      setPayingSale(null);
      setPayAmount("");
      setPayMethod("cash");
      void fetchData();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message || "Could not record payment." });
    } finally {
      setPaySubmitting(false);
    }
  };


  // Calculate item profit for display
  const calculateItemProfit = (sale: Sale, item: SaleItem) => {
    const costPrice = Number(item.costPrice) || 0;
    if (costPrice === 0) return null;
    
    const sellingPrice = Number(item.price) || 0;
    const qty = Number(item.quantity) || 0;
    const saleDiscount = Number(sale.discountAmount) || 0;
    const saleSubtotal = Number(sale.subtotal) || 0;
    const itemTotal = sellingPrice * qty;
    
    const itemDiscountShare = saleSubtotal > 0 ? (itemTotal / saleSubtotal) * saleDiscount : 0;
    const itemRevenue = itemTotal - itemDiscountShare;
    const itemCost = costPrice * qty;
    
    return itemRevenue - itemCost;
  };

  // Generate year options (last 5 years to current)
  const yearOptions = useMemo(() => {
    const currentYear = getYear(new Date());
    return Array.from({ length: 5 }, (_, i) => currentYear - i);
  }, []);

  if (authLoading || bizLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!business) return null;

  if (isLocked) {
    return (
      <>
        <ConnectionStatus />
        <LockScreen paymentCode={business.paymentCode} businessId={business.id} onRetrySync={refetchBusiness} />
      </>
    );
  }

  const periodLabel = {
    today: "Today",
    week: "This Week",
    month: "This Month",
    all: "All Time",
  };

  const handleExportCsv = () => {
    const salesToExport = activeTab === "monthly" ? monthlyFilteredSales : filteredSales;
    const filename = activeTab === "monthly" 
      ? `${business.name.replace(/\s+/g, '-')}-${MONTHS[selectedMonth]}-${selectedYear}-sales`
      : `${business.name.replace(/\s+/g, '-')}-sales`;
    exportSalesToCsv(salesToExport, filename);
    toast({ title: 'Exported', description: 'Sales data downloaded as CSV' });
  };

  const renderSaleItem = (sale: Sale) => (
    <div key={sale.id} className={`bg-secondary rounded-lg p-3 ${sale.status === 'refunded' ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-mono text-xs text-muted-foreground">{invoiceLabel(sale.id)}</p>
            <p className="font-medium">ZMW {sale.total.toFixed(2)}</p>
            {getStatusBadge(sale)}
          </div>
          <p className="text-xs text-muted-foreground">
            {format(new Date(sale.createdAt), "MMM d, yyyy h:mm a")}
            {sale.cashierName ? ` • Cashier: ${sale.cashierName}` : ''}
            {sale.paymentMethod ? ` • ${sale.paymentMethod.replace('_', ' ')}` : ''}
            {sale.customerName ? ` • ${sale.customerName}` : ''}
            {sale.customerPhone ? ` • ${sale.customerPhone}` : ''}
          </p>
          {(Number(sale.balanceDue ?? 0) > 0 || Number(sale.amountPaid ?? sale.total) < sale.total) && (
            <p className="text-xs">
              <span className="text-green-700">Paid: ZMW {Number(sale.amountPaid ?? 0).toFixed(2)}</span>
              {' • '}
              <span className="text-orange-700">Balance: ZMW {Number(sale.balanceDue ?? Math.max(0, sale.total - Number(sale.amountPaid ?? 0))).toFixed(2)}</span>
              {sale.dueDate ? ` • Due ${format(new Date(sale.dueDate), "MMM d, yyyy")}` : ''}
            </p>
          )}
          {sale.discountAmount > 0 && (
            <p className="text-xs text-green-600">Discount: ZMW {sale.discountAmount.toFixed(2)}</p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          {!sale.synced && (
            <Badge variant="secondary" className="text-xs bg-amber-500/20 text-amber-700">
              Pending
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-9 p-0"
            onClick={() => setViewingSale(sale)}
            aria-label="View receipt"
            title="View receipt"
          >
            <Eye className="h-4 w-4" />
          </Button>
          {sale.synced && sale.status === 'completed' && Number(sale.balanceDue ?? 0) > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-2 text-xs"
              onClick={() => { setPayingSale(sale); setPayAmount(String(sale.balanceDue ?? '')); }}
              aria-label="Record payment"
              title="Record payment"
            >
              <DollarSign className="h-3.5 w-3.5 mr-1" /> Pay
            </Button>
          )}
          {sale.synced && sale.status === 'completed' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0"
                onClick={() => setEditingSale(sale)}
                aria-label="Edit sale"
              >
                <Edit className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0"
                onClick={() => handleDeleteSale(sale)}
                disabled={deleting === sale.id}
                aria-label="Delete sale"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </>
          )}
        </div>

      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        {sale.items.map((item, idx) => {
          const profit = calculateItemProfit(sale, item);
          const costPrice = Number(item.costPrice) || 0;
          const itemCost = costPrice * (Number(item.quantity) || 0);
          return (
            <div key={idx} className="flex justify-between gap-3">
              <span>{item.quantity}× {item.name}</span>
              <span className="flex gap-3 shrink-0">
                {costPrice > 0 && (
                  <span className="text-muted-foreground">
                    Cost: ZMW {itemCost.toFixed(2)}
                  </span>
                )}
                {profit !== null && (
                  <span className={`${profit >= 0 ? 'text-green-600' : 'text-destructive'}`}>
                    Profit: ZMW {profit.toFixed(2)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <>
      <ConnectionStatus />

      {/* Record Payment dialog */}
      <Dialog open={!!payingSale} onOpenChange={(o) => { if (!o) { setPayingSale(null); setPayAmount(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>
              {payingSale && (
                <>
                  {invoiceLabel(payingSale.id)}
                  {payingSale.customerName ? ` • ${payingSale.customerName}` : ''}
                  {' • Balance: '}<strong>ZMW {Number(payingSale.balanceDue ?? 0).toFixed(2)}</strong>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-sm">Amount (ZMW)</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Payment Method</Label>
              <Select value={payMethod} onValueChange={setPayMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="mobile_money">Mobile Money</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                  <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPayingSale(null); setPayAmount(""); }} disabled={paySubmitting}>Cancel</Button>
            <Button onClick={submitPayment} disabled={paySubmitting}>
              {paySubmitting ? "Recording…" : "Record Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EditSaleModal 
        sale={editingSale} 
        onClose={() => setEditingSale(null)} 
        onUpdated={fetchData} 
      />
      {viewingSale && (
        <ReceiptModal
          open={!!viewingSale}
          onClose={() => setViewingSale(null)}
          businessName={business.name}
          businessDetails={{
            phone: (business as any).phone ?? null,
            email: (business as any).email ?? null,
            address: (business as any).address ?? null,
          }}
          items={(viewingSale.items || []).map((i) => ({
            name: i.name,
            price: Number(i.price) || 0,
            quantity: Number(i.quantity) || 0,
            discountType: i.discountType ?? undefined,
            discountValue: i.discountValue,
          }))}
          subtotal={viewingSale.subtotal}
          total={viewingSale.total}
          paymentMethod={viewingSale.paymentMethod}
          date={viewingSale.createdAt}
          receiptId={viewingSale.id}
          discountAmount={viewingSale.discountAmount}
        />
      )}

      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-4 py-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")} aria-label="Back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="font-display font-bold text-lg flex items-center gap-2">
                  <Receipt className="h-5 w-5" /> Sales & Reports
                </h1>
                <p className="text-xs text-muted-foreground">{isOnline ? "Online" : "Offline (cached data)"}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Receipt..."
                  value={receiptSearch}
                  onChange={(e) => setReceiptSearch(e.target.value)}
                  className="w-full max-w-[160px] h-8 pl-7 pr-7 text-sm"
                />
                {receiptSearch && (
                  <button onClick={() => setReceiptSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                    <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
              </div>

            <Button variant="outline" size="sm" onClick={handleExportCsv}>
              <Download className="h-4 w-4 mr-1" /> CSV
            </Button>
          </div>
          </div>
        </header>

        <main className="p-4 max-w-4xl mx-auto space-y-4">
          {/* View Mode Tabs */}
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "quick" | "monthly")} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="quick">Quick View</TabsTrigger>
              <TabsTrigger value="monthly">Monthly View</TabsTrigger>
            </TabsList>

            {/* Quick View Tab */}
            <TabsContent value="quick" className="space-y-4">
              {/* Period Filter */}
              <div className="flex justify-end">
                <Select value={period} onValueChange={(v) => setPeriod(v as FilterPeriod)}>
                  <SelectTrigger className="w-full max-w-[140px]">
                    <Calendar className="h-4 w-4 mr-2" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="week">This Week</SelectItem>
                    <SelectItem value="month">This Month</SelectItem>
                    <SelectItem value="all">All Time</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Stats Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground">Total Sales</p>
                    <p className="text-xl font-display font-bold text-primary">ZMW {stats.totalRevenue.toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground">Expenses</p>
                    <p className="text-xl font-display font-bold text-destructive">ZMW {stats.totalExpenses.toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground">Cost of Goods</p>
                    <p className="text-xl font-display font-bold">ZMW {stats.totalCost.toFixed(2)}</p>
                    {stats.hasCostData && (
                      <p className="text-xs text-muted-foreground mt-1">(Cost × Quantity)</p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground">{stats.hasCostData ? 'Gross Profit' : 'Net Profit'}</p>
                    <p className={`text-xl font-display font-bold ${stats.netProfit >= 0 ? 'text-green-600' : 'text-destructive'}`}>
                      ZMW {stats.netProfit.toFixed(2)}
                    </p>
                    {stats.hasCostData && (
                      <p className="text-xs text-muted-foreground mt-1">(Sales - Costs - Expenses)</p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground">Transactions</p>
                    <p className="text-xl font-display font-bold">{stats.totalSales}</p>
                  </CardContent>
                </Card>
              </div>

              {/* Payment method breakdown (quick view) */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">By Payment Method</CardTitle>
                  <CardDescription>For the selected period</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div><p className="text-xs text-muted-foreground">Cash</p><p className="font-bold">{stats.cashSales} sales</p></div>
                    <div><p className="text-xs text-muted-foreground">Mobile Money</p><p className="font-bold">{stats.mobileSales} sales</p></div>
                    <div><p className="text-xs text-muted-foreground">Other</p><p className="font-bold">{stats.totalSales - stats.cashSales - stats.mobileSales} sales</p></div>
                    <div><p className="text-xs text-muted-foreground">Total Revenue</p><p className="font-bold">ZMW {stats.totalRevenue.toFixed(2)}</p></div>
                  </div>
                </CardContent>
              </Card>

              {/* Tax Summary (quick view) */}
              {(stats.taxCollected > 0 || stats.taxableSales > 0 || stats.zeroRatedSales > 0 || stats.exemptSales > 0) && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Tax Summary</CardTitle>
                    <CardDescription>For the selected period</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div><p className="text-xs text-muted-foreground">Tax Collected</p><p className="font-bold">ZMW {stats.taxCollected.toFixed(2)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Taxable Sales</p><p className="font-bold">ZMW {stats.taxableSales.toFixed(2)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Zero Rated</p><p className="font-bold">ZMW {stats.zeroRatedSales.toFixed(2)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Exempt</p><p className="font-bold">ZMW {stats.exemptSales.toFixed(2)}</p></div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Tabs defaultValue="sales" className="w-full">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="sales">Sales</TabsTrigger>
                  <TabsTrigger value="top">Top Selling</TabsTrigger>
                  <TabsTrigger value="expenses">Expenses</TabsTrigger>
                </TabsList>

                <TabsContent value="sales" className="space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <TrendingUp className="h-5 w-5" />
                        {periodLabel[period]} Sales
                      </CardTitle>
                      <CardDescription>{filteredSales.length} transactions</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {filteredSales.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">No sales in this period.</p>
                      ) : (
                        filteredSales.map(renderSaleItem)
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="top" className="space-y-4">
                  {(function TopSelling() {
                    const aggregated = new Map<string, { qty: number; revenue: number }>();
                    for (const sale of filteredSales) {
                      if (sale.status === 'refunded') continue;
                      for (const item of sale.items) {
                        const existing = aggregated.get(item.name) || { qty: 0, revenue: 0 };
                        existing.qty += item.quantity;
                        existing.revenue += item.quantity * item.price;
                        aggregated.set(item.name, existing);
                      }
                    }
                    const sorted = [...aggregated.entries()]
                      .map(([name, data]) => ({ name, qty: data.qty, revenue: data.revenue }))
                      .sort((a, b) => topSellingSortBy === "qty" ? b.qty - a.qty : b.revenue - a.revenue)
                      .slice(0, 50);
                    const display = sorted;
                    return (
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-lg flex items-center gap-2">
                            <BarChart3 className="h-5 w-5" />
                            Top Selling Products
                          </CardTitle>
                          <CardDescription>
                            <button className="text-xs text-primary underline mr-3" onClick={() => setTopSellingSortBy("qty")}>
                              {topSellingSortBy === "qty" ? <b>By Qty</b> : "By Qty"}
                            </button>
                            <button className="text-xs text-primary underline" onClick={() => setTopSellingSortBy("revenue")}>
                              {topSellingSortBy === "revenue" ? <b>By Revenue</b> : "By Revenue"}
                            </button>
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          {display.length === 0 ? (
                            <p className="text-sm text-muted-foreground py-4 text-center">No sales data in this period.</p>
                          ) : (
                            <div className="divide-y divide-border text-sm">
                              {display.map((item, i) => (
                                <div key={item.name} className="flex items-center justify-between py-2">
                                  <div className="flex items-center gap-3 min-w-0">
                                    <span className="text-muted-foreground font-mono text-xs w-5 shrink-0">#{i + 1}</span>
                                    <span className="truncate">{item.name}</span>
                                  </div>
                                  <div className="flex items-center gap-4 shrink-0 text-xs">
                                    <span className="font-medium">{item.qty} sold</span>
                                    <span className="text-muted-foreground">K{item.revenue.toFixed(2)}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })()}
                </TabsContent>

                <TabsContent value="expenses" className="space-y-4">
                  <ExpensesSection 
                    businessId={business.id} 
                    isOnline={isOnline}
                    onExpenseChanged={fetchData}
                  />
                </TabsContent>
              </Tabs>
            </TabsContent>

            {/* Monthly View Tab */}
            <TabsContent value="monthly" className="space-y-4">
              {/* Month/Year Selector */}
              <div className="flex gap-2 flex-wrap">
                <Select value={selectedMonth.toString()} onValueChange={(v) => setSelectedMonth(parseInt(v))}>
                  <SelectTrigger className="w-full max-w-[140px]">
                    <Calendar className="h-4 w-4 mr-2" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((month, idx) => (
                      <SelectItem key={idx} value={idx.toString()}>{month}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={selectedYear.toString()} onValueChange={(v) => setSelectedYear(parseInt(v))}>
                  <SelectTrigger className="w-full max-w-[100px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {yearOptions.map((year) => (
                      <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Monthly Stats Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <DollarSign className="h-4 w-4 text-primary" />
                      <p className="text-xs text-muted-foreground">Total Sales</p>
                    </div>
                    <p className="text-xl font-display font-bold text-primary">ZMW {monthlyStats.totalRevenue.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">{monthlyStats.transactionCount} transactions</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="h-4 w-4 text-destructive" />
                      <p className="text-xs text-muted-foreground">Total Expenses</p>
                    </div>
                    <p className="text-xl font-display font-bold text-destructive">ZMW {monthlyStats.totalExpenses.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">{monthlyFilteredExpenses.length} entries</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="h-4 w-4 text-amber-600" />
                      <p className="text-xs text-muted-foreground">Cost of Goods</p>
                    </div>
                    <p className="text-xl font-display font-bold">ZMW {monthlyStats.totalCost.toFixed(2)}</p>
                    {monthlyStats.hasCostData && (
                      <p className="text-xs text-muted-foreground">(Cost × Quantity)</p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="h-4 w-4 text-green-600" />
                      <p className="text-xs text-muted-foreground">{monthlyStats.hasCostData ? 'Net Profit' : 'Profit'}</p>
                    </div>
                    <p className={`text-xl font-display font-bold ${monthlyStats.netProfit >= 0 ? 'text-green-600' : 'text-destructive'}`}>
                      ZMW {monthlyStats.netProfit.toFixed(2)}
                    </p>
                    {monthlyStats.hasCostData && (
                      <p className="text-xs text-muted-foreground">(Revenue - Costs - Expenses)</p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Tag className="h-4 w-4 text-amber-500" />
                      <p className="text-xs text-muted-foreground">Total Discounts</p>
                    </div>
                    <p className="text-xl font-display font-bold text-amber-600">ZMW {monthlyStats.totalDiscounts.toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Wallet className="h-4 w-4 text-green-600" />
                      <p className="text-xs text-muted-foreground">Cash Received</p>
                    </div>
                    <p className="text-xl font-display font-bold text-green-600">ZMW {monthlyStats.totalCashReceived.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">
                      Sales: ZMW {monthlyStats.cashFromSales.toFixed(2)} | Debt: ZMW {monthlyStats.cashFromDebtors.toFixed(2)}
                    </p>
                  </CardContent>
                </Card>
                {monthlyStats.refundCount > 0 && (
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 mb-1">
                        <RotateCcw className="h-4 w-4 text-destructive" />
                        <p className="text-xs text-muted-foreground">Refunds</p>
                      </div>
                      <p className="text-xl font-display font-bold text-destructive">ZMW {monthlyStats.refundedAmount.toFixed(2)}</p>
                      <p className="text-xs text-muted-foreground">{monthlyStats.refundCount} refunded</p>
                    </CardContent>
                  </Card>
                )}
              </div>

              {/* Monthly Payment Method Breakdown */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">By Payment Method — {MONTHS[selectedMonth]} {selectedYear}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div><p className="text-xs text-muted-foreground">Cash</p><p className="font-bold">{monthlyFilteredSales.filter(s => s.paymentMethod === 'cash').length} sales</p></div>
                    <div><p className="text-xs text-muted-foreground">Mobile Money</p><p className="font-bold">{monthlyFilteredSales.filter(s => s.paymentMethod === 'mobile_money').length} sales</p></div>
                    <div><p className="text-xs text-muted-foreground">Other</p><p className="font-bold">{monthlyFilteredSales.filter(s => s.paymentMethod !== 'cash' && s.paymentMethod !== 'mobile_money').length} sales</p></div>
                    <div><p className="text-xs text-muted-foreground">Total Revenue</p><p className="font-bold">ZMW {monthlyStats.totalRevenue.toFixed(2)}</p></div>
                  </div>
                </CardContent>
              </Card>

              {/* Monthly Tax Summary */}
              {(monthlyStats.taxCollected > 0 || monthlyStats.taxableSales > 0 || monthlyStats.zeroRatedSales > 0 || monthlyStats.exemptSales > 0) && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Tax Summary — {MONTHS[selectedMonth]} {selectedYear}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div><p className="text-xs text-muted-foreground">Tax Collected</p><p className="font-bold">ZMW {monthlyStats.taxCollected.toFixed(2)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Taxable Sales</p><p className="font-bold">ZMW {monthlyStats.taxableSales.toFixed(2)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Zero Rated</p><p className="font-bold">ZMW {monthlyStats.zeroRatedSales.toFixed(2)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Exempt</p><p className="font-bold">ZMW {monthlyStats.exemptSales.toFixed(2)}</p></div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Monthly Sales List */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <TrendingUp className="h-5 w-5" />
                    {MONTHS[selectedMonth]} {selectedYear} Sales
                  </CardTitle>
                  <CardDescription>{monthlyFilteredSales.length} transactions</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 max-h-[60vh] overflow-y-auto">
                  {monthlyFilteredSales.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">No sales in {MONTHS[selectedMonth]} {selectedYear}.</p>
                  ) : (
                    monthlyFilteredSales.map(renderSaleItem)
                  )}
                </CardContent>
              </Card>

              {/* Monthly Top Selling */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <BarChart3 className="h-5 w-5" />
                    Top Selling — {MONTHS[selectedMonth]} {selectedYear}
                  </CardTitle>
                  <CardDescription>
                    <button className="text-xs text-primary underline mr-3" onClick={() => setTopSellingSortBy("qty")}>
                      {topSellingSortBy === "qty" ? <b>By Qty</b> : "By Qty"}
                    </button>
                    <button className="text-xs text-primary underline" onClick={() => setTopSellingSortBy("revenue")}>
                      {topSellingSortBy === "revenue" ? <b>By Revenue</b> : "By Revenue"}
                    </button>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {(function() {
                    const aggregated = new Map<string, { qty: number; revenue: number }>();
                    for (const sale of monthlyFilteredSales) {
                      if (sale.status === 'refunded') continue;
                      for (const item of sale.items) {
                        const existing = aggregated.get(item.name) || { qty: 0, revenue: 0 };
                        existing.qty += item.quantity;
                        existing.revenue += item.quantity * item.price;
                        aggregated.set(item.name, existing);
                      }
                    }
                    const display = [...aggregated.entries()]
                      .map(([name, data]) => ({ name, qty: data.qty, revenue: data.revenue }))
                      .sort((a, b) => topSellingSortBy === "qty" ? b.qty - a.qty : b.revenue - a.revenue)
                      .slice(0, 50);
                    return display.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">No sales data in this period.</p>
                    ) : (
                      <div className="divide-y divide-border text-sm">
                        {display.map((item, i) => (
                          <div key={item.name} className="flex items-center justify-between py-2">
                            <div className="flex items-center gap-3 min-w-0">
                              <span className="text-muted-foreground font-mono text-xs w-5 shrink-0">#{i + 1}</span>
                              <span className="truncate">{item.name}</span>
                            </div>
                            <div className="flex items-center gap-4 shrink-0 text-xs">
                              <span className="font-medium">{item.qty} sold</span>
                              <span className="text-muted-foreground">K{item.revenue.toFixed(2)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>

              {/* Monthly Expenses Summary */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Expenses Summary</CardTitle>
                  <CardDescription>{monthlyFilteredExpenses.length} expense entries</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {monthlyFilteredExpenses.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">No expenses in {MONTHS[selectedMonth]} {selectedYear}.</p>
                  ) : (
                    monthlyFilteredExpenses.map((expense) => (
                      <div key={expense.id} className="bg-secondary rounded-lg p-3 flex justify-between items-center">
                        <div>
                          <p className="font-medium">{expense.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(expense.expense_date), "MMM d, yyyy")}
                          </p>
                          {expense.notes && (
                            <p className="text-xs text-muted-foreground">{expense.notes}</p>
                          )}
                        </div>
                        <p className="font-bold text-destructive">ZMW {Number(expense.amount).toFixed(2)}</p>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <Button variant="outline" className="w-full" onClick={fetchData}>
            Refresh
          </Button>
        </main>
      </div>
    </>
  );
};

export default SalesHistory;

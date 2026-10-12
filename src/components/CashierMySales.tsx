import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Receipt, CalendarDays, Banknote, Smartphone, CreditCard, Wallet } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import ReceiptModal from "@/components/ReceiptModal";
import { useAuthContext } from "@/contexts/AuthContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { supabase } from "@/integrations/supabase/client";
import { getUnsyncedSales } from "@/lib/offlineStorage";
import { lusakaDayRange, lusakaDateLabel } from "@/lib/dateRange";
import { formatZMW } from "@/lib/currency";

interface BusinessDetails {
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  logoUrl?: string | null;
  tpin?: string | null;
  taxMode?: string | null;
  vatRate?: number | null;
  customTaxName?: string | null;
  customTaxRate?: number | null;
}

interface CashierMySalesProps {
  businessId: string;
  businessName: string;
  businessDetails?: BusinessDetails;
  isService?: boolean;
}

type SaleItem = {
  productId?: string;
  name: string;
  price: number;
  quantity: number;
};

type MySale = {
  id: string;
  items: SaleItem[];
  subtotal: number;
  total: number;
  discountAmount: number;
  paymentMethod: string;
  createdAt: string;
  synced: boolean;
  status: "completed" | "refunded" | "partially_refunded";
  taxAmount: number;
  customerName?: string | null;
  customerTpin?: string | null;
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Cash",
  mobile_money: "Mobile Money",
  card: "Card",
  credit: "Credit",
  bank_transfer: "Bank Transfer",
};

const paymentLabel = (m: string) => PAYMENT_LABELS[m] || (m ? m.replace(/_/g, " ") : "—");

// Transaction time shown on the Lusaka wall clock (UTC+2, no DST) so it matches
// the day the sale is filed under, regardless of the device timezone.
const lusakaTime = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 2 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

const invoiceLabel = (id: string) => `INV-${id.replace(/-/g, "").slice(-6).toUpperCase()}`;

const CashierMySales = ({ businessId, businessName, businessDetails, isService = false }: CashierMySalesProps) => {
  const { user } = useAuthContext();
  const { isOnline } = useOnlineStatus();
  const [dayOffset, setDayOffset] = useState(0);
  const [sales, setSales] = useState<MySale[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingSale, setViewingSale] = useState<MySale | null>(null);

  const { from, to } = useMemo(
    () => lusakaDayRange(new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000)),
    [dayOffset]
  );

  const load = async () => {
    if (!businessId || !user?.id) return;
    setLoading(true);
    try {
      let online: MySale[] = [];
      let onlineFetched = false;

      if (isOnline) {
        const { data, error } = await supabase
          .from("sales")
          .select("id, items, subtotal, total, discount_amount, payment_method, created_at, status, tax_amount, customer_name, customer_tpin")
          .eq("business_id", businessId)
          .eq("cashier_id", user.id)
          .gte("created_at", from.toISOString())
          .lte("created_at", to.toISOString())
          .order("created_at", { ascending: false })
          .limit(500);

        if (!error && data) {
          online = (data as Array<Record<string, unknown>>).map((s) => ({
            id: String(s.id),
            items: Array.isArray(s.items) ? (s.items as SaleItem[]) : [],
            subtotal: Number(s.subtotal) || 0,
            total: Number(s.total) || 0,
            discountAmount: Number(s.discount_amount) || 0,
            paymentMethod: String(s.payment_method || "cash"),
            createdAt: String(s.created_at),
            synced: true,
            status: (s.status as MySale["status"]) || "completed",
            taxAmount: Number(s.tax_amount) || 0,
            customerName: (s.customer_name as string | null) ?? null,
            customerTpin: (s.customer_tpin as string | null) ?? null,
          }));
          onlineFetched = true;
        }
      }

      // Sales rung offline on this device. Only merge the ones this cashier rang
      // (legacy records predating the cashier stamp have no id, so they count as
      // ours) — an unsynced sale left behind by a previous cashier must not show
      // in someone else's "My Sales".
      const unsynced = await getUnsyncedSales(businessId);
      const offlineMine: MySale[] = unsynced
        .filter((s) => !s.cashierUserId || s.cashierUserId === user.id)
        .filter((s) => {
          const t = new Date(s.createdAt).getTime();
          return t >= from.getTime() && t <= to.getTime();
        })
        .map((s) => ({
          id: s.id,
          items: s.items || [],
          subtotal: s.subtotal || 0,
          total: s.total || 0,
          discountAmount: s.discountAmount || 0,
          paymentMethod: s.paymentMethod || "cash",
          createdAt: s.createdAt,
          synced: false,
          status: "completed" as const,
          taxAmount: s.taxAmount || 0,
          customerName: s.customerName ?? null,
          customerTpin: s.customerTpin ?? null,
        }));

      // Merge and de-dupe by offline id (an offline sale that has since synced
      // appears in both lists).
      const seen = new Set<string>();
      const merged = [...offlineMine, ...(onlineFetched ? online : [])]
        .filter((s) => {
          if (seen.has(s.id)) return false;
          seen.add(s.id);
          return true;
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      setSales(merged);
    } catch (e) {
      console.error("Failed to load my sales:", e);
    } finally {
      setLoading(false);
    }
  };

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void loadRef.current();
  }, [businessId, user?.id, isOnline, dayOffset]);

  useEffect(() => {
    if (!businessId || !user?.id) return;
    const channel = supabase
      .channel(`my-sales-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sales", filter: `cashier_id=eq.${user.id}` },
        () => { void loadRef.current(); }
      )
      .subscribe();
    const handler = () => { void loadRef.current(); };
    window.addEventListener("zampos:sync-complete", handler);
    window.addEventListener("zampos:sales-changed", handler);
    window.addEventListener("zampos:sale-payment-changed", handler);
    const interval = setInterval(() => { void loadRef.current(); }, 60000);
    return () => {
      void supabase.removeChannel(channel);
      window.removeEventListener("zampos:sync-complete", handler);
      window.removeEventListener("zampos:sales-changed", handler);
      window.removeEventListener("zampos:sale-payment-changed", handler);
      clearInterval(interval);
    };
  }, [businessId, user?.id]);

  const summary = useMemo(() => {
    const countable = sales.filter((s) => s.status !== "refunded");
    const refunded = sales.filter((s) => s.status === "refunded");
    let gross = 0;
    let discounts = 0;
    const methods: Record<string, number> = { cash: 0, mobile_money: 0, card: 0, credit: 0, other: 0 };
    for (const s of countable) {
      gross += s.total || 0;
      discounts += s.discountAmount || 0;
      const key =
        s.paymentMethod === "cash" ? "cash" :
        s.paymentMethod === "mobile_money" ? "mobile_money" :
        s.paymentMethod === "card" ? "card" :
        s.paymentMethod === "credit" ? "credit" : "other";
      methods[key] += s.total || 0;
    }
    return {
      count: countable.length,
      gross,
      discounts,
      methods,
      refundCount: refunded.length,
      refundTotal: refunded.reduce((a, s) => a + (s.total || 0), 0),
    };
  }, [sales]);

  const refDate = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
  const dayLabel =
    dayOffset === 0 ? "Today" :
    dayOffset === -1 ? "Yesterday" :
    format(refDate, "EEE, d MMM yyyy");
  const subLabel = lusakaDateLabel(refDate);

  return (
    <>
      {viewingSale && (
        <ReceiptModal
          open={!!viewingSale}
          onClose={() => setViewingSale(null)}
          businessName={businessName}
          businessDetails={businessDetails}
          items={(viewingSale.items || []).map((i) => ({
            name: i.name,
            price: Number(i.price) || 0,
            quantity: Number(i.quantity) || 0,
          }))}
          subtotal={viewingSale.subtotal}
          total={viewingSale.total}
          paymentMethod={viewingSale.paymentMethod}
          date={viewingSale.createdAt}
          receiptId={viewingSale.id}
          discountAmount={viewingSale.discountAmount}
          taxAmount={viewingSale.taxAmount}
          isService={isService}
          customerName={viewingSale.customerName}
          customerTpin={viewingSale.customerTpin}
        />
      )}

      <div className="space-y-4">
        {/* Day stepper */}
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="icon" onClick={() => setDayOffset((o) => o - 1)} aria-label="Previous day">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-center">
            <p className="font-medium flex items-center justify-center gap-1.5">
              <CalendarDays className="h-4 w-4" /> {dayLabel}
            </p>
            <p className="text-xs text-muted-foreground font-mono">{subLabel}</p>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setDayOffset((o) => Math.min(0, o + 1))}
            disabled={dayOffset >= 0}
            aria-label="Next day"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Summary */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">My Sales · {dayLabel}</CardTitle>
            <CardDescription>
              {summary.count} {summary.count === 1 ? "sale" : "sales"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-center py-1">
              <p className="text-xs text-muted-foreground">Total taken</p>
              <p className="text-3xl font-display font-bold text-primary">{formatZMW(summary.gross)}</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Banknote className="h-3.5 w-3.5" /> Cash</p>
                <p className="font-bold">{formatZMW(summary.methods.cash)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Smartphone className="h-3.5 w-3.5" /> Mobile</p>
                <p className="font-bold">{formatZMW(summary.methods.mobile_money)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1"><CreditCard className="h-3.5 w-3.5" /> Card</p>
                <p className="font-bold">{formatZMW(summary.methods.card)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Wallet className="h-3.5 w-3.5" /> Credit</p>
                <p className="font-bold">{formatZMW(summary.methods.credit)}</p>
              </div>
            </div>
            {summary.discounts > 0 && (
              <p className="text-xs text-green-600">Discounts given: {formatZMW(summary.discounts)}</p>
            )}
            {summary.refundCount > 0 && (
              <p className="text-xs text-destructive">
                Refunds (not counted): {summary.refundCount} · {formatZMW(summary.refundTotal)}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Transactions */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="h-4 w-4" /> Transactions
            </CardTitle>
            <CardDescription>Tap a sale to view its receipt</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {loading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
            ) : sales.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No sales on this day.</p>
            ) : (
              sales.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setViewingSale(s)}
                  className="w-full text-left bg-secondary rounded-lg p-3 hover:bg-secondary/70 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-muted-foreground">{lusakaTime(s.createdAt)}</span>
                      <span className="font-mono text-xs text-muted-foreground">{invoiceLabel(s.id)}</span>
                      {!s.synced && (
                        <Badge variant="secondary" className="text-[10px] bg-amber-500/20 text-amber-700">Pending</Badge>
                      )}
                      {s.status === "refunded" && (
                        <Badge variant="destructive" className="text-[10px]">Refunded</Badge>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-medium">{formatZMW(s.total)}</p>
                      <p className="text-xs text-muted-foreground">{paymentLabel(s.paymentMethod)}</p>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {(Array.isArray(s.items) ? s.items : []).map((item, idx) => (
                      <div key={idx} className="flex justify-between gap-3">
                        <span className="truncate">{item.quantity}× {item.name}</span>
                        <span className="shrink-0">{formatZMW((Number(item.price) || 0) * (Number(item.quantity) || 0))}</span>
                      </div>
                    ))}
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
};

export default CashierMySales;

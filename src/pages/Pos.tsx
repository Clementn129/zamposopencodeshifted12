import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, LogOut, Minus, Plus, Search, ShoppingCart, Trash2, Percent, DollarSign, Users, Briefcase, FileText, LayoutGrid, Truck, ReceiptText, Boxes, ChefHat, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import ConnectionStatus from "@/components/ConnectionStatus";
import SyncStatusBanner from "@/components/SyncStatusBanner";
import ReceiptModal from "@/components/ReceiptModal";
import LockScreen from "@/components/LockScreen";
import QuotationTab from "@/components/QuotationTab";
import DeliveryNoteTab from "@/components/DeliveryNoteTab";
import InvoiceTab from "@/components/InvoiceTab";
import { InvoicePrefill } from "@/components/InvoiceForm";
import MenuModifierPicker, { ModifierPick } from "@/components/MenuModifierPicker";
import QuickAddProduct from "@/components/QuickAddProduct";
import { useAuthContext } from "@/contexts/AuthContext";
import { useBusiness } from "@/hooks/useBusiness";
import { useBackdatePermission } from "@/hooks/useBackdatePermission";
import { BranchSwitcher } from "@/components/BranchSwitcher";
import { useProducts, Product } from "@/hooks/useProducts";
import { useSyncStatus } from "@/contexts/SyncStatusContext";
import { useBusinessType } from "@/hooks/useBusinessType";
import { useMenuModifiers } from "@/hooks/useMenuModifiers";
import { useDiningTables, DiningTable } from "@/hooks/useDiningTables";
import { saveOfflineSale, markSaleAsSynced, updateCachedProductStock, generateOfflineId, clearCart, getCart, saveCartItem, removeCartItem, queuePendingOp, getCachedDebtors, cacheDebtors, getCachedImageBlob, computeLineId } from "@/lib/offlineStorage";
import { calculateTax, TaxCategory } from "@/lib/tax";
import { openCashDrawerIfEnabled } from "@/lib/cashDrawer";
import { supabase } from "@/integrations/supabase/client";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";

type CartLine = { 
  lineId: string; 
  businessId?: string;
  productId: string; 
  name: string; 
  price: number; 
  quantity: number;
  costPrice?: number | null;
  discountType?: 'percentage' | 'amount' | null;
  discountValue?: number;
  notes?: string;
  taxCategory?: TaxCategory;
  /** Catalogue price when the line was added; differs from `price` only when overridden. */
  catalogPrice?: number;
  modifiers?: Array<{ id: string; groupId: string; name: string; priceAdjustment: number }>;
};

interface ReceiptData {
  items: Array<{ name: string; price: number; quantity: number; discountType?: string | null; discountValue?: number; notes?: string; modifiers?: Array<{ name: string; priceAdjustment: number }> }>;
  subtotal: number;
  total: number;
  discountAmount: number;
  paymentMethod: string;
  date: string;
  receiptId: string;
  taxAmount?: number;
  taxLabel?: string;
  customerName?: string | null;
  customerTpin?: string | null;
}

const Pos = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isLoading: authLoading, role, signOut } = useAuthContext();
  const { business, isLoading: bizLoading, refetch: refetchBusiness, checkSubscriptionStatus } = useBusiness(user?.id);
  const { canBackdate } = useBackdatePermission();
  const { isLocked } = checkSubscriptionStatus();

  const [cashierName, setCashierName] = useState<string | null>(null);

  useEffect(() => {
    if (!business?.id || role !== 'cashier' || !user) return;
    supabase
      .from('business_cashiers')
      .select('display_name, username')
      .eq('auth_user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setCashierName(data.display_name || data.username);
      })
      .catch(() => {});
  }, [business?.id, role, user]);

  const { activeProducts, isLoading: productsLoading, isOnline, refetch: refetchProducts } = useProducts(business?.id);
  // Sync state/actions are owned by AppSyncManager; consuming them here keeps
  // a single instance of the sync hooks (duplicates doubled timers/RPCs).
  const { isSyncing, pendingCount, lastSyncError, syncNow, failedOps, retryFailedOps, clearFailedOps, syncOpsNow, isPulling, pullNow } = useSyncStatus();
  const { labels, isService, isRestaurant } = useBusinessType(business?.id, business?.businessType);
  const { groups: modifierGroups, modifiersByGroup, groupIdsByProduct, isLoading: modifiersLoading } = useMenuModifiers(business?.id, isRestaurant);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "mobile_money">("cash");
  const [isProcessing, setIsProcessing] = useState(false);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState("sale");
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [dnQuotation, setDnQuotation] = useState<{
    id: string;
    customerName: string | null;
    customerPhone: string | null;
    items: Array<{ productId: string; productName: string; quantity: number; unitPrice: number; lineTotal: number }>;
  } | null>(null);
  const [invPrefill, setInvPrefill] = useState<InvoicePrefill | null>(null);

  // Discount state
  const [saleDiscountType, setSaleDiscountType] = useState<'percentage' | 'amount' | null>(null);
  const [saleDiscountValue, setSaleDiscountValue] = useState("");

  // Amount received / change calculation
  const [amountReceived, setAmountReceived] = useState("");

  const [visibleCount, setVisibleCount] = useState(50);
  const visibleCountRef = useRef("");

  // Payment mode: full = paid in full; partial = part paid now, rest owed; credit = nothing paid, all owed.
  const [paymentMode, setPaymentMode] = useState<"full" | "partial" | "credit">("full");
  const [partialAmount, setPartialAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [saleDate, setSaleDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerTpin, setCustomerTpin] = useState("");
  const [creditNotes, setCreditNotes] = useState("");
  const isCredit = paymentMode !== "full";

  // Modifier picker for restaurant menu items
  const [modifierProduct, setModifierProduct] = useState<{ id: string; name: string; basePrice: number } | null>(null);

  // Dine-in table picker (restaurant)
  const { tables: diningTables, isLoading: tablesLoading } = useDiningTables(business?.id, isRestaurant);
  const [selectedTable, setSelectedTable] = useState<DiningTable | null>(null);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);

  // Filter products based on search query
  const filteredProducts = useMemo(() => {
    if (!searchQuery.trim()) return activeProducts;
    const query = searchQuery.toLowerCase();
    return activeProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query) ||
        (p.category && p.category.toLowerCase().includes(query)) ||
        (p.barcode && p.barcode.toLowerCase().includes(query))
    );
  }, [activeProducts, searchQuery]);

  // Group products by category
  const groupedProducts = useMemo(() => {
    const groups: Record<string, typeof filteredProducts> = {};
    filteredProducts.forEach((p) => {
      const cat = p.category || "Uncategorized";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(p);
    });
    return groups;
  }, [filteredProducts]);

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (!business?.id) return;
    getCart(business.id)
      .then((items) => setCart(items.map((i) => ({ ...i, lineId: i.lineId ?? computeLineId(i.productId, i.modifiers) }))))
      .catch(() => {});
  }, [business?.id]);

  useEffect(() => {
    const prev = visibleCountRef.current;
    // Only reset visible count when the search query actually changes
    // (different trimmed value), not on every keystroke
    if (prev !== searchQuery.trim()) {
      setVisibleCount(50);
    }
    visibleCountRef.current = searchQuery.trim();
  }, [searchQuery]);

  const subtotal = useMemo(() => cart.reduce((s, l) => {
    const lineTotal = l.price * l.quantity;
    if (l.discountType === 'percentage' && l.discountValue) {
      const pct = Math.min(100, Math.max(0, l.discountValue));
      return s + lineTotal * (1 - pct / 100);
    } else if (l.discountType === 'amount' && l.discountValue) {
      return s + Math.max(0, lineTotal - l.discountValue);
    }
    return s + lineTotal;
  }, 0), [cart]);

  const discountAmount = useMemo(() => {
    if (!saleDiscountType || !saleDiscountValue) return 0;
    const value = Number(saleDiscountValue) || 0;
    if (saleDiscountType === 'percentage') {
      const pct = Math.min(100, Math.max(0, value));
      return subtotal * (pct / 100);
    }
    return Math.max(0, Math.min(value, subtotal));
  }, [subtotal, saleDiscountType, saleDiscountValue]);

  const total = subtotal - discountAmount;

  const changeDue = useMemo(() => {
    const received = Number(amountReceived) || 0;
    if (received <= 0) return null;
    return received - total;
  }, [amountReceived, total]);

// Core add-to-cart. Split out from addToCart so Quick Sale can hand over a
// product it has just created, which may not be in `activeProducts` yet.
const addProductToCart = async (p: Product, opts?: { modifiers?: CartLine['modifiers']; unitPrice?: number }) => {
    const displayName = p.variantLabel ? `${p.name} · ${p.variantLabel}` : p.name;
    const lineId = computeLineId(p.id, opts?.modifiers);
    const existing = cart.find((l) => l.lineId === lineId);
    const nextQty = (existing?.quantity ?? 0) + 1;
    // Fail closed: only an explicit `false` lets stock go below zero, and
    // trackStock === false means a quick-added item that is not counted yet.
    const blockOnStock = business?.preventNegativeStock !== false;
    if (blockOnStock && p.itemType !== 'service' && p.trackStock !== false && nextQty > (p.stock ?? 0)) {
      toast({ variant: "destructive", title: "Not enough stock", description: `${displayName} has only ${p.stock ?? 0} left.` });
      return;
    }
    const unitPrice = opts?.unitPrice ?? p.price ?? 0;
    const catalogPrice = p.price ?? 0;
    // Same lineId = same product + modifier combo, so an existing line always
    // keeps its price (including any override) when the quantity goes up.
    const next = existing
      ? cart.map((l) => (l.lineId === lineId ? { ...l, quantity: nextQty } : l))
      : [...cart, { lineId, businessId: business?.id, productId: p.id, name: displayName, price: unitPrice, quantity: 1, costPrice: p.costPrice, taxCategory: p.taxCategory, modifiers: opts?.modifiers ?? [], catalogPrice }];
    setCart(next);
    await saveCartItem({
      lineId,
      businessId: business?.id,
      productId: p.id,
      name: displayName,
      price: existing ? existing.price : unitPrice,
      quantity: nextQty,
      costPrice: p.costPrice,
      discountType: existing?.discountType || null,
      discountValue: existing?.discountValue || 0,
      notes: existing?.notes || "",
      taxCategory: p.taxCategory,
      modifiers: opts?.modifiers ?? [],
      catalogPrice: existing?.catalogPrice ?? catalogPrice,
    });
  };

const addToCart = async (productId: string, opts?: { modifiers?: CartLine['modifiers']; unitPrice?: number }) => {
    const p = activeProducts.find((x) => x.id === productId);
    if (!p) return;

    // Restaurant items with modifier groups open the picker first.
    const prodGroups = groupIdsByProduct[productId] ?? [];
    const hasModifierOptions = prodGroups.some((gid) => (modifiersByGroup[gid] ?? []).length > 0);
    if (isRestaurant && hasModifierOptions && !opts?.modifiers) {
      setModifierProduct({
        id: p.id,
        name: p.variantLabel ? `${p.name} · ${p.variantLabel}` : p.name,
        basePrice: p.price ?? 0,
      });
      return;
    }

    await addProductToCart(p, opts);
  };

  // Quick Sale: take the resolved product (existing match or freshly created)
  // straight into the cart, then refresh the list in the background.
  const handleQuickResolved = async (p: Product) => {
    await addProductToCart(p);
    void refetchProducts();
  };

  // A scan that missed the local list is usually one of three things, not a
  // real "not found": the product is deactivated, its barcode sits on a parent
  // with variants, or the local cache is stale (pending ops can skip a refetch
  // — see useProducts). Query the server by barcode before crying wolf, and
  // never toast the same code twice in a row (scanners double-deliver).
  const lastScanMissRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const lastDuplicateScanRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

  const rowToCartProduct = (r: {
    id: string;
    name: string;
    price: number | null;
    cost_price: number | null;
    stock: number | null;
    track_stock: boolean;
    tax_category: string | null;
    is_active: boolean;
    parent_id: string | null;
    variant_label: string | null;
    item_type: string | null;
  }): Product => ({
    id: r.id,
    businessId: business?.id ?? "",
    name: r.name,
    price: Number(r.price ?? 0),
    costPrice: r.cost_price != null ? Number(r.cost_price) : null,
    stock: Number(r.stock ?? 0),
    minimumStock: 0,
    category: null,
    barcode: null,
    isActive: r.is_active,
    itemType: r.item_type === "service" ? "service" : "product",
    trackStock: r.track_stock !== false,
    taxCategory: (r.tax_category as Product["taxCategory"]) ?? "taxable",
    imageUrl: null,
    imagePath: null,
    parentId: r.parent_id,
    variantLabel: r.variant_label,
  });

  const resolveScanMiss = async (trimmed: string) => {
    const now = Date.now();
    const lower = trimmed.toLowerCase();
    if (lastScanMissRef.current.code === lower && now - lastScanMissRef.current.at < 2000) return;
    lastScanMissRef.current = { code: lower, at: now };

    // The scan box is cleared by the scanner hook on every scan, so we never
    // re-populate it here — the toast (and the cart) are the feedback. Leaving
    // the code in the field made a second scan append to it.

    const toastNotFound = () =>
      toast({
        variant: "destructive",
        title: "Barcode not found",
        description: isOnline
          ? trimmed
          : `${trimmed} — offline, so this may be a product added after the last sync.`,
      });

    if (!isOnline || !business?.id) {
      toastNotFound();
      return;
    }

    try {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, price, cost_price, stock, track_stock, tax_category, is_active, parent_id, variant_label, item_type")
        .eq("business_id", business.id)
        .or(`barcode.ilike.${escapeLike(trimmed)}`)
        .limit(5);
      if (error) throw error;
      const rows = data ?? [];
      if (rows.length === 0) {
        toastNotFound();
        return;
      }

      const active = rows.filter((r) => r.is_active);
      const best = active.find((r) => !r.parent_id) ?? active[0];

      if (!best || !best.is_active) {
        toast({
          title: `"${best?.name ?? trimmed}" is deactivated`,
          description: "Re-enable it in Products to sell it again.",
        });
        return;
      }

      // A barcode on a parent row hides behind its variants in the POS grid.
      if (!best.parent_id) {
        const { data: variants } = await supabase
          .from("products")
          .select("id, is_active")
          .eq("parent_id", best.id);
        const sellableVariants = (variants ?? []).filter((v) => v.is_active);
        if (sellableVariants.length === 1) {
          const { data: singleVariant } = await supabase
            .from("products")
            .select("id, name, price, cost_price, stock, track_stock, tax_category, is_active, parent_id, variant_label, item_type")
            .eq("id", sellableVariants[0].id)
            .maybeSingle();
          if (singleVariant) {
            await addProductToCart(rowToCartProduct(singleVariant));
            void refetchProducts();
            setSearchQuery("");
            searchInputRef.current?.focus({ preventScroll: true });
            return;
          }
        }
        if (sellableVariants.length > 1) {
          toast({
            title: `"${best.name}" has variants`,
            description: `Scan a variant's own barcode — ${sellableVariants.length} variants are available.`,
          });
          return;
        }
      }

      // Active row that simply isn't in the local list yet (stale cache).
      await addProductToCart(rowToCartProduct(best));
      void refetchProducts();
      setSearchQuery("");
      searchInputRef.current?.focus({ preventScroll: true });
    } catch {
      toastNotFound();
    }
  };

  // Barcode scanner support — works with any USB/Bluetooth keyboard-wedge
  // scanner. Looks up by exact barcode first, then product id, then name.
  useBarcodeScanner((code) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();

    // Several products can share one barcode (e.g. a stale/inactive row left on
    // the same code). Prefer an in-stock match so the scan is predictable, and
    // warn once so the shop can fix the duplicate data.
    const byBarcode = activeProducts.filter((p) => p.barcode && p.barcode.toLowerCase() === lower);
    const match =
      byBarcode.find((p) => p.trackStock === false || (p.stock ?? 0) > 0) ||
      byBarcode[0] ||
      activeProducts.find((p) => p.id.toLowerCase() === lower) ||
      activeProducts.find((p) => p.name.toLowerCase() === lower);

    if (match) {
      if (byBarcode.length > 1) {
        const now = Date.now();
        if (lastDuplicateScanRef.current.code !== lower || now - lastDuplicateScanRef.current.at > 5000) {
          lastDuplicateScanRef.current = { code: lower, at: now };
          toast({
            title: "Barcode is not unique",
            description: `${byBarcode.length} products share ${trimmed} — add a distinct barcode in Products.`,
          });
        }
      }
      addToCart(match.id);
      setSearchQuery("");
      searchInputRef.current?.focus({ preventScroll: true });
    } else {
      void resolveScanMiss(trimmed);
    }
  }, { enabled: activeTab === "sale" });

  // Keep focus on the scan box. Keyboard-wedge scanners only deliver
  // keystrokes when an input has focus (Android routes them through the IME),
  // and the POS has ten other fields that steal it — the moment focus lands
  // in Amount received or Customer name, scanning used to go completely dead.
  // Focus is never taken back from something being typed in or from a dialog.
  useEffect(() => {
    if (activeTab !== "sale") return;
    const ensureFocus = () => {
      if (document.visibilityState === "hidden") return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      const isEditable = tag === "INPUT" || tag === "TEXTAREA" || !!ae?.isContentEditable;
      if (isEditable) return;
      if (ae && ae.closest('[role="dialog"],[role="alertdialog"]')) return;
      searchInputRef.current?.focus({ preventScroll: true });
    };
    const timer = window.setInterval(ensureFocus, 2000);
    window.addEventListener("focus", ensureFocus);
    document.addEventListener("visibilitychange", ensureFocus);
    ensureFocus();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", ensureFocus);
      document.removeEventListener("visibilitychange", ensureFocus);
    };
  }, [activeTab, productsLoading]);


  const decQty = async (lineId: string) => {
    const existing = cart.find((l) => l.lineId === lineId);
    if (!existing) return;
    if (existing.quantity <= 1) {
      setCart(prev => prev.filter((l) => l.lineId !== lineId));
      await removeCartItem(lineId);
      return;
    }
    const nextQty = existing.quantity - 1;
    const updated = { ...existing, quantity: nextQty };
    setCart(prev => prev.map((l) => (l.lineId === lineId ? updated : l)));
    await saveCartItem(updated);
  };

  // Lets the cashier type a quantity instead of tapping "+" repeatedly, which is
  // unworkable for bulk lines (a merchant selling 500-unit lots would need 500
  // taps). Whole numbers only — quantity is `integer` in products.stock and in
  // every *items.quantity column, so a fractional value would silently truncate
  // against stock and permanently drift inventory counts.
  const updateItemQty = async (lineId: string, raw: string) => {
    const existing = cart.find((l) => l.lineId === lineId);
    if (!existing) return;
    const trimmed = raw.trim();
    // Blank/invalid input never lands in the cart — the last valid quantity stands,
    // so a half-typed value can't zero out or corrupt the line.
    if (trimmed === '') return;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value <= 0) return;
    // Snap to a whole unit. Guards against "2.5" reaching a column that can't hold it.
    const whole = Math.floor(value);
    if (whole === existing.quantity) return;
    const updated = { ...existing, quantity: whole };
    setCart(prev => prev.map((l) => (l.lineId === lineId ? updated : l)));
    await saveCartItem(updated);
  };

  const updateItemDiscount = async (lineId: string, type: 'percentage' | 'amount' | null, value: number) => {
    const existing = cart.find((l) => l.lineId === lineId);
    if (!existing) return;
    const updated = { ...existing, discountType: type, discountValue: value };
    setCart(prev => prev.map((l) => (l.lineId === lineId ? updated : l)));
    await saveCartItem(updated);
  };

  const updateItemNotes = async (lineId: string, notes: string) => {
    const existing = cart.find((l) => l.lineId === lineId);
    if (!existing) return;
    const updated = { ...existing, notes };
    setCart(prev => prev.map((l) => (l.lineId === lineId ? updated : l)));
    await saveCartItem(updated);
  };

  // Overrides the selling price for one line. The product's catalogue price is
  // never written — only this line's `price` changes, and `catalogPrice` keeps
  // the original so reports can quantify the difference.
  const updateItemPrice = async (lineId: string, raw: string) => {
    const existing = cart.find((l) => l.lineId === lineId);
    if (!existing) return;
    const trimmed = raw.trim();
    // Blank/invalid input never lands in the cart — the last valid price stands.
    if (trimmed === '') return;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) return;
    if (value === existing.price) return;
    const updated = { ...existing, price: value };
    setCart(prev => prev.map((l) => (l.lineId === lineId ? updated : l)));
    await saveCartItem(updated);
  };

  const clear = async () => { 
    setCart([]); 
    await clearCart(business?.id); 
    setSaleDiscountType(null);
    setSaleDiscountValue("");
    setPaymentMode("full");
    setPartialAmount("");
    setDueDate("");
    setSaleDate(new Date().toISOString().slice(0, 10));
    setCustomerName("");
    setCustomerPhone("");
    setCustomerTpin("");
    setCreditNotes("");
    setAmountReceived("");
    setSelectedTable(null);
    setTablePickerOpen(false);
  };

  // Tax breakdown — recomputed on every cart/discount change
  const taxBreakdown = useMemo(() => {
    if (!business) return null;
    // Build per-line effective amounts AFTER per-line discount AND proportional global discount
    const linesAfterItemDisc = cart.map((l) => {
      const gross = l.price * l.quantity;
      let net = gross;
      if (l.discountType === 'percentage' && l.discountValue) net = gross * (1 - l.discountValue / 100);
      else if (l.discountType === 'amount' && l.discountValue) net = Math.max(0, gross - l.discountValue);
      return { amount: net, taxCategory: (l.taxCategory || 'taxable') as TaxCategory };
    });
    const sub = linesAfterItemDisc.reduce((s, l) => s + l.amount, 0);
    const taxLines = linesAfterItemDisc.map(l => ({
      lineAmount: sub > 0 ? l.amount - (l.amount / sub) * discountAmount : l.amount,
      taxCategory: l.taxCategory,
    }));
    return calculateTax(
      {
        taxMode: business.taxMode,
        vatRate: business.vatRate,
        customTaxName: business.customTaxName,
        customTaxRate: business.customTaxRate,
      },
      taxLines
    );
  }, [cart, discountAmount, business]);

  const completeSale = async () => {
    if (!business || cart.length === 0) return;

    if (isCredit && !customerName.trim()) {
      toast({ variant: "destructive", title: "Customer name required", description: "Enter customer name for credit / partial sales." });
      return;
    }

    // Validate customer TPIN if provided
    const trimmedCustomerTpin = customerTpin.trim();
    if (trimmedCustomerTpin && !/^\d{10}$/.test(trimmedCustomerTpin)) {
      toast({ variant: "destructive", title: "Invalid TPIN", description: "Customer TPIN must be 10 digits." });
      return;
    }

    // Derive amount_paid from payment mode
    let amountPaidNow = total; // full
    if (paymentMode === "credit") {
      amountPaidNow = 0;
    } else if (paymentMode === "partial") {
      const p = Number(partialAmount) || 0;
      if (p <= 0) {
        toast({ variant: "destructive", title: "Enter partial amount", description: "Partial payment must be greater than 0." });
        return;
      }
      if (p >= total) {
        toast({ variant: "destructive", title: "Use 'Paid in Full'", description: "Partial amount must be less than the total." });
        return;
      }
      amountPaidNow = p;
    } else if (paymentMethod === "cash" && amountReceived.trim() !== "") {
      // Cashier used the change calculator: never record a full-cash sale as
      // paid in full when the tendered amount is short.
      const received = Number(amountReceived) || 0;
      if (received < total) {
        toast({
          variant: "destructive",
          title: "Not enough cash",
          description: `Received ZMW ${received.toFixed(2)} but the total is ZMW ${total.toFixed(2)}.`,
        });
        return;
      }
    }

    setIsProcessing(true);

    const saleId = generateOfflineId();
    // Back-dating (opt-in): a past date is combined with the current time so the
    // sale sorts correctly within that day. Today or future falls back to now().
    const todayIso = new Date().toISOString().slice(0, 10);
    const createdAt = (canBackdate && saleDate && saleDate < todayIso)
      ? new Date(`${saleDate}T${new Date().toTimeString().slice(0, 8)}`).toISOString()
      : new Date().toISOString();
    const tax = taxBreakdown;

    const salePayload = {
      id: saleId, businessId: business.id,
      items: cart.map((l) => {
        const p = activeProducts.find((x) => x.id === l.productId);
        // Unit price actually charged, after the line discount.
        // Mirrors the arithmetic in the `subtotal` memo above.
        const lineTotal = l.price * l.quantity;
        let discountedLine = lineTotal;
        if (l.discountType === 'percentage' && l.discountValue) {
          const pct = Math.min(100, Math.max(0, l.discountValue));
          discountedLine = lineTotal * (1 - pct / 100);
        } else if (l.discountType === 'amount' && l.discountValue) {
          discountedLine = Math.max(0, lineTotal - l.discountValue);
        }
        const finalSalePrice = l.quantity > 0 ? discountedLine / l.quantity : l.price;
        return { 
          productId: l.productId, 
          name: l.name, 
          price: l.price, 
          catalogPrice: l.catalogPrice ?? p?.price ?? l.price,
          finalSalePrice,
          quantity: l.quantity,
          costPrice: p?.costPrice || l.costPrice || null,
          discountType: l.discountType || null,
          discountValue: l.discountValue || 0,
          notes: l.notes || null,
          taxCategory: l.taxCategory || p?.taxCategory || 'taxable',
          modifiers: l.modifiers && l.modifiers.length > 0 ? l.modifiers : null,
        };
      }),
      subtotal, total, discountAmount,
      discountType: saleDiscountType,
      paymentMethod, createdAt, synced: false,
      taxAmount: tax?.taxAmount || 0,
      taxableAmount: tax?.taxableAmount || 0,
      zeroRatedAmount: tax?.zeroRatedAmount || 0,
      exemptAmount: tax?.exemptAmount || 0,
      customerName: (customerName.trim() || null),
      customerTpin: (trimmedCustomerTpin || null),
      customerPhone: (customerPhone.trim() || null),
      amountPaid: amountPaidNow,
      dueDate: dueDate || null,
      tableId: selectedTable?.id ?? null,
    };

    try {
      // OFFLINE-FIRST: persist every sale to the local DB BEFORE touching the
      // network, so a failed write can never lose a sale. The server RPC is
      // idempotent on (business_id, offline_id), so retries never duplicate.
      await saveOfflineSale(salePayload);
      for (const line of cart) {
        const p = activeProducts.find((x) => x.id === line.productId);
        // Quick-added items are not counted until someone enters a real stock.
        if (p?.trackStock === false) continue;
        const nextStock = Number(p?.stock ?? 0) - line.quantity;
        await updateCachedProductStock(
          line.productId,
          business?.preventNegativeStock === false ? nextStock : Math.max(0, nextStock),
        );
      }

      let returnedSaleId: string | null = null;
      let pushFailed = false;
      let syncNote = "";

      if (isOnline) {
        try {
          const { data: rid, error: saleErr } = await (supabase.rpc as any)("sync_offline_sale", {
            p_business_id: business.id,
            p_offline_id: saleId,
            p_items: salePayload.items,
            p_subtotal: subtotal,
            p_total: total,
            p_discount_amount: discountAmount,
            p_discount_type: saleDiscountType,
            p_payment_method: paymentMethod,
            p_created_at: createdAt,
            p_tax_amount: salePayload.taxAmount,
            p_taxable_amount: salePayload.taxableAmount,
            p_zero_rated_amount: salePayload.zeroRatedAmount,
            p_exempt_amount: salePayload.exemptAmount,
            p_customer_name: salePayload.customerName,
            p_customer_tpin: salePayload.customerTpin,
            p_amount_paid: amountPaidNow,
            p_due_date: dueDate || null,
            p_customer_phone: salePayload.customerPhone,
            p_table_id: selectedTable?.id ?? null,
          });
          if (saleErr) throw saleErr;
          returnedSaleId = (rid as string | null) ?? null;
          await markSaleAsSynced(saleId);
        } catch (e) {
          console.warn("Immediate sale sync failed — will retry in background:", e);
          pushFailed = true;
          syncNote = "Sale saved on this device — will sync when the connection is stable.";
        }
      }

      if (isCredit) {
        const canInsertNow = isOnline && !!returnedSaleId && !pushFailed;
        let debtorHandled = false;
        if (canInsertNow) {
          const { error: debtorErr } = await supabase.from("debtors").insert({
            business_id: business.id,
            sale_id: returnedSaleId,
            customer_name: customerName.trim(),
            customer_phone: customerPhone.trim() || null,
            amount_owed: total,
            amount_paid: amountPaidNow,
            status: amountPaidNow > 0 ? "partially_paid" : "unpaid",
            notes: creditNotes.trim() || null,
            due_date: dueDate || null,
          });
          if (debtorErr) {
            // Never silently drop a credit sale's debtor — fall back to the
            // offline queue so it retries (idempotent on the sale's offlineId).
            console.error("Failed to create debtor — queueing for retry:", debtorErr);
          } else {
            debtorHandled = true;
          }
        }
        if (!debtorHandled) {
          // Queue the debtor (and linked sale) so it is created exactly once when online.
          await queuePendingOp({
            id: generateOfflineId(),
            businessId: business.id,
            type: 'debtor_create',
            payload: {
              offlineId: saleId,
              items: salePayload.items,
              total,
              subtotal,
              discountAmount,
              discountType: saleDiscountType,
              paymentMethod,
              taxAmount: tax?.taxAmount || 0,
              taxableAmount: tax?.taxableAmount || 0,
              zeroRatedAmount: tax?.zeroRatedAmount || 0,
              exemptAmount: tax?.exemptAmount || 0,
              customerName: customerName.trim(),
              customerPhone: customerPhone.trim() || null,
              notes: creditNotes.trim() || null,
              dueDate: dueDate || null,
              createdAt,
              amountPaid: amountPaidNow,
              tableId: salePayload.tableId,
            },
            createdAt,
          });
          const existingDebtors = await getCachedDebtors(business.id);
          await cacheDebtors([...existingDebtors, {
            id: saleId,
            businessId: business.id,
            customerName: customerName.trim(),
            customerPhone: customerPhone.trim() || null,
            amountOwed: total,
            amountPaid: amountPaidNow,
            status: amountPaidNow > 0 ? 'partially_paid' : 'unpaid',
            notes: creditNotes.trim() || null,
            createdAt,
            dueDate: dueDate || null,
          }]);
        }
      }

      if (isOnline) {
        toast({
          title: paymentMode === "credit" ? "Credit sale recorded" : paymentMode === "partial" ? "Partial sale recorded" : "Sale completed",
          description: pushFailed
            ? syncNote
            : paymentMode === "full"
              ? "Stock updated."
              : `Balance owed: ZMW ${(total - amountPaidNow).toFixed(2)}`,
        });
      } else if (isCredit) {
        toast({ title: "Credit sale saved offline", description: "Will sync when online." });
      } else {
        toast({ title: "Saved offline", description: "Sale will sync when online." });
      }

      if (isOnline) {
        await syncNow();
      }

      setReceiptData({
        items: cart.map((l) => ({ 
          name: l.name, 
          price: l.price, 
          quantity: l.quantity,
          discountType: l.discountType,
          discountValue: l.discountValue,
          notes: l.notes,
          modifiers: l.modifiers && l.modifiers.length > 0 ? l.modifiers.map((m) => ({ name: m.name, priceAdjustment: m.priceAdjustment })) : undefined,
        })),
        subtotal, total, discountAmount, paymentMethod, date: createdAt, receiptId: saleId,
        taxAmount: salePayload.taxAmount,
        taxLabel: tax?.label,
        customerName: salePayload.customerName,
        customerTpin: salePayload.customerTpin,
      } as any);

      // Cash handed over -> kick the drawer (desktop app only; no-op elsewhere).
      if (paymentMethod === "cash" && amountPaidNow > 0) {
        openCashDrawerIfEnabled();
      }

      await clear();
      await refetchProducts();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not complete sale" });
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle converting a quotation to a sale — loads items into the cart
  const handleConvertQuotation = async (
    items: Array<{ productId: string; name: string; price: number; quantity: number; discountType?: string | null; discountValue?: number; notes?: string; costPrice?: number | null; taxCategory?: string }>,
    discType: string | null,
    discValue: number
  ) => {
    const cartLines: CartLine[] = items.map(i => ({
      lineId: computeLineId(i.productId, (i as { modifiers?: Array<{ id: string }> }).modifiers ?? []),
      businessId: business?.id,
      productId: i.productId,
      name: i.name,
      price: i.price,
      quantity: i.quantity,
      discountType: (i.discountType as CartLine['discountType']) || null,
      discountValue: i.discountValue || 0,
      notes: i.notes,
      costPrice: i.costPrice,
      taxCategory: (i.taxCategory as TaxCategory) || 'taxable',
      modifiers: (i as { modifiers?: Array<{ id: string; groupId: string; name: string; priceAdjustment: number }> }).modifiers ?? [],
    }));
    setCart(cartLines);
    // Persist each cart line to IndexedDB so cart survives page refresh
    for (const line of cartLines) {
      await saveCartItem(line);
    }
    if (discType) {
      setSaleDiscountType(discType as 'percentage' | 'amount');
      setSaleDiscountValue(discValue.toString());
    }
    setActiveTab("sale");
  };

  const handleCreateDeliveryNoteFromQuotation = async (quotationId: string) => {
    try {
      // Load the quotation header + items so the delivery note form can prefill.
      const { data: qData, error: qErr } = await supabase
        .from('quotations')
        .select('id, customer_name, customer_phone')
        .eq('id', quotationId)
        .eq('business_id', business.id)
        .single();
      if (qErr || !qData) {
        toast({ variant: "destructive", title: "Error", description: "Quotation not found" });
        return;
      }
      const { data: items, error: iErr } = await supabase
        .from('quotation_items')
        .select('product_id, product_name, quantity, unit_price, line_total')
        .eq('quotation_id', quotationId);
      if (iErr) throw iErr;

      setDnQuotation({
        id: quotationId,
        customerName: qData.customer_name ?? null,
        customerPhone: qData.customer_phone ?? null,
        items: (items ?? []).map((i) => ({
          productId: i.product_id ?? '',
          productName: i.product_name,
          quantity: Number(i.quantity),
          unitPrice: Number(i.unit_price),
          lineTotal: Number(i.line_total),
        })),
      });
      setActiveTab("delivery-notes");
    } catch (e: any) {
      toast({ variant: "destructive", title: "Error", description: e.message });
    }
  };

  const handleCreateInvoiceFromQuotation = async (quotationId: string) => {
    try {
      const { data: qData, error: qErr } = await supabase
        .from('quotations')
        .select('customer_name, customer_phone, customer_email, customer_tpin')
        .eq('id', quotationId)
        .eq('business_id', business.id)
        .single();
      if (qErr || !qData) {
        toast({ variant: "destructive", title: "Error", description: "Quotation not found" });
        return;
      }
      const { data: items, error: iErr } = await supabase
        .from('quotation_items')
        .select('product_id, product_name, quantity, unit_price, discount_type, discount_value, line_total')
        .eq('quotation_id', quotationId);
      if (iErr) throw iErr;

      setInvPrefill({
        quotationId,
        customerName: qData.customer_name ?? '',
        customerPhone: qData.customer_phone ?? '',
        customerEmail: qData.customer_email ?? '',
        customerTpin: qData.customer_tpin ?? '',
        items: (items ?? []).map((i) => ({
          productId: i.product_id ?? '',
          productName: i.product_name,
          unitPrice: Number(i.unit_price),
          quantity: Number(i.quantity),
          discountType: i.discount_type ?? null,
          discountValue: Number(i.discount_value),
          lineTotal: Number(i.line_total),
        })),
      });
      setActiveTab("invoices");
    } catch (e: any) {
      toast({ variant: "destructive", title: "Error", description: e.message });
    }
  };

  const handleCreateInvoiceFromDeliveryNote = async (deliveryNoteId: string) => {
    try {
      const { data: dData, error: dErr } = await supabase
        .from('delivery_notes')
        .select('customer_name, customer_phone')
        .eq('id', deliveryNoteId)
        .eq('business_id', business.id)
        .single();
      if (dErr || !dData) {
        toast({ variant: "destructive", title: "Error", description: "Delivery note not found" });
        return;
      }
      const { data: items, error: iErr } = await supabase
        .from('delivery_note_items')
        .select('product_id, product_name, quantity, unit_price, line_total')
        .eq('delivery_note_id', deliveryNoteId);
      if (iErr) throw iErr;

      setInvPrefill({
        deliveryNoteId,
        customerName: dData.customer_name ?? '',
        customerPhone: dData.customer_phone ?? '',
        customerEmail: '',
        customerTpin: '',
        items: (items ?? []).map((i) => ({
          productId: i.product_id ?? '',
          productName: i.product_name,
          unitPrice: Number(i.unit_price),
          quantity: Number(i.quantity),
          discountType: null,
          discountValue: 0,
          lineTotal: Number(i.line_total),
        })),
      });
      setActiveTab("invoices");
    } catch (e: any) {
      toast({ variant: "destructive", title: "Error", description: e.message });
    }
  };

  // Only block on initial loading. Once business+products are loaded, never
  // unmount on background refetches — that causes any open view (e.g. a
  // quotation detail) to disappear and look like a page reload.
  if (authLoading || bizLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-background"><p className="text-muted-foreground">Loading…</p></div>;
  }
  if (!business) return null;
  if (isLocked) return <><ConnectionStatus /><LockScreen paymentCode={business.paymentCode} businessId={business.id} onRetrySync={refetchBusiness} /></>;

  return (
    <>
      <ConnectionStatus />
      <SyncStatusBanner
        isOnline={isOnline}
        isSyncing={isSyncing}
        isPulling={isPulling}
        pendingCount={pendingCount}
        lastSyncError={lastSyncError}
        failedCount={failedOps.length}
        failedDetail={failedOps[0]?.lastError ?? null}
        onRetryFailed={() => {
          void retryFailedOps(failedOps.map((op) => op.id));
        }}
        onClearFailed={() => {
          void clearFailedOps(failedOps.map((op) => op.id));
        }}
        onSyncNow={() => {
          void syncNow();
          void syncOpsNow();
          void pullNow();
        }}
      />
      <MenuModifierPicker
        open={!!modifierProduct}
        product={modifierProduct}
        groups={modifierGroups}
        modifiersByGroup={modifiersByGroup}
        groupIdsByProduct={groupIdsByProduct}
        onClose={() => setModifierProduct(null)}
        onConfirm={(modifiers: ModifierPick[], unitPrice: number) => {
          if (modifierProduct) {
            void addToCart(modifierProduct.id, { modifiers: modifiers.length > 0 ? modifiers : [], unitPrice });
          }
        }}
      />
      <QuickAddProduct
        open={quickAddOpen}
        onOpenChange={setQuickAddOpen}
        businessId={business.id}
        isOnline={isOnline}
        products={activeProducts}
        onResolved={handleQuickResolved}
      />
      <Dialog open={tablePickerOpen} onOpenChange={setTablePickerOpen}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Select table</DialogTitle>
            <DialogDescription>
              Assign this order to a table, or leave unassigned for takeaway.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <button
              onClick={() => { setSelectedTable(null); setTablePickerOpen(false); }}
              className={`w-full flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm hover:bg-secondary/60 transition ${selectedTable === null ? "border-primary bg-primary/5" : "border-border"}`}
            >
              <span>No table · Takeaway</span>
              {selectedTable === null && <span className="text-xs font-semibold text-primary">Selected</span>}
            </button>
            {tablesLoading ? (
              <p className="text-sm text-muted-foreground px-1">Loading tables…</p>
            ) : diningTables.filter((t) => t.is_active).length === 0 ? (
              <p className="text-sm text-muted-foreground px-1">No tables yet. Add them in Settings → Dining Tables.</p>
            ) : (
              (() => {
                const active = diningTables.filter((t) => t.is_active).sort((a, b) => a.name.localeCompare(b.name));
                const byFloor: Record<string, DiningTable[]> = {};
                for (const t of active) {
                  const key = t.floor?.trim() ?? "";
                  (byFloor[key] ??= []).push(t);
                }
                return Object.keys(byFloor)
                  .sort((a, b) => a.localeCompare(b))
                  .map((floor) => (
                    <div key={floor}>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1 mb-1 mt-3">
                        {floor || "General"}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {byFloor[floor].map((t) => (
                          <button
                            key={t.id}
                            onClick={() => { setSelectedTable(t); setTablePickerOpen(false); }}
                            className={`rounded-lg border px-3 py-2.5 text-left text-sm hover:bg-secondary/60 transition ${selectedTable?.id === t.id ? "border-primary bg-primary/5" : "border-border"}`}
                          >
                            <span className="block font-medium truncate">{t.name}</span>
                            <span className="block text-xs text-muted-foreground">Seats {t.capacity}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ));
              })()
            )}
          </div>
        </DialogContent>
      </Dialog>
      {receiptData && (
        <ReceiptModal
          open={!!receiptData}
          onClose={() => setReceiptData(null)}
          businessName={business.name}
          businessDetails={{
            phone: business.phone,
            email: business.email,
            address: business.address,
            tpin: business.tpin,
          }}
          items={receiptData.items}
          subtotal={receiptData.subtotal}
          total={receiptData.total}
          discountAmount={receiptData.discountAmount}
          paymentMethod={receiptData.paymentMethod}
          date={receiptData.date}
          receiptId={receiptData.receiptId}
          isService={isService}
          taxAmount={receiptData.taxAmount}
          taxLabel={receiptData.taxLabel}
          customerName={receiptData.customerName}
          customerTpin={receiptData.customerTpin}
        />
      )}
      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-4 py-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate(role === 'cashier' ? '/auth' : role === 'kitchen_staff' || role === 'manager' ? '/kitchen' : '/dashboard')} aria-label="Back"><ArrowLeft className="h-5 w-5" /></Button>
              <div>
                <h1 className="font-display font-bold text-lg flex items-center gap-2"><ShoppingCart className="h-5 w-5" /> POS</h1>
                <p className="text-xs text-muted-foreground">
                  {role === 'cashier' && cashierName ? <span className="mr-2">{cashierName}</span> : null}
                  {isOnline ? (isSyncing ? "Syncing…" : "Online") : "Offline"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isRestaurant && (role === 'kitchen_staff' || role === 'manager') && (
                <Button variant="outline" size="sm" onClick={() => navigate('/kitchen')}>
                  <ChefHat className="h-4 w-4 mr-1" /> Kitchen
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate('/stock')}>
                <Boxes className="h-4 w-4 mr-1" /> Stock
              </Button>
              {role === 'cashier' ? (
                <Button variant="destructive" size="sm" onClick={async () => { await signOut(); navigate('/auth'); }}>
                  <LogOut className="h-4 w-4 mr-1" /> Logout
                </Button>
              ) : null}
              <BranchSwitcher />
              <Button variant="outline" size="sm" onClick={refetchProducts}>Refresh</Button>
            </div>
          </div>
        </header>

        <main className="p-4 max-w-4xl mx-auto">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-4 w-full justify-start overflow-x-auto md:justify-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <TabsTrigger value="sale" className="flex items-center gap-1.5 shrink-0">
                <ShoppingCart className="h-4 w-4" /> New Sale
              </TabsTrigger>
              <TabsTrigger value="quotations" className="flex items-center gap-1.5 shrink-0">
                <FileText className="h-4 w-4" /> Quotations
              </TabsTrigger>
              <TabsTrigger value="delivery-notes" className="flex items-center gap-1.5 shrink-0">
                <Truck className="h-4 w-4" /> Delivery Notes
              </TabsTrigger>
              <TabsTrigger value="invoices" className="flex items-center gap-1.5 shrink-0">
                <ReceiptText className="h-4 w-4" /> Invoices
              </TabsTrigger>
            </TabsList>

            <TabsContent value="sale">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:h-[calc(100dvh-11rem)] md:min-h-0">
                <Card className="flex flex-col min-h-0">
                  <CardHeader className="pb-2 shrink-0">
                    <CardTitle className="text-lg flex items-center gap-2">
                      {isService ? <Briefcase className="h-4 w-4" /> : null}
                      {labels.posItemsTitle}
                    </CardTitle>
                    <CardDescription>{labels.posItemsDescription}</CardDescription>
                    <div className="relative mt-2">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        ref={searchInputRef}
                        type="text"
                        placeholder={`Search by name, category, or scan barcode...`}
                        className="pl-9"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        data-scanner-target="true"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 w-full"
                      onClick={() => setQuickAddOpen(true)}
                    >
                      <Plus className="h-4 w-4 mr-2" /> Quick sale — add a new item
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-3 overflow-y-auto max-h-[50vh] sm:max-h-[60vh] md:max-h-none md:flex-1 md:min-h-0">
                    {Object.keys(groupedProducts).length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {searchQuery ? `No ${isService ? 'services' : 'products'} match your search.` : labels.noItemsMessage}
                      </p>
                    ) : (
                      Object.entries(groupedProducts).map(([cat, prods]) => (
                        <div key={cat} className="space-y-1">
                          <div className="bg-muted/50 rounded px-2 py-1 text-xs font-medium text-muted-foreground sticky top-0">
                            {cat} ({prods.length})
                          </div>
                          {prods.slice(0, visibleCount).map((p) => {
                            const displayName = p.variantLabel ? `${p.name} · ${p.variantLabel}` : p.name;
                            return (
                              <button key={p.id} onClick={() => addToCart(p.id)} className="w-full text-left bg-secondary rounded-lg p-3 hover:opacity-90 transition">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="flex items-center gap-3 min-w-0">
                                    {p.imageUrl ? (
                                      <img src={p.imageUrl} alt={displayName} className="h-10 w-10 rounded object-cover shrink-0" loading="lazy" onError={async (e) => { if (!p.imagePath) return; try { const blob = await getCachedImageBlob(p.imagePath); if (blob) (e.target as HTMLImageElement).src = URL.createObjectURL(blob); } catch { /* blob fetch failed, keep broken image */ } }} />
                                    ) : (
                                      <div className="h-10 w-10 rounded bg-muted shrink-0" />
                                    )}
                                    <div className="min-w-0">
                                      <p className="font-medium truncate">{displayName}</p>
                                      <p className="text-xs text-muted-foreground">
                                        ZMW {(p.price ?? 0).toFixed(2)} {labels.showStock && p.itemType !== 'service' ? `• ${labels.stockDisplay(p.stock ?? 0)}` : ''}
                                      </p>
                                    </div>
                                  </div>
                                  <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
                                </div>
                              </button>
                            );
                          })}
                          {prods.length > visibleCount && (
                            <button onClick={() => setVisibleCount(v => v + 50)} className="w-full text-center text-sm text-primary py-2 hover:underline">
                              Show {Math.min(50, prods.length - visibleCount)} more ({prods.length - visibleCount} remaining)
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>

                <Card className="flex flex-col min-h-0">
                  <CardHeader className="shrink-0"><CardTitle className="text-lg">{isService ? 'Invoice' : 'Cart'}</CardTitle><CardDescription>{isService ? 'Complete transaction' : 'Complete sale'}</CardDescription></CardHeader>
                  <CardContent className="space-y-3 md:flex-1 md:min-h-0 md:overflow-y-auto">
                    {cart.length === 0 ? <p className="text-sm text-muted-foreground">{isService ? 'No services added.' : 'Cart empty.'}</p> : cart.map((l) => (
                      <div key={l.lineId} className="bg-secondary rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div><p className="font-medium">{l.name}</p><p className="text-xs text-muted-foreground">{Number(l.quantity).toLocaleString()} {labels.quantityLabel} × ZMW {l.price.toFixed(2)}</p></div>
                          <div className="flex gap-1">
                            <Button variant="outline" size="icon" onClick={() => decQty(l.lineId)}><Minus className="h-4 w-4" /></Button>
                            <Input
                              key={`qty-${l.lineId}`}
                              type="number"
                              inputMode="numeric"
                              min={1}
                              step={1}
                              defaultValue={l.quantity}
                              onChange={(e) => updateItemQty(l.lineId, e.target.value)}
                              onFocus={(e) => e.currentTarget.select()}
                              className="w-16 h-8 text-xs text-center"
                              aria-label={`Quantity for ${l.name}`}
                            />
                            <Button variant="outline" size="icon" onClick={() => addToCart(l.productId, { modifiers: l.modifiers, unitPrice: l.price })}><Plus className="h-4 w-4" /></Button>
                            <Button variant="outline" size="icon" onClick={async () => { setCart(prev => prev.filter((x) => x.lineId !== l.lineId)); await removeCartItem(l.lineId); }}><Trash2 className="h-4 w-4" /></Button>
                          </div>
                        </div>
                        {l.modifiers && l.modifiers.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {l.modifiers.map((m) => (m.priceAdjustment > 0 ? `${m.name} (+K${m.priceAdjustment.toFixed(2)})` : m.priceAdjustment < 0 ? `${m.name} (-K${Math.abs(m.priceAdjustment).toFixed(2)})` : m.name)).join(" · ")}
                          </p>
                        )}
                        {/* Unit price — editable only when the business enables
                            "Allow editing price in cart" in Settings. */}
                        {business?.allowCartPriceEdit ? (
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-xs text-muted-foreground w-20 shrink-0">Unit price</span>
                            <Input
                              key={`price-${l.lineId}`}
                              type="number"
                              min={0}
                              step="0.01"
                              defaultValue={l.price}
                              onChange={(e) => updateItemPrice(l.lineId, e.target.value)}
                              className="w-24 h-8 text-xs"
                              aria-label={`Unit price for ${l.name}`}
                            />
                            {l.catalogPrice != null && Math.abs(l.price - l.catalogPrice) > 0.001 && (
                              <span className="text-xs text-muted-foreground">
                                catalog ZMW {l.catalogPrice.toFixed(2)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-xs text-muted-foreground w-20 shrink-0">Unit price</span>
                            <span className="text-xs tabular-nums">ZMW {l.price.toFixed(2)}</span>
                          </div>
                        )}
                        {/* Item discount */}
                        <div className="flex items-center gap-2 mt-2">
                          <Select 
                            value={l.discountType || "none"} 
                            onValueChange={(v) => updateItemDiscount(l.lineId, v === 'none' ? null : v as 'percentage' | 'amount', l.discountValue || 0)}
                          >
                            <SelectTrigger className="w-24 h-8 text-xs">
                              <SelectValue placeholder="Discount" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              <SelectItem value="percentage">%</SelectItem>
                              <SelectItem value="amount">ZMW</SelectItem>
                            </SelectContent>
                          </Select>
                          {l.discountType && (
                            <Input
                              type="number"
                              placeholder="0"
                              value={l.discountValue || ""}
                              onChange={(e) => updateItemDiscount(l.lineId, l.discountType!, Number(e.target.value) || 0)}
                              className="w-20 h-8 text-xs"
                            />
                          )}
                        </div>
                        {/* Notes field for service businesses */}
                        {isService && (
                          <div className="mt-2">
                            <Input
                              type="text"
                              placeholder="Add notes (e.g., duration, details)"
                              value={l.notes || ""}
                              onChange={(e) => updateItemNotes(l.lineId, e.target.value)}
                              className="h-8 text-xs"
                            />
                          </div>
                        )}
                      </div>
                    ))}

                    {cart.length > 0 && (
                      <>
                        {/* Sale-wide discount */}
                        <div className="border-t pt-3">
                          <Label className="text-sm flex items-center gap-1 mb-2">
                            <Percent className="h-4 w-4" /> Sale Discount
                          </Label>
                          <div className="flex gap-2">
                            <Select value={saleDiscountType || "none"} onValueChange={(v) => setSaleDiscountType(v === 'none' ? null : v as 'percentage' | 'amount')}>
                              <SelectTrigger className="w-24">
                                <SelectValue placeholder="Type" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">None</SelectItem>
                                <SelectItem value="percentage">%</SelectItem>
                                <SelectItem value="amount">ZMW</SelectItem>
                              </SelectContent>
                            </Select>
                            {saleDiscountType && (
                              <Input
                                type="number"
                                placeholder="0"
                                value={saleDiscountValue}
                                onChange={(e) => setSaleDiscountValue(e.target.value)}
                                className="flex-1"
                              />
                            )}
                          </div>
                        </div>

                        {/* Table (restaurant only) */}
                        {isRestaurant && (
                          <div className="border-t pt-3 space-y-2">
                            <Label className="text-sm flex items-center gap-1">
                              <LayoutGrid className="h-4 w-4" /> Table
                            </Label>
                            <Button
                              variant="outline"
                              className="w-full justify-between font-normal"
                              onClick={() => setTablePickerOpen(true)}
                            >
                              <span className="truncate">
                                {selectedTable ? selectedTable.name : tablesLoading ? "Loading tables…" : "No table · Takeaway"}
                              </span>
                              <LayoutGrid className="h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                            {selectedTable && (
                              <p className="text-xs text-muted-foreground">
                                Order will be seated at <strong>{selectedTable.name}</strong>
                                {selectedTable.floor ? ` (${selectedTable.floor})` : ""}.
                              </p>
                            )}
                          </div>
                        )}

                        {/* Customer Info (optional - for tax invoice / TPIN) */}
                        <div className="border-t pt-3 space-y-2">
                          <Label className="text-sm">Customer (optional)</Label>
                          <Input
                            placeholder="Customer name"
                            value={customerName}
                            onChange={(e) => setCustomerName(e.target.value)}
                          />
                          <Input
                            placeholder="Customer TPIN (10 digits)"
                            inputMode="numeric"
                            maxLength={10}
                            value={customerTpin}
                            onChange={(e) => setCustomerTpin(e.target.value.replace(/\D/g, ''))}
                          />
                        </div>

                        {/* Payment mode: full / partial / credit */}
                        <div className="border-t pt-3 space-y-2">
                          <Label className="text-sm flex items-center gap-1">
                            <Users className="h-4 w-4" /> Payment Mode
                          </Label>
                          <Select value={paymentMode} onValueChange={(v) => setPaymentMode(v as any)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="full">Paid in Full</SelectItem>
                              <SelectItem value="partial">Partial Payment</SelectItem>
                              <SelectItem value="credit">Credit (Pay Later)</SelectItem>
                            </SelectContent>
                          </Select>
                          {isCredit && (
                            <div className="mt-2 space-y-2">
                              {!customerName.trim() && (
                                <p className="text-xs text-destructive">Customer name (above) is required for credit / partial sales.</p>
                              )}
                              <Input
                                placeholder="Customer phone"
                                value={customerPhone}
                                onChange={(e) => setCustomerPhone(e.target.value)}
                              />
                              {paymentMode === "partial" && (
                                <div>
                                  <Label className="text-xs">Amount Paid Now (ZMW)</Label>
                                  <Input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    max={total}
                                    placeholder={`0 – ${total.toFixed(2)}`}
                                    value={partialAmount}
                                    onChange={(e) => setPartialAmount(e.target.value)}
                                  />
                                </div>
                              )}
                              <div>
                                <Label className="text-xs">Due Date (optional)</Label>
                                <Input
                                  type="date"
                                  value={dueDate}
                                  onChange={(e) => setDueDate(e.target.value)}
                                />
                              </div>
                              <Textarea
                                placeholder="Notes (optional)"
                                value={creditNotes}
                                onChange={(e) => setCreditNotes(e.target.value)}
                                className="h-16"
                              />
                              <p className="text-xs text-muted-foreground">
                                Balance owed: <strong>ZMW {Math.max(0, total - (paymentMode === "partial" ? Number(partialAmount) || 0 : 0)).toFixed(2)}</strong>
                              </p>
                            </div>
                          )}
                        </div>

                        {/* Back-dating (opt-in). Never allows a future date. */}
                        {canBackdate && (
                          <div className="border-t pt-3 space-y-2">
                            <Label className="text-sm flex items-center gap-1">
                              <CalendarClock className="h-4 w-4" /> Sale Date
                            </Label>
                            <Input
                              type="date"
                              max={new Date().toISOString().slice(0, 10)}
                              value={saleDate}
                              onChange={(e) => setSaleDate(e.target.value)}
                            />
                            <p className="text-xs text-muted-foreground">
                              {saleDate && saleDate < new Date().toISOString().slice(0, 10)
                                ? `Recording this sale as ${saleDate}. It will appear in that day's report.`
                                : "Defaults to today."}
                            </p>
                          </div>
                        )}

                      </>
                    )}

                    {/* Checkout details stay in the scroll area; the total and
                        actions below are pinned so they are always reachable. */}
                    <div className="space-y-1 border-t pt-3">
                      {taxBreakdown && taxBreakdown.taxAmount > 0 ? (
                        <>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Subtotal (excl.)</span>
                            <span>ZMW {taxBreakdown.netSubtotal.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">{taxBreakdown.label}</span>
                            <span>ZMW {taxBreakdown.taxAmount.toFixed(2)}</span>
                          </div>
                        </>
                      ) : (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Subtotal</span>
                          <span>ZMW {subtotal.toFixed(2)}</span>
                        </div>
                      )}
                      {discountAmount > 0 && (
                        <div className="flex justify-between text-sm text-green-600">
                          <span>Discount</span>
                          <span>-ZMW {discountAmount.toFixed(2)}</span>
                        </div>
                      )}
                    </div>

                    <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as any)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cash">Cash</SelectItem>
                        <SelectItem value="mobile_money">Mobile Money</SelectItem>
                      </SelectContent>
                    </Select>

                    {/* Amount received & change calculator */}
                    {paymentMethod === "cash" && cart.length > 0 && (
                      <div className="border-t pt-3 space-y-2">
                        <Label className="text-sm flex items-center gap-1">
                          <DollarSign className="h-4 w-4" /> Amount Received
                        </Label>
                        <Input
                          type="number"
                          placeholder="Enter amount given by customer"
                          value={amountReceived}
                          onChange={(e) => setAmountReceived(e.target.value)}
                          min="0"
                        />
                        {changeDue !== null && (
                          <div className={`rounded-lg p-3 text-center font-bold text-lg ${changeDue >= 0 ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300' : 'bg-destructive/10 text-destructive'}`}>
                            {changeDue >= 0
                              ? `Change: ZMW ${changeDue.toFixed(2)}`
                              : `Short: ZMW ${Math.abs(changeDue).toFixed(2)}`}
                          </div>
                        )}
                      </div>
                    )}

                  </CardContent>

                  {/* Pinned checkout bar — total + actions stay visible without
                      scrolling the cart. */}
                  <div className="shrink-0 space-y-3 border-t bg-card px-6 pb-4 pt-3">
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Total</span>
                      <span className="text-lg font-bold">ZMW {total.toFixed(2)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="outline" onClick={clear} disabled={!cart.length || isProcessing}>Clear</Button>
                      <Button variant="pos" onClick={completeSale} disabled={!cart.length || isProcessing}>
                        {isProcessing ? "Processing…" : paymentMode === "credit" ? "Record Credit" : paymentMode === "partial" ? "Record Partial" : "Complete"}
                      </Button>
                    </div>
                    {!isOnline && <p className="text-xs text-muted-foreground">Offline mode: sales saved locally.</p>}
                  </div>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="quotations">
              <QuotationTab
                businessId={business.id}
                businessName={business.name}
                businessDetails={{
                  phone: business.phone,
                  email: business.email,
                  address: business.address,
                  logoUrl: business.logoUrl,
                  tpin: business.tpin,
                  taxMode: business.taxMode,
                  vatRate: business.vatRate,
                  customTaxName: business.customTaxName,
                  customTaxRate: business.customTaxRate,
                }}
                products={activeProducts}
                isService={isService}
                onConvertToSale={handleConvertQuotation}
                onCreateDeliveryNote={handleCreateDeliveryNoteFromQuotation}
                onCreateInvoice={handleCreateInvoiceFromQuotation}
              />
            </TabsContent>

            <TabsContent value="delivery-notes">
              <DeliveryNoteTab
                businessId={business.id}
                businessName={business.name}
                businessDetails={{
                  phone: business.phone,
                  email: business.email,
                  address: business.address,
                  logoUrl: business.logoUrl,
                }}
                products={activeProducts}
                quotationId={dnQuotation?.id}
                quotationItems={dnQuotation?.items}
                quotationCustomer={
                  dnQuotation
                    ? { name: dnQuotation.customerName, phone: dnQuotation.customerPhone }
                    : undefined
                }
                onClearQuotation={() => setDnQuotation(null)}
                onCreateInvoice={handleCreateInvoiceFromDeliveryNote}
              />
            </TabsContent>

            <TabsContent value="invoices">
              <InvoiceTab
                businessId={business.id}
                businessName={business.name}
                businessDetails={{
                  phone: business.phone,
                  email: business.email,
                  address: business.address,
                  logoUrl: business.logoUrl,
                  tpin: business.tpin,
                  taxMode: business.taxMode,
                  vatRate: business.vatRate,
                  customTaxName: business.customTaxName,
                  customTaxRate: business.customTaxRate,
                }}
                products={activeProducts}
                isService={isService}
                prefill={invPrefill}
                onClearPrefill={() => setInvPrefill(null)}
                onInvoicePaid={() => {
                  void refetchProducts();
                }}
              />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </>
  );
};

export default Pos;

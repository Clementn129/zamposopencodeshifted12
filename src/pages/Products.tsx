import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Package,
  Plus,
  Pencil,
  Trash2,
  AlertTriangle,
  MinusCircle,
  PlusCircle,
  Briefcase,
  Tag,
  X,
  Download,
  Upload,
  Utensils,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import ConnectionStatus from "@/components/ConnectionStatus";
import SyncStatusBanner from "@/components/SyncStatusBanner";
import LockScreen from "@/components/LockScreen";
import InventoryDashboard from "@/components/InventoryDashboard";
import ProductImageUpload from "@/components/ProductImageUpload";
import VariantsManager from "@/components/VariantsManager";
import MenuModifiersManager from "@/components/MenuModifiersManager";
import { useAuthContext } from "@/contexts/AuthContext";
import PendingStockRequests from "@/components/PendingStockRequests";

import { useBusiness } from "@/hooks/useBusiness";
import { useProducts, Product } from "@/hooks/useProducts";
import { useStockSync } from "@/hooks/useStockSync";
import { useBusinessType } from "@/hooks/useBusinessType";
import { useProductCategories } from "@/hooks/useProductCategories";
import { supabase } from "@/integrations/supabase/client";
import {
  saveOfflineStockUpdate,
  updateCachedProductStock,
  generateOfflineId,
  queuePendingOp,
  cacheProducts,
  getCachedProducts,
  storePendingImageUpload,
  removePendingImageUpload,
  cacheProductImageBlob,
  getCachedImageBlob,
} from "@/lib/offlineStorage";

const NEW_CAT_VALUE = "__new__";
const NO_CAT_VALUE = "__none__";

const Products = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isLoading: authLoading, role } = useAuthContext();
  const isCashier = role === "cashier";

  const { business, isLoading: bizLoading, refetch: refetchBusiness, checkSubscriptionStatus } =
    useBusiness(user?.id);

  const { isLocked } = checkSubscriptionStatus();
  const { products, isLoading: productsLoading, error, isOnline, refetch } = useProducts(business?.id);
  const { isSyncing: stockSyncing, pendingCount: stockPending, syncNow: syncStockNow } = useStockSync(
    business?.id
  );
  const { labels, isService, isHybrid, isRestaurant } = useBusinessType(business?.id, business?.businessType);
  const {
    categories,
    setCategories,
    refetch: refetchCategories,
    create: createCategory,
  } = useProductCategories(business?.id);

  const [query, setQuery] = useState("");
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [displayLimit, setDisplayLimit] = useState(200);
  const [open, setOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [modifiersOpen, setModifiersOpen] = useState(false);
  const [stockAdjustOpen, setStockAdjustOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [stockAdjustment, setStockAdjustment] = useState("");
  const [adjustmentType, setAdjustmentType] = useState<"add" | "subtract">("add");
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form state
  const [name, setName] = useState("");
  const [price, setPrice] = useState("0");
  const [costPrice, setCostPrice] = useState("");
  const [stock, setStock] = useState("0");
  const [minimumStock, setMinimumStock] = useState("5");
  const [category, setCategory] = useState<string>("");
  const [newCategory, setNewCategory] = useState("");
  const [taxCategory, setTaxCategory] = useState<"taxable" | "zero_rated" | "exempt">("taxable");
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [barcode, setBarcode] = useState("");
  const [barcodeSvg, setBarcodeSvg] = useState<string | null>(null);
  const [itemType, setItemType] = useState<"product" | "service">(isService ? "service" : "product");
  const [trackExpiry, setTrackExpiry] = useState(false);
  const [expiryDate, setExpiryDate] = useState("");

  // New-category input inside the "Manage categories" dialog
  const [pendingNewCategory, setPendingNewCategory] = useState("");

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  // Top-level products (parents + standalone). Variants render under their parent.
  const topLevel = useMemo(
    () => products.filter((p) => p.isActive && !p.parentId),
    [products]
  );
  const variantsByParent = useMemo(() => {
    const map: Record<string, Product[]> = {};
    for (const p of products) {
      if (p.isActive && p.parentId) {
        (map[p.parentId] ||= []).push(p);
      }
    }
    return map;
  }, [products]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const { parentIds, sellableIds } = topLevel.reduce<{
      parentIds: Set<string>;
      sellableIds: Set<string>;
    }>(
      (acc, p) => {
        const vars = variantsByParent[p.id] ?? [];
        if (vars.length > 0) {
          acc.parentIds.add(p.id);
          vars.forEach((v) => acc.sellableIds.add(v.id));
        } else if (p.itemType !== 'service') {
          acc.sellableIds.add(p.id);
        }
        return acc;
      },
      { parentIds: new Set(), sellableIds: new Set() }
    );

    const matchesStock = (p: Product): boolean => {
      if (stockFilter === 'all') return true;
      if (p.itemType === 'service') return false;
      const ids = parentIds.has(p.id) ? (variantsByParent[p.id] ?? []).map((v) => v.id) : [p.id];
      return ids.some((id) => {
        const prod = products.find((pp) => pp.id === id);
        if (!prod) return false;
        const stock = prod.stock ?? 0;
        if (stockFilter === 'out') return stock <= 0;
        return stock > 0 && stock <= (prod.minimumStock ?? 5);
      });
    };

    const base = stockFilter === 'all' ? topLevel : topLevel.filter(matchesStock);
    if (!q) return base;
    return base.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true;
      if ((p.category ?? "").toLowerCase().includes(q)) return true;
      if ((p.barcode ?? "").toLowerCase().includes(q)) return true;
      const vars = variantsByParent[p.id] ?? [];
      return vars.some((v) => (v.variantLabel ?? "").toLowerCase().includes(q));
    });
  }, [topLevel, variantsByParent, query, stockFilter, products]);

  const groupedProducts = useMemo(() => {
    const groups: Record<string, Product[]> = {};
    let count = 0;
    for (const p of filtered) {
      if (count >= displayLimit) break;
      const cat = p.category || "Uncategorized";
      (groups[cat] ||= []).push(p);
      count++;
    }
    return groups;
  }, [filtered, displayLimit]);

  const resetForm = () => {
    setName("");
    setPrice("0");
    setCostPrice("");
    setStock("0");
    setMinimumStock("5");
    setCategory("");
    setNewCategory("");
    setTaxCategory("taxable");
    setImagePath(null);
    setImageUrl(null);
    setBarcode("");
    setBarcodeSvg(null);
    setItemType(isService ? "service" : "product");
    setTrackExpiry(false);
    setExpiryDate("");
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setOpen(true);
  };

  const openEdit = (p: Product) => {
    setEditing(p);
    setName(p.name);
    setPrice(String(p.price));
    setCostPrice(p.costPrice ? String(p.costPrice) : "");
    setStock(String(p.stock));
    setMinimumStock(String(p.minimumStock));
    setCategory(p.category ?? "");
    setNewCategory("");
    setTaxCategory(p.taxCategory || "taxable");
    setImagePath(p.imagePath);
    setImageUrl(p.imageUrl);
    setBarcode(p.barcode ?? "");
    setBarcodeSvg(null);
    setItemType(p.itemType ?? (isService ? "service" : "product"));
    setTrackExpiry(p.trackExpiry ?? false);
    setExpiryDate(p.expiryDate ?? "");
    setOpen(true);
  };

  const resolveCategoryValue = async (): Promise<string | null> => {
    if (category === NEW_CAT_VALUE) {
      const created = await createCategory(newCategory);
      return created;
    }
    if (category === NO_CAT_VALUE || !category) return null;
    return category;
  };

  const save = async () => {
    if (!business) return;
    if (!user) {
      toast({ variant: "destructive", title: "Login required" });
      navigate("/auth");
      return;
    }
    if (!name.trim()) {
      toast({ variant: "destructive", title: "Missing name" });
      return;
    }

    const parseNum = (v: string, fallback: number) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const parseInt0 = (v: string, fallback: number) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };

    const priceNum = parseNum(price, 0);
    const costNum = costPrice.trim() ? parseNum(costPrice, 0) : null;
    const stockNum = parseInt0(stock, 0);
    const minStockNum = parseInt0(minimumStock, 5);

    if (priceNum < 0) {
      toast({ variant: "destructive", title: "Invalid price", description: "Enter a price of 0 or more." });
      return;
    }

    setSaving(true);
    try {
      const categoryValue = await resolveCategoryValue();

      const resolvedItemType = isHybrid ? itemType : isService ? "service" : "product";
      const isServiceItem = resolvedItemType === "service";

      const payload = {
        name: name.trim(),
        price: priceNum,
        cost_price: costNum,
        stock: isServiceItem ? 0 : stockNum,
        minimum_stock: isServiceItem ? 0 : minStockNum,
        category: categoryValue,
        tax_category: taxCategory,
        image_url: imagePath,
        barcode: barcode.trim() || null,
        item_type: resolvedItemType,
        track_expiry: trackExpiry && !isServiceItem,
        expiry_date: trackExpiry && !isServiceItem && expiryDate ? expiryDate : null,
      };

      if (isOnline) {
        if (editing) {
          const { error } = await supabase.from("products").update(payload).eq("id", editing.id);
          if (error) throw error;
          toast({ title: "Updated" });
        } else {
          const { error } = await supabase
            .from("products")
            .insert({ business_id: business.id, is_active: true, ...payload });
          if (error) throw error;
          toast({ title: "Created" });
        }
      } else {
        // Offline: save to local cache and queue for sync
        const cached = await getCachedProducts(business.id);
        if (editing) {
          const idx = cached.findIndex((p) => p.id === editing.id);
          if (idx >= 0) {
            cached[idx] = {
              ...cached[idx],
              ...payload as any,
              imageUrl: imageUrl ?? undefined,
              imagePath: imagePath ?? undefined,
            };
          }
          await queuePendingOp({
            id: generateOfflineId(),
            businessId: business.id,
            type: 'product_update',
            payload: { ...payload, productId: editing.id },
            createdAt: new Date().toISOString(),
          });
          toast({ title: "Updated (offline)" });
        } else {
          const tempId = generateOfflineId();
          cached.push({
            id: tempId,
            businessId: business.id,
            name: payload.name,
            price: payload.price,
            costPrice: payload.cost_price,
            stock: payload.stock,
            minimumStock: payload.minimum_stock,
            category: payload.category,
            isActive: true,
            taxCategory: payload.tax_category || 'taxable',
            imageUrl,
            imagePath,
            barcode: payload.barcode || null,
            parentId: null,
            variantLabel: null,
            trackExpiry: payload.track_expiry,
            expiryDate: payload.expiry_date,
          } as any);
          await queuePendingOp({
            id: generateOfflineId(),
            businessId: business.id,
            type: 'product_create',
            payload: { ...payload, tempId },
            createdAt: new Date().toISOString(),
          });
          toast({ title: "Created (offline)" });
        }
        await cacheProducts(cached);
      }

      setOpen(false);
      resetForm();
      await refetch();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed",
        description: e instanceof Error ? e.message : "Could not save product",
      });
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (p: Product) => {
    try {
      const variants = variantsByParent[p.id] ?? [];
      const activeVariants = variants.filter((v) => v.isActive);

      if (isOnline) {
        // Deactivate active variants first so the DB trigger allows parent deactivation
        if (activeVariants.length > 0) {
          const ids = activeVariants.map((v) => v.id);
          const { error: varErr } = await supabase
            .from("products")
            .update({ is_active: false })
            .in("id", ids);
          if (varErr) throw varErr;
        }
        const { error } = await supabase.from("products").update({ is_active: false }).eq("id", p.id);
        if (error) throw error;
      } else {
        // Offline: update local cache and queue
        const cached = await getCachedProducts(business!.id);
        const idsToDeactivate = [p.id, ...activeVariants.map((v) => v.id)];
        for (const id of idsToDeactivate) {
          const idx = cached.findIndex((x) => x.id === id);
          if (idx >= 0) cached[idx].isActive = false;
          await queuePendingOp({
            id: generateOfflineId(),
            businessId: business!.id,
            type: 'product_deactivate',
            payload: { productId: id },
            createdAt: new Date().toISOString(),
          });
        }
        await cacheProducts(cached);
      }
      const count = activeVariants.length;
      toast({ title: "Removed", description: count > 0 ? `${count + 1} items removed.` : undefined });
      await refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not remove";
      const friendly = /PARENT_HAS_ACTIVE_VARIANTS/.test(msg)
        ? "Remove all variants of this product first."
        : msg;
      toast({ variant: "destructive", title: "Failed", description: friendly });
    }
  };

  const openStockAdjust = (p: Product) => {
    setSelectedProduct(p);
    setStockAdjustment("");
    setAdjustmentType("add");
    setStockAdjustOpen(true);
  };

  const adjustStock = async () => {
    if (!business || !selectedProduct || !user) return;
    const adjustmentValue = Number(stockAdjustment) || 0;
    if (adjustmentValue <= 0) {
      toast({ variant: "destructive", title: "Invalid amount" });
      return;
    }
    const stockChange = adjustmentType === "add" ? adjustmentValue : -adjustmentValue;
    const newStock = Math.max(0, selectedProduct.stock + stockChange);

    setSaving(true);
    try {
      // Cashiers cannot edit stock directly — submit a request for owner approval.
      if (isCashier) {
        const { error } = await supabase.from("stock_adjustment_requests").insert({
          business_id: business.id,
          product_id: selectedProduct.parentId ?? selectedProduct.id,
          variant_id: selectedProduct.parentId ? selectedProduct.id : null,
          requested_by: user.id,
          requester_name: user.email ?? null,
          adjustment_type: adjustmentType,
          quantity: adjustmentValue,
        });
        if (error) throw error;
        toast({
          title: "Sent for approval",
          description: `${selectedProduct.name}: ${adjustmentType === "add" ? "+" : "-"}${adjustmentValue} pending owner review.`,
        });
        setStockAdjustOpen(false);
        setSelectedProduct(null);
        return;
      }

      if (isOnline) {
        const { error } = await supabase
          .from("products")
          .update({ stock: newStock })
          .eq("id", selectedProduct.id);
        if (error) throw error;
        toast({
          title: "Stock updated",
          description: `${selectedProduct.name}: ${selectedProduct.stock} → ${newStock}`,
        });
      } else {
        await saveOfflineStockUpdate({
          id: generateOfflineId(),
          productId: selectedProduct.id,
          businessId: business.id,
          stockChange,
          createdAt: new Date().toISOString(),
          synced: false,
        });
        await updateCachedProductStock(selectedProduct.id, newStock);
        toast({ title: "Saved offline" });
      }
      if (isOnline) await syncStockNow();
      setStockAdjustOpen(false);
      setSelectedProduct(null);
      await refetch();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed",
        description: e instanceof Error ? e.message : "Could not update stock",
      });
    } finally {
      setSaving(false);
    }
  };


  const addCategory = async () => {
    if (!pendingNewCategory.trim()) return;
    try {
      const result = await createCategory(pendingNewCategory);
      setPendingNewCategory("");
      if (result) toast({ title: "Category added" });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed",
        description: e instanceof Error ? e.message : "Could not add",
      });
    }
  };

  const deleteCategory = async (id: string) => {
    try {
      if (!isOnline) {
        await queuePendingOp({
          id: generateOfflineId(),
          businessId: business!.id,
          type: 'category_delete',
          payload: { id },
          createdAt: new Date().toISOString(),
        });
        setCategories(prev => prev.filter((c: any) => c.id !== id));
        toast({ title: "Category deleted offline" });
        return;
      }
      const { error } = await supabase.from("product_categories").delete().eq("id", id);
      if (error) throw error;
      await refetchCategories();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed",
        description: e instanceof Error ? e.message : "Could not delete",
      });
    }
  };

  const exportCsv = () => {
    const rows = products.filter((p) => p.isActive);
    const headers = [
      "name",
      "item_type",
      "price",
      "cost_price",
      "stock",
      "minimum_stock",
      "category",
      "barcode",
      "tax_category",
    ];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [
      headers.join(","),
      ...rows.map((p) =>
        [
          p.name,
          p.itemType,
          p.price,
          p.costPrice ?? "",
          p.itemType === "service" ? "" : p.stock,
          p.itemType === "service" ? "" : p.minimumStock,
          p.category ?? "",
          p.barcode ?? "",
          p.taxCategory,
        ]
          .map(esc)
          .join(",")
      ),
    ].join("\n");
    const label = isService ? "services" : "products";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${label}-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: `${rows.length} ${label}` });
  };

  const downloadTemplate = () => {
    const headers =
      "name,item_type,price,cost_price,stock,minimum_stock,category,barcode,tax_category";
    const example = isService
      ? `"Haircut","service",50,,,,"Salon",,"taxable"`
      : `"Cooking Oil 1L","product",45,30,20,5,"Groceries","1234567890","taxable"`;
    const csv = `${headers}\n${example}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "import-template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const parseCsv = (text: string): Record<string, string>[] => {
    const rows: string[][] = [];
    let cur: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") {
          cur.push(field);
          field = "";
        } else if (c === "\n" || c === "\r") {
          if (field.length || cur.length) {
            cur.push(field);
            rows.push(cur);
            cur = [];
            field = "";
          }
          if (c === "\r" && text[i + 1] === "\n") i++;
        } else {
          field += c;
        }
      }
    }
    if (field.length || cur.length) {
      cur.push(field);
      rows.push(cur);
    }
    if (rows.length === 0) return [];
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    return rows.slice(1).map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        obj[h] = (r[idx] ?? "").trim();
      });
      return obj;
    });
  };

  const importCsv = async (file: File) => {
    if (!business || !isOnline) {
      toast({ variant: "destructive", title: "Offline", description: "Connect to internet to import." });
      return;
    }
    setImporting(true);
    try {
      const text = await file.text();
      const rows = parseCsv(text).filter((r) => (r.name ?? "").trim());
      if (!rows.length) {
        toast({ variant: "destructive", title: "Empty file", description: "No rows found." });
        return;
      }
      const payloads = rows.map((r) => {
        const itemTypeVal = (r.item_type || (isService ? "service" : "product")).toLowerCase();
        const isServiceRow = itemTypeVal === "service";
        const num = (v: string) => {
          const n = parseFloat(v);
          return Number.isFinite(n) ? n : 0;
        };
        const tax = ["taxable", "zero_rated", "exempt"].includes(r.tax_category)
          ? r.tax_category
          : "taxable";
        return {
          business_id: business.id,
          is_active: true,
          name: r.name.trim(),
          price: num(r.price),
          cost_price: r.cost_price ? num(r.cost_price) : null,
          stock: isServiceRow ? 0 : Math.max(0, Math.floor(num(r.stock))),
          minimum_stock: isServiceRow ? 0 : Math.max(0, Math.floor(num(r.minimum_stock || "5"))),
          category: r.category || null,
          barcode: r.barcode || null,
          tax_category: tax,
          item_type: isServiceRow ? "service" : "product",
        };
      });
      const { error } = await supabase.from("products").insert(payloads);
      if (error) throw error;
      toast({ title: "Imported", description: `${payloads.length} item(s) added.` });
      await refetch();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Import failed",
        description: e instanceof Error ? e.message : "Could not import file",
      });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const initialLoading =
    (authLoading && !user) ||
    (bizLoading && !business) ||
    (productsLoading && products.length === 0);

  if (initialLoading) {
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
        <LockScreen
          paymentCode={business.paymentCode}
          businessId={business.id}
          onRetrySync={refetchBusiness}
        />
      </>
    );
  }

  return (
    <>
      <ConnectionStatus />
      <SyncStatusBanner
        isOnline={isOnline}
        isSyncing={stockSyncing}
        pendingCount={stockPending}
        lastSyncError={null}
      />
      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-3 py-3 sm:px-4 sm:py-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate("/dashboard")}
                aria-label="Back"
                className="shrink-0"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="min-w-0">
                <h1 className="font-display font-bold text-base sm:text-lg flex items-center gap-2 truncate">
                  {isService ? <Briefcase className="h-5 w-5 shrink-0" /> : <Package className="h-5 w-5 shrink-0" />}{" "}
                  <span className="truncate">{labels.productsTitle}</span>
                </h1>
                <p className="text-xs text-muted-foreground">
                  {isOnline ? "Online" : "Offline (changes sync when online)"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importCsv(f);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={exportCsv}
                disabled={products.length === 0}
                aria-label="Export CSV"
                title="Export all items to CSV"
              >
                <Download className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Export</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={!isOnline || importing}
                aria-label="Import CSV"
                title="Import items from CSV"
              >
                <Upload className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">{importing ? "Importing…" : "Import"}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={downloadTemplate}
                aria-label="Download template"
                title="Download CSV template"
                className="hidden sm:inline-flex"
              >
                Template
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCategoriesOpen(true)}
                disabled={!isOnline}
                aria-label="Categories"
              >
                <Tag className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Categories</span>
              </Button>
              {isRestaurant && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setModifiersOpen(true)}
                  disabled={!isOnline}
                  aria-label="Menu modifiers"
                  title="Modifier groups and options"
                >
                  <Utensils className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">Modifiers</span>
                </Button>
              )}
              <Button variant="pos" size="sm" onClick={openCreate} aria-label={labels.addButtonLabel}>
                <Plus className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">{labels.addButtonLabel}</span>
              </Button>
            </div>
          </div>
        </header>


        <main className="p-4 max-w-4xl mx-auto space-y-4">
          {/* Inventory dashboard */}
          <InventoryDashboard products={products} stockOnly={isService} activeFilter={stockFilter} onFilterChange={setStockFilter} />

          {!isCashier && business?.id && (
            <PendingStockRequests
              businessId={business.id}
              products={products.map((p) => ({ id: p.id, name: p.name }))}
              onApproved={refetch}
            />
          )}


          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{isService ? "Service Menu" : "Inventory"}</CardTitle>
              <CardDescription>{labels.productsDescription}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  stockFilter === 'low'
                    ? "Searching low stock — type name, category or variant"
                    : stockFilter === 'out'
                      ? "Searching out of stock — type name, category or variant"
                      : "Search by name, category or variant"
                }
              />

              {error ? <p className="text-sm text-destructive">{error}</p> : null}

              <div className="space-y-4">
                {Object.keys(groupedProducts).length === 0 ? (
                  <p className="text-sm text-muted-foreground">{labels.noItemsMessage}</p>
                ) : (
                  Object.entries(groupedProducts).map(([cat, prods]) => (
                    <div key={cat} className="space-y-2">
                      <div className="flex items-center justify-between bg-muted/50 rounded-lg px-3 py-2">
                        <h3 className="font-medium text-sm">{cat}</h3>
                        <span className="text-xs text-muted-foreground">{prods.length} items</span>
                      </div>
                      {prods.map((p) => {
                        const vars = variantsByParent[p.id] ?? [];
                        const hasVariants = vars.length > 0;
                        const rowIsService = p.itemType === "service";
                        const showRowStock = labels.showStock && !rowIsService;
                        let cardBg = "bg-secondary";
                        if (p.trackExpiry && p.expiryDate) {
                          const dl = Math.ceil((new Date(p.expiryDate).getTime() - Date.now()) / 86400000);
                          if (dl <= 0) cardBg = "bg-red-100 dark:bg-red-900/30";
                          else if (dl <= 30) cardBg = "bg-yellow-50 dark:bg-yellow-900/20";
                        }
                        return (
                            <div key={p.id} className="space-y-1 ml-2">
                            <div className={"flex items-center justify-between rounded-lg p-3 " + cardBg}>
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                {p.imageUrl ? (
                                  <img
                                    src={p.imageUrl}
                                    alt={p.name}
                                    className="h-12 w-12 rounded object-cover shrink-0"
                                    onError={async (e) => { if (!p.imagePath) return; try { const blob = await getCachedImageBlob(p.imagePath); if (blob) (e.target as HTMLImageElement).src = URL.createObjectURL(blob); } catch { /* blob fetch failed */ } }}
                                  />
                                ) : (
                                  <div className="h-12 w-12 rounded bg-muted flex items-center justify-center shrink-0">
                                    {rowIsService || isService ? (
                                      <Briefcase className="h-5 w-5 text-muted-foreground" />
                                    ) : (
                                      <Package className="h-5 w-5 text-muted-foreground" />
                                    )}
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <p className="font-medium truncate">{p.name}</p>
                                    {isHybrid && (
                                      <Badge variant="outline" className="text-[10px]">
                                        {rowIsService ? "Service" : "Product"}
                                      </Badge>
                                    )}
                                    {hasVariants && (
                                      <Badge variant="outline" className="text-xs">
                                        {vars.length} variant{vars.length === 1 ? "" : "s"}
                                      </Badge>
                                    )}
                                    {!hasVariants && showRowStock && p.stock <= p.minimumStock && (
                                      <Badge variant="destructive" className="text-xs flex items-center gap-1">
                                        <AlertTriangle className="h-3 w-3" /> {labels.lowStockWarning}
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground truncate">
                                    {hasVariants
                                      ? "From K " +
                                        Math.min(...vars.map((v) => v.price ?? 0)).toFixed(2)
                                      : `K ${(p.price ?? 0).toFixed(2)}`}
                                    {p.costPrice && !hasVariants
                                      ? ` • Cost K ${p.costPrice.toFixed(2)}`
                                      : ""}
                                    {showRowStock && !hasVariants
                                      ? ` • ${labels.stockDisplay(p.stock ?? 0)}`
                                      : ""}
                                    {p.trackExpiry && p.expiryDate ? (
                                      (() => {
                                        const daysLeft = Math.ceil((new Date(p.expiryDate).getTime() - Date.now()) / 86400000);
                                        const expired = daysLeft <= 0;
                                        const soon = daysLeft > 0 && daysLeft <= 30;
                                        return ` • ${expired ? "EXPIRED" : soon ? `Exp ${daysLeft}d` : `Exp ${p.expiryDate}`}`;
                                      })()
                                    ) : ""}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {showRowStock && !hasVariants && (
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    onClick={() => openStockAdjust(p)}
                                    aria-label="Adjust Stock"
                                  >
                                    <PlusCircle className="h-4 w-4" />
                                  </Button>
                                )}
                                <Button
                                  variant="outline"
                                  size="icon"
                                  onClick={() => openEdit(p)}
                                  aria-label="Edit"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="icon"
                                  onClick={() => deactivate(p)}
                                  aria-label="Remove"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>

                            {hasVariants && (
                              <div className="ml-4 space-y-1">
                                {vars.map((v) => (
                                  <div
                                    key={v.id}
                                    className="flex items-center justify-between bg-background border rounded-md px-3 py-2 text-sm"
                                  >
                                    <div>
                                      <span className="font-medium">{v.variantLabel}</span>
                                      <span className="text-muted-foreground ml-2">
                                        K {(v.price ?? 0).toFixed(2)}
                                        {labels.showStock ? ` • Stock ${v.stock ?? 0}` : ""}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => openEdit(v)}
                                        aria-label="Edit variant"
                                      >
                                        <Pencil className="h-4 w-4" />
                                      </Button>
                                      {labels.showStock && (
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          onClick={() => openStockAdjust(v)}
                                          aria-label="Adjust Stock"
                                        >
                                          <PlusCircle className="h-4 w-4" />
                                        </Button>
                                      )}
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => deactivate(v)}
                                        aria-label="Remove variant"
                                      >
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>

              {filtered.length > displayLimit && (
                <div className="text-center pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDisplayLimit((prev) => prev + 200)}
                  >
                    Show more ({filtered.length - displayLimit} remaining)
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Button variant="outline" className="w-full" onClick={refetch}>
            Refresh list
          </Button>
        </main>
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? `Edit ${itemType === "service" ? "Service" : "Product"}`
                : `Add ${itemType === "service" ? "Service" : "Product"}`}
            </DialogTitle>
            <DialogDescription>
              {isOnline ? "" : "Changes will sync when online."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {isHybrid && (
              <div className="space-y-2">
                <Label>Type</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={itemType === "product" ? "pos" : "outline"}
                    onClick={() => setItemType("product")}
                    className="justify-start"
                  >
                    <Package className="h-4 w-4 mr-2" /> Product
                  </Button>
                  <Button
                    type="button"
                    variant={itemType === "service" ? "pos" : "outline"}
                    onClick={() => setItemType("service")}
                    className="justify-start"
                  >
                    <Briefcase className="h-4 w-4 mr-2" /> Service
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Services skip stock tracking.
                </p>
              </div>
            )}
            {/* Image */}
            {business && (
              <div className="space-y-2">
                <Label>Image (optional)</Label>
                <ProductImageUpload
                  businessId={business.id}
                  previewUrl={imageUrl}
                  currentPath={imagePath}
                  onUploaded={(path, signed) => {
                    setImagePath(path);
                    setImageUrl(signed);
                  }}
                  onCleared={() => {
                    if (imagePath?.startsWith('pending:')) {
                      const id = imagePath.replace('pending:', '');
                      removePendingImageUpload(id).catch(() => {});
                    }
                    setImagePath(null);
                    setImageUrl(null);
                  }}
                  customUpload={!isOnline ? async (file) => {
                    const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    const blob = new Blob([file], { type: file.type });
                    await storePendingImageUpload({
                      id: uploadId,
                      blob,
                      mimeType: file.type,
                      businessId: business.id,
                      originalName: file.name,
                    });
                    await cacheProductImageBlob(`pending:${uploadId}`, blob);
                    const blobUrl = URL.createObjectURL(blob);
                    return { path: `pending:${uploadId}`, signedUrl: blobUrl };
                  } : undefined}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label>{labels.itemName}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={labels.itemNamePlaceholder}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{labels.priceLabel}</Label>
                <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Cost Price (optional)</Label>
                <Input
                  type="number"
                  value={costPrice}
                  onChange={(e) => setCostPrice(e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Barcode (optional)</Label>
              <div className="flex gap-2">
                <Input
                  value={barcode}
                  onChange={(e) => {
                    setBarcode(e.target.value);
                    setBarcodeSvg(null);
                  }}
                  placeholder="Scan or type barcode / SKU"
                  data-scanner-target="true"
                  className="flex-1"
                />
                <Button variant="outline" size="sm" onClick={() => {
                  const prefix = "2";
                  const ts = Date.now().toString().slice(-8);
                  const raw = prefix + ts;
                  let sum = 0;
                  for (let i = 0; i < raw.length; i++) {
                    sum += parseInt(raw[i]) * (i % 2 === 0 ? 1 : 3);
                  }
                  const check = (10 - (sum % 10)) % 10;
                  const code = raw + check;
                  setBarcode(code);
                  setBarcodeSvg(null);
                }}>
                  Generate
                </Button>
              </div>
              {barcode && /^\d{8,}$/.test(barcode) && (
                <div className="mt-2 flex flex-col items-center gap-2">
                  <svg key={barcode} id="barcode-svg" ref={(el) => {
                    if (el && !el.hasChildNodes() && typeof window !== 'undefined') {
                      import('jsbarcode').then((m) => {
                        try {
                          m.default(el, barcode, { format: 'CODE128', width: 2, height: 60, displayValue: true, margin: 5 });
                          setBarcodeSvg(new XMLSerializer().serializeToString(el));
                        } catch { /* ignore invalid barcode */ }
                      }).catch(() => {});
                    }
                  }} />
                  {barcodeSvg && (
                    <Button variant="outline" size="sm" onClick={() => {
                      const canvas = document.createElement('canvas');
                      const ctx = canvas.getContext('2d');
                      const img = new Image();
                      const svgBlob = new Blob([barcodeSvg], { type: 'image/svg+xml;charset=utf-8' });
                      const url = URL.createObjectURL(svgBlob);
                      img.onload = () => {
                        canvas.width = img.width * 2;
                        canvas.height = img.height * 2;
                        ctx!.scale(2, 2);
                        ctx!.drawImage(img, 0, 0);
                        URL.revokeObjectURL(url);
                        const a = document.createElement('a');
                        a.download = `barcode-${barcode}.png`;
                        a.href = canvas.toDataURL('image/png');
                        a.click();
                      };
                      img.src = url;
                    }}>
                      Download PNG
                    </Button>
                  )}
                </div>
              )}
            </div>

            {labels.showStock && itemType !== "service" && (!editing || !(variantsByParent[editing.id]?.length)) && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{labels.stockLabel}</Label>
                  <Input type="number" value={stock} onChange={(e) => setStock(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>{labels.minStockLabel}</Label>
                  <Input
                    type="number"
                    value={minimumStock}
                    onChange={(e) => setMinimumStock(e.target.value)}
                    placeholder="5"
                  />
                </div>
              </div>
            )}

            {itemType !== "service" && (
              <div className="space-y-3 border rounded-lg p-3 bg-muted/20">
                <div className="flex items-center justify-between">
                  <Label htmlFor="track-expiry" className="cursor-pointer">Track Expiry Date</Label>
                  <input
                    id="track-expiry"
                    type="checkbox"
                    checked={trackExpiry}
                    onChange={(e) => setTrackExpiry(e.target.checked)}
                    className="toggle toggle-sm"
                  />
                </div>
                {trackExpiry && (
                  <div className="space-y-2">
                    <Label>Expiry Date</Label>
                    <Input
                      type="date"
                      value={expiryDate}
                      onChange={(e) => setExpiryDate(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label>{labels.categoryLabel}</Label>
              <Select value={category || NO_CAT_VALUE} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CAT_VALUE}>Uncategorized</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.name}>
                      {c.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_CAT_VALUE}>+ Create new category…</SelectItem>
                </SelectContent>
              </Select>
              {category === NEW_CAT_VALUE && (
                <Input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder={isService ? "Hair, Nails…" : "Groceries…"}
                />
              )}
            </div>

            <div className="space-y-2">
              <Label>Tax Category</Label>
              <Select
                value={taxCategory}
                onValueChange={(v) => setTaxCategory(v as "taxable" | "zero_rated" | "exempt")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="taxable">Taxable (standard rate)</SelectItem>
                  <SelectItem value="zero_rated">Zero Rated (0%)</SelectItem>
                  <SelectItem value="exempt">Exempt (no tax)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Variants — only for products (not services), on the top-level row */}
            {itemType !== "service" && editing && !editing.parentId && (
              <VariantsManager
                parent={editing}
                variants={variantsByParent[editing.id] ?? []}
                onChanged={refetch}
                disabled={!isOnline}
              />
            )}
            {itemType !== "service" && !editing && (
              <p className="text-xs text-muted-foreground border rounded-md p-2 bg-muted/30">
                Tip: Save this product first, then reopen it to add variants (e.g. 500ml / 1L / 2L).
              </p>
            )}

            <Button
              variant="pos-accent"
              className="w-full"
              onClick={save}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Categories dialog */}
      <Dialog open={categoriesOpen} onOpenChange={setCategoriesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage categories</DialogTitle>
            <DialogDescription>
              Categories are shared across all your products.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={pendingNewCategory}
                onChange={(e) => setPendingNewCategory(e.target.value)}
                placeholder="New category name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addCategory();
                  }
                }}
              />
              <Button variant="outline" onClick={addCategory}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-1 max-h-64 overflow-y-auto">
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground">No categories yet.</p>
              ) : (
                categories.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between bg-secondary rounded-md px-3 py-2"
                  >
                    <span className="text-sm">{c.name}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteCategory(c.id)}
                      aria-label={`Delete ${c.name}`}
                    >
                      <X className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Deleting a category does not remove the category label on existing products.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Menu Modifiers Dialog (restaurant only) */}
      {isRestaurant && (
        <MenuModifiersManager
          open={modifiersOpen}
          onOpenChange={setModifiersOpen}
          businessId={business?.id}
          products={products}
        />
      )}

      {/* Stock Adjustment Dialog */}
      <Dialog open={stockAdjustOpen} onOpenChange={setStockAdjustOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Stock</DialogTitle>
            <DialogDescription>
              {selectedProduct?.name}
              {selectedProduct?.variantLabel ? ` · ${selectedProduct.variantLabel}` : ""} — Current:{" "}
              {selectedProduct?.stock}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                variant={adjustmentType === "add" ? "pos" : "outline"}
                className="flex-1"
                onClick={() => setAdjustmentType("add")}
              >
                <PlusCircle className="h-4 w-4 mr-2" /> Add Stock
              </Button>
              <Button
                variant={adjustmentType === "subtract" ? "destructive" : "outline"}
                className="flex-1"
                onClick={() => setAdjustmentType("subtract")}
              >
                <MinusCircle className="h-4 w-4 mr-2" /> Remove
              </Button>
            </div>
            <div className="space-y-2">
              <Label>Quantity</Label>
              <Input
                type="number"
                value={stockAdjustment}
                onChange={(e) => setStockAdjustment(e.target.value)}
                placeholder="Enter amount"
              />
            </div>
            <p className="text-sm text-muted-foreground text-center">
              New stock:{" "}
              {Math.max(
                0,
                (selectedProduct?.stock || 0) +
                  (adjustmentType === "add"
                    ? Number(stockAdjustment) || 0
                    : -(Number(stockAdjustment) || 0))
              )}
            </p>
            <Button
              variant="pos-accent"
              className="w-full"
              onClick={adjustStock}
              disabled={saving}
            >
              {saving ? "Saving…" : isOnline ? "Update Stock" : "Save Offline"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default Products;

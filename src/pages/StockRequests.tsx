import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Boxes,
  CheckCircle2,
  Clock,
  Loader2,
  Minus,
  PackagePlus,
  Plus,
  Search,
  XCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBusiness } from "@/hooks/useBusiness";
import { useAuthContext } from "@/contexts/AuthContext";
import { useCashierPermissions } from "@/hooks/useCashierPermissions";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type ProductLite = { id: string; name: string; stock: number | null; is_active: boolean | null };

type MyRequest = {
  id: string;
  product_id: string;
  adjustment_type: "add" | "remove";
  quantity: number;
  reason: string | null;
  status: string;
  created_at: string;
};

const StockRequests = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { business } = useBusiness();
  const { user, role } = useAuthContext();
  const { canAdjustStock, loading: permLoading } = useCashierPermissions();

  const [products, setProducts] = useState<ProductLite[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ProductLite | null>(null);
  const [kind, setKind] = useState<"add" | "remove">("add");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const [mine, setMine] = useState<MyRequest[]>([]);

  const loadProducts = useCallback(async () => {
    if (!business?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("products")
      .select("id, name, stock, is_active")
      .eq("business_id", business.id)
      .eq("is_active", true)
      .order("name");
    if (error) {
      toast({ variant: "destructive", title: "Could not load products", description: error.message });
    } else {
      setProducts((data ?? []) as ProductLite[]);
    }
    setLoading(false);
  }, [business?.id, toast]);

  const loadMine = useCallback(async () => {
    if (!business?.id || !user?.id) return;
    const { data } = await supabase
      .from("stock_adjustment_requests")
      .select("id, product_id, adjustment_type, quantity, reason, status, created_at")
      .eq("business_id", business.id)
      .eq("requested_by", user.id)
      .order("created_at", { ascending: false })
      .limit(15);
    setMine((data ?? []) as MyRequest[]);
  }, [business?.id, user?.id]);

  useEffect(() => {
    void loadProducts();
    void loadMine();
  }, [loadProducts, loadMine]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.name.toLowerCase().includes(q));
  }, [products, search]);

  const productName = useCallback(
    (id: string) => products.find((p) => p.id === id)?.name ?? "Product",
    [products],
  );

  const isOwner = role === "owner";

  const openDialog = (p: ProductLite) => {
    setTarget(p);
    setKind("add");
    setQty("1");
    setReason("");
    setOpen(true);
  };

  const submit = async () => {
    if (!business?.id || !user?.id || !target) return;
    const amount = Math.floor(Number(qty));
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({ variant: "destructive", title: "Enter a quantity of 1 or more" });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("stock_adjustment_requests").insert({
        business_id: business.id,
        product_id: target.id,
        variant_id: null,
        requested_by: user.id,
        requester_name: user.email ?? null,
        adjustment_type: kind,
        quantity: amount,
        reason: reason.trim() || null,
      });
      if (error) throw error;
      toast({
        title: "Sent for approval",
        description: `${target.name}: ${kind === "add" ? "+" : "-"}${amount}. The owner has to approve it before stock changes.`,
      });
      setOpen(false);
      void loadMine();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Could not send request",
        description: e instanceof Error ? e.message : "Check your connection and try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  if (!permLoading && !canAdjustStock) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="max-w-sm w-full text-center">
          <CardContent className="p-6 space-y-3">
            <Boxes className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="font-medium">Stock changes are off for your account</p>
            <p className="text-sm text-muted-foreground">
              Ask the owner to turn on &quot;Stock access&quot; for you in Settings, then try again.
            </p>
            <Button variant="outline" className="w-full" onClick={() => navigate("/pos")}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Back to POS
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="bg-card border-b border-border px-4 py-4 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/pos")} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="font-display font-bold text-lg flex items-center gap-2">
              <Boxes className="h-5 w-5" /> Stock
            </h1>
            <p className="text-xs text-muted-foreground">
              {role === "cashier" ? "Changes need owner approval" : "Send a request to apply the change"}
            </p>
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products"
            className="pl-9"
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Products</CardTitle>
            <CardDescription>Tap a product to add or remove stock</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <p className="text-sm text-muted-foreground p-4 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4">
                {products.length === 0 ? "No products yet." : "No product matches that search."}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        In stock: <span className="font-medium text-foreground">{p.stock ?? 0}</span>
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => openDialog(p)}>
                      <PackagePlus className="h-4 w-4 mr-1" /> {isOwner ? "Adjust" : "Add stock"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {mine.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">My recent requests</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {mine.map((r) => {
                  const badge =
                    r.status === "approved" ? (
                      <Badge className="bg-green-500/20 text-green-700 dark:text-green-400 border-green-500/30">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Approved
                      </Badge>
                    ) : r.status === "rejected" ? (
                      <Badge className="bg-red-500/20 text-red-700 dark:text-red-400 border-red-500/30">
                        <XCircle className="h-3 w-3 mr-1" /> Rejected
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        <Clock className="h-3 w-3 mr-1" /> Waiting
                      </Badge>
                    );
                  return (
                    <li key={r.id} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{productName(r.product_id)}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.adjustment_type === "add" ? "+" : "-"}
                          {r.quantity} • {new Date(r.created_at).toLocaleString()}
                        </p>
                      </div>
                      {badge}
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{target?.name}</DialogTitle>
            <DialogDescription>
              Currently {target?.stock ?? 0} in stock. The owner approves before anything changes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={kind === "add" ? "pos" : "outline"}
                onClick={() => setKind("add")}
                aria-pressed={kind === "add"}
              >
                <Plus className="h-4 w-4 mr-1" /> Add
              </Button>
              {isOwner ? (
                <Button
                  type="button"
                  variant={kind === "remove" ? "destructive" : "outline"}
                  onClick={() => setKind("remove")}
                  aria-pressed={kind === "remove"}
                >
                  <Minus className="h-4 w-4 mr-1" /> Remove
                </Button>
              ) : (
                <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground text-center">
                  Add only
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="stock-qty">Quantity</Label>
              <Input
                id="stock-qty"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="stock-reason">Reason (optional)</Label>
              <Input
                id="stock-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={kind === "add" ? "Delivery from supplier" : "Damaged / expired"}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="pos" onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <PackagePlus className="h-4 w-4 mr-1" />}
              Send request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default StockRequests;

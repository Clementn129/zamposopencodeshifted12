import { useState } from "react";
import { Plus, Pencil, Trash2, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { Product } from "@/hooks/useProducts";

type Props = {
  parent: Product;
  variants: Product[];
  onChanged: () => void | Promise<void>;
  disabled?: boolean;
};

const VariantsManager = ({ parent, variants, onChanged, disabled }: Props) => {
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [price, setPrice] = useState(String(parent.price ?? 0));
  const [stock, setStock] = useState("0");
  const [costPrice, setCostPrice] = useState(parent.costPrice ? String(parent.costPrice) : "");
  const [barcode, setBarcode] = useState("");
  const [saving, setSaving] = useState(false);

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editStock, setEditStock] = useState("");
  const [editCostPrice, setEditCostPrice] = useState("");
  const [editBarcode, setEditBarcode] = useState("");

  const resetForm = () => {
    setLabel("");
    setPrice(String(parent.price ?? 0));
    setStock("0");
    setCostPrice(parent.costPrice ? String(parent.costPrice) : "");
    setBarcode("");
  };

  const startEdit = (v: Product) => {
    setEditingId(v.id);
    setEditLabel(v.variantLabel ?? "");
    setEditPrice(String(v.price ?? 0));
    setEditStock(String(v.stock ?? 0));
    setEditCostPrice(v.costPrice ? String(v.costPrice) : "");
    setEditBarcode(v.barcode ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = async (id: string) => {
    if (!editLabel.trim()) {
      toast({ variant: "destructive", title: "Variant label required" });
      return;
    }
    const priceN = Number(editPrice);
    if (!Number.isFinite(priceN) || priceN <= 0) {
      toast({ variant: "destructive", title: "Invalid price" });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("products").update({
        variant_label: editLabel.trim(),
        price: priceN,
        stock: Number(editStock) || 0,
        cost_price: editCostPrice.trim() ? Number(editCostPrice) : null,
        barcode: editBarcode.trim() || null,
      }).eq("id", id).eq("business_id", parent.businessId);
      if (error) throw error;
      setEditingId(null);
      await onChanged();
      toast({ title: "Variant updated" });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed",
        description: e instanceof Error ? e.message : "Could not update variant.",
      });
    } finally {
      setSaving(false);
    }
  };

  const addVariant = async () => {
    if (!label.trim()) {
      toast({ variant: "destructive", title: "Variant label required", description: "e.g. 500ml, Large, Red" });
      return;
    }
    const priceN = Number(price);
    if (!Number.isFinite(priceN) || priceN <= 0) {
      toast({ variant: "destructive", title: "Invalid price" });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("products").insert({
        business_id: parent.businessId,
        parent_id: parent.id,
        variant_label: label.trim(),
        name: parent.name,
        price: priceN,
        cost_price: costPrice.trim() ? Number(costPrice) : null,
        stock: Number(stock) || 0,
        minimum_stock: parent.minimumStock ?? 5,
        category: parent.category,
        tax_category: parent.taxCategory,
        image_url: parent.imagePath,
        barcode: barcode.trim() || null,
        item_type: parent.itemType,
        is_active: true,
      });
      if (error) throw error;
      resetForm();
      await onChanged();
      toast({ title: "Variant added" });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed",
        description: e instanceof Error ? e.message : "Could not add variant.",
      });
    } finally {
      setSaving(false);
    }
  };

  const removeVariant = async (id: string) => {
    try {
      const { error } = await supabase.from("products").update({ is_active: false }).eq("id", id).eq("business_id", parent.businessId);
      if (error) throw error;
      await onChanged();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed",
        description: e instanceof Error ? e.message : "Could not remove.",
      });
    }
  };

  return (
    <div className="border rounded-lg p-3 space-y-3 bg-muted/30">
      <div>
        <p className="text-sm font-medium">Variants</p>
        <p className="text-xs text-muted-foreground">
          When a product has variants (e.g. 500ml / 1L / 2L), only the variants are sold from the POS. The parent becomes a grouping label.
        </p>
      </div>

      {variants.length > 0 && (
        <div className="space-y-1.5">
          {variants.map((v) => (
            <div key={v.id}>
              {editingId === v.id ? (
                <div className="bg-background rounded-md border p-2 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Label</Label>
                      <Input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} className="h-8 text-xs" />
                    </div>
                    <div>
                      <Label className="text-xs">Price</Label>
                      <Input type="number" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} className="h-8 text-xs" />
                    </div>
                    <div>
                      <Label className="text-xs">Stock</Label>
                      <Input type="number" value={editStock} onChange={(e) => setEditStock(e.target.value)} className="h-8 text-xs" />
                    </div>
                    <div>
                      <Label className="text-xs">Cost (opt)</Label>
                      <Input type="number" value={editCostPrice} onChange={(e) => setEditCostPrice(e.target.value)} className="h-8 text-xs" />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Barcode (opt)</Label>
                      <Input value={editBarcode} onChange={(e) => setEditBarcode(e.target.value)} className="h-8 text-xs" />
                    </div>
                  </div>
                  <div className="flex gap-1 justify-end">
                    <Button type="button" variant="ghost" size="sm" onClick={cancelEdit} disabled={saving}>
                      <X className="h-4 w-4" />
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => saveEdit(v.id)} disabled={saving}>
                      <Check className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between bg-background rounded-md px-3 py-2">
                  <div className="text-sm">
                    <span className="font-medium">{v.variantLabel}</span>
                    <span className="text-muted-foreground ml-2">
                      K {(v.price ?? 0).toFixed(2)} • Stock {v.stock ?? 0}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled}
                      onClick={() => startEdit(v)}
                      aria-label={`Edit ${v.variantLabel}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled}
                      onClick={() => removeVariant(v.id)}
                      aria-label={`Remove ${v.variantLabel}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2 space-y-1">
          <Label className="text-xs">Variant label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. 500ml" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Price</Label>
          <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Cost (optional)</Label>
          <Input type="number" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Stock</Label>
          <Input type="number" value={stock} onChange={(e) => setStock(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Barcode (opt)</Label>
          <Input value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="Scan or type" />
        </div>
        <div className="flex items-end">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={disabled || saving}
            onClick={addVariant}
          >
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </div>
      </div>
    </div>
  );
};

export default VariantsManager;

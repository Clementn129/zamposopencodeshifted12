import { useState, useMemo } from "react";
import { ArrowLeft, Plus, Trash2, Save, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Product } from "@/hooks/useProducts";
import { DeliveryNote, DeliveryNoteItem } from "@/hooks/useDeliveryNotes";

interface DeliveryNoteFormProps {
  products: Product[];
  existingNote?: DeliveryNote | null;
  quotationId?: string | null;
  quotationItems?: Array<{ productId: string; productName: string; quantity: number; unitPrice: number; lineTotal: number }> | null;
  quotationCustomer?: { name?: string | null; phone?: string | null } | null;
  onSave: (
    dn: Omit<DeliveryNote, 'id' | 'deliveryNoteNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
    items: DeliveryNoteItem[]
  ) => Promise<void>;
  onCancel: () => void;
}

const DeliveryNoteForm = ({ products, existingNote, quotationId, quotationItems, quotationCustomer, onSave, onCancel }: DeliveryNoteFormProps) => {
  const { toast } = useToast();
  const [customerName, setCustomerName] = useState(existingNote?.customerName || quotationCustomer?.name || "");
  const [customerPhone, setCustomerPhone] = useState(existingNote?.customerPhone || quotationCustomer?.phone || "");
  const [deliveryAddress, setDeliveryAddress] = useState(existingNote?.deliveryAddress || "");
  const [driverName, setDriverName] = useState(existingNote?.driverName || "");
  const [carPlate, setCarPlate] = useState(existingNote?.carPlate || "");
  const [notes, setNotes] = useState(existingNote?.notes || "");
  const [status, setStatus] = useState<DeliveryNote['status']>(existingNote?.status || 'pending');
  const [markComplete, setMarkComplete] = useState(existingNote?.status === 'completed');
  const [items, setItems] = useState<DeliveryNoteItem[]>(existingNote?.items || (quotationItems ?? []));
  const [searchQuery, setSearchQuery] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const filteredProducts = useMemo(() => {
    if (!searchQuery.trim()) return products;
    const q = searchQuery.toLowerCase();
    return products.filter(p => p.name.toLowerCase().includes(q) || (p.category && p.category.toLowerCase().includes(q)));
  }, [products, searchQuery]);

  const addItem = (product: Product) => {
    const existing = items.find(i => i.productId === product.id);
    if (existing) {
      setItems(items.map(i => i.productId === product.id
        ? { ...i, quantity: i.quantity + 1, lineTotal: i.unitPrice * (i.quantity + 1) }
        : i
      ));
    } else {
      setItems([...items, {
        productId: product.id,
        productName: product.name,
        quantity: 1,
        unitPrice: product.price,
        lineTotal: product.price,
      }]);
    }
  };

  const updateItem = (idx: number, updates: Partial<DeliveryNoteItem>) => {
    setItems(prev => prev.map((item, i) => {
      if (i !== idx) return item;
      const updated = { ...item, ...updates };
      updated.lineTotal = updated.unitPrice * updated.quantity;
      return updated;
    }));
  };

  const removeItem = (idx: number) => setItems(prev => prev.filter((_, i) => i !== idx));

  const total = useMemo(() => items.reduce((s, i) => s + i.lineTotal, 0), [items]);

  const handleSave = async () => {
    if (items.length === 0) {
      toast({ variant: 'destructive', title: 'No items', description: 'Add at least one item.' });
      return;
    }
    setIsSaving(true);
    try {
      await onSave({
        customerName: customerName || null,
        customerPhone: customerPhone || null,
        deliveryAddress: deliveryAddress || null,
        driverName: driverName || null,
        carPlate: carPlate || null,
        notes: notes || null,
        status: markComplete ? 'completed' : status,
        quotationId: quotationId || null,
      }, items);
      toast({
        title: 'Delivery note saved',
        description: markComplete
          ? 'Marked complete — stock updated and the sale was recorded.'
          : undefined,
      });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Error', description: e.message });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onCancel}><ArrowLeft className="h-5 w-5" /></Button>
        <h2 className="font-display font-bold text-lg">
          {existingNote ? 'Edit Delivery Note' : 'New Delivery Note'}
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: Products */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Add Products</CardTitle>
            <Input
              placeholder="Search..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="mt-2"
            />
          </CardHeader>
          <CardContent className="max-h-[40vh] overflow-y-auto space-y-1">
            {filteredProducts.map(p => (
              <button key={p.id} onClick={() => addItem(p)} className="w-full text-left bg-secondary rounded-lg p-3 hover:opacity-90 transition">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="font-medium text-sm">{p.name}</p>
                    <p className="text-xs text-muted-foreground">ZMW {p.price.toFixed(2)}</p>
                  </div>
                  <Plus className="h-4 w-4 text-muted-foreground" />
                </div>
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Right: Delivery details */}
        <div className="space-y-4">
          {/* Customer details */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Customer Details</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <Input placeholder="Customer name (optional)" value={customerName} onChange={e => setCustomerName(e.target.value)} />
              <Input placeholder="Phone (optional)" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} />
              <Textarea placeholder="Delivery address" value={deliveryAddress} onChange={e => setDeliveryAddress(e.target.value)} className="h-16" />
            </CardContent>
          </Card>

          {/* Delivery info */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Delivery Info</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Driver name (optional)" value={driverName} onChange={e => setDriverName(e.target.value)} />
                <Input placeholder="Car plate (optional)" value={carPlate} onChange={e => setCarPlate(e.target.value)} />
              </div>
              <Textarea placeholder="Notes (optional)" value={notes} onChange={e => setNotes(e.target.value)} className="h-16" />
            </CardContent>
          </Card>

          {/* Items */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Items ({items.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2 max-h-[35vh] overflow-y-auto">
              {items.length === 0 && <p className="text-sm text-muted-foreground">No items added yet.</p>}
              {items.map((item, idx) => (
                <div key={idx} className="bg-secondary rounded-lg p-3 space-y-2">
                  <div className="flex justify-between items-center">
                    <p className="font-medium text-sm">{item.productName}</p>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeItem(idx)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Qty</Label>
                      <Input type="number" min={1} value={item.quantity} onChange={e => updateItem(idx, { quantity: Math.max(1, Number(e.target.value) || 1) })} className="h-8 text-xs" />
                    </div>
                    <div>
                      <Label className="text-xs">Price</Label>
                      <Input type="number" min={0} step="0.01" value={item.unitPrice} onChange={e => updateItem(idx, { unitPrice: Number(e.target.value) || 0 })} className="h-8 text-xs" />
                    </div>
                    <div>
                      <Label className="text-xs">Total</Label>
                      <p className="h-8 flex items-center text-xs font-medium">ZMW {item.lineTotal.toFixed(2)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Total & Save */}
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="border-t pt-3">
                <div className="flex justify-between font-bold">
                  <span>Total</span>
                  <span className="text-lg">ZMW {total.toFixed(2)}</span>
                </div>
              </div>

              {!existingNote && (
                <button
                  type="button"
                  onClick={() => setMarkComplete(v => !v)}
                  aria-pressed={markComplete}
                  className={`w-full flex items-start gap-3 rounded-lg border p-3 text-left transition ${
                    markComplete
                      ? 'border-success bg-success/10'
                      : 'border-border bg-secondary/50 hover:border-success/60'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                      markComplete
                        ? 'border-success bg-success text-success-foreground'
                        : 'border-muted-foreground/40 bg-background'
                    }`}
                  >
                    {markComplete && <CheckCircle2 className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">Complete</span>
                    <span className="block text-xs text-muted-foreground">
                      Move stock now and record this as a cash sale in Sales History.
                    </span>
                  </span>
                </button>
              )}

              <Button variant="pos" className="w-full" onClick={handleSave} disabled={isSaving}>
                <Save className="h-4 w-4 mr-2" />
                {isSaving ? 'Saving…' : existingNote ? 'Update Delivery Note' : 'Save Delivery Note'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default DeliveryNoteForm;

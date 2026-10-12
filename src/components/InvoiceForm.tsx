import { useState, useMemo } from "react";
import { ArrowLeft, Plus, Trash2, Percent, Save, BadgePercent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Product } from "@/hooks/useProducts";
import { Invoice, InvoiceItem } from "@/hooks/useInvoices";
import { calculateTax, TaxCategory } from "@/lib/tax";

export interface InvoicePrefill {
  quotationId?: string | null;
  deliveryNoteId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  customerTpin?: string | null;
  notes?: string | null;
  items?: Array<{
    productId: string | null;
    productName: string;
    quantity: number;
    unitPrice: number;
    discountType: string | null;
    discountValue: number;
    lineTotal: number;
  }>;
}

const toDateInput = (d: Date): string => {
  const tz = d.getTimezoneOffset();
  return new Date(d.getTime() - tz * 60000).toISOString().slice(0, 10);
};

const defaultDue = (): string => {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return toDateInput(d);
};

interface InvoiceFormProps {
  products: Product[];
  existingInvoice?: Invoice | null;
  prefill?: InvoicePrefill | null;
  businessDetails?: {
    taxMode?: 'none' | 'vat' | 'custom';
    vatRate?: number;
    customTaxName?: string | null;
    customTaxRate?: number | null;
  };
  onSave: (
    inv: Omit<Invoice, 'id' | 'invoiceNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'convertedSaleId'>,
    items: InvoiceItem[]
  ) => Promise<void>;
  onCancel: () => void;
  isService?: boolean;
}

const InvoiceForm = ({ products, existingInvoice, prefill, businessDetails, onSave, onCancel, isService = false }: InvoiceFormProps) => {
  const { toast } = useToast();
  const [customerName, setCustomerName] = useState(existingInvoice?.customerName || prefill?.customerName || "");
  const [customerPhone, setCustomerPhone] = useState(existingInvoice?.customerPhone || prefill?.customerPhone || "");
  const [customerEmail, setCustomerEmail] = useState(existingInvoice?.customerEmail || prefill?.customerEmail || "");
  const [customerTpin, setCustomerTpin] = useState(existingInvoice?.customerTpin || prefill?.customerTpin || "");
  const [notes, setNotes] = useState(existingInvoice?.notes || prefill?.notes || "");
  const [issuedDate, setIssuedDate] = useState(existingInvoice?.issuedDate || toDateInput(new Date()));
  const [dueDate, setDueDate] = useState(existingInvoice?.dueDate || defaultDue());
  const [status, setStatus] = useState<Invoice['status']>(existingInvoice?.status ?? (prefill?.deliveryNoteId ? 'sent' : 'draft'));
  const [globalDiscountType, setGlobalDiscountType] = useState<string | null>(existingInvoice?.discountType || null);
  const [globalDiscountValue, setGlobalDiscountValue] = useState(existingInvoice?.discountValue?.toString() || "");
  const [applyTax, setApplyTax] = useState<boolean>(existingInvoice ? existingInvoice.taxAmount > 0 : (businessDetails?.taxMode ?? 'none') !== 'none');
  const [items, setItems] = useState<InvoiceItem[]>(
    existingInvoice?.items || (prefill?.items?.map(i => ({
      productId: i.productId,
      productName: i.productName || '',
      quantity: Number(i.quantity) || 1,
      unitPrice: Number(i.unitPrice) || 0,
      discountType: i.discountType ?? null,
      discountValue: Number(i.discountValue) || 0,
      lineTotal: Number(i.lineTotal) || 0,
    })) ?? [])
  );
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
        ? { ...i, quantity: i.quantity + 1, lineTotal: calcLineTotal(i.unitPrice, i.quantity + 1, i.discountType, i.discountValue) }
        : i
      ));
    } else {
      setItems([...items, {
        productId: product.id,
        productName: product.name,
        quantity: 1,
        unitPrice: product.price,
        discountType: null,
        discountValue: 0,
        lineTotal: product.price,
      }]);
    }
  };

  const calcLineTotal = (price: number, qty: number, discType: string | null, discVal: number) => {
    const gross = price * qty;
    if (discType === 'percentage') return gross * (1 - discVal / 100);
    if (discType === 'amount') return Math.max(0, gross - discVal);
    return gross;
  };

  const updateItem = (idx: number, updates: Partial<InvoiceItem>) => {
    setItems(prev => prev.map((item, i) => {
      if (i !== idx) return item;
      const updated = { ...item, ...updates };
      updated.lineTotal = calcLineTotal(updated.unitPrice, updated.quantity, updated.discountType, updated.discountValue);
      return updated;
    }));
  };

  const removeItem = (idx: number) => setItems(prev => prev.filter((_, i) => i !== idx));

  const subtotal = useMemo(() => items.reduce((s, i) => s + i.lineTotal, 0), [items]);

  const globalDiscount = useMemo(() => {
    if (!globalDiscountType || !globalDiscountValue) return 0;
    const val = Number(globalDiscountValue) || 0;
    if (globalDiscountType === 'percentage') return subtotal * (val / 100);
    return Math.min(val, subtotal);
  }, [subtotal, globalDiscountType, globalDiscountValue]);

  const base = subtotal - globalDiscount;

  const taxInfo = useMemo(() => {
    if (!applyTax) return null;
    const cfg = {
      taxMode: (businessDetails?.taxMode ?? 'none') as 'none' | 'vat' | 'custom',
      vatRate: businessDetails?.vatRate ?? 16,
      customTaxName: businessDetails?.customTaxName ?? null,
      customTaxRate: businessDetails?.customTaxRate ?? null,
    };
    if (cfg.taxMode === 'none') return null;
    const lines = items.map(i => {
      const p = products.find(pp => pp.id === i.productId);
      const cat: TaxCategory = p?.taxCategory ?? 'taxable';
      const eff = subtotal > 0 ? i.lineTotal - (i.lineTotal / subtotal) * globalDiscount : i.lineTotal;
      return { lineAmount: eff, taxCategory: cat };
    });
    return calculateTax(cfg, lines);
  }, [items, globalDiscount, subtotal, applyTax, products, businessDetails]);

  const taxAmount = taxInfo?.taxAmount ?? 0;
  const total = base;

  const handleSave = async () => {
    if (items.length === 0) {
      toast({ variant: 'destructive', title: 'No items', description: 'Add at least one item.' });
      return;
    }
    const trimmedTpin = customerTpin.trim();
    if (trimmedTpin && !/^\d{10}$/.test(trimmedTpin)) {
      toast({ variant: 'destructive', title: 'Invalid TPIN', description: 'Customer TPIN must be 10 digits.' });
      return;
    }
    setIsSaving(true);
    try {
      await onSave({
        customerName: customerName || null,
        customerPhone: customerPhone || null,
        customerEmail: customerEmail || null,
        customerTpin: trimmedTpin || null,
        subtotal,
        discountType: globalDiscountType,
        discountValue: Number(globalDiscountValue) || 0,
        discountAmount: globalDiscount,
        taxAmount,
        total,
        paymentMethod: existingInvoice?.paymentMethod ?? 'credit',
        status,
        issuedDate,
        dueDate: dueDate || null,
        notes: notes || null,
        quotationId: existingInvoice?.quotationId ?? prefill?.quotationId ?? null,
        deliveryNoteId: existingInvoice?.deliveryNoteId ?? prefill?.deliveryNoteId ?? null,
      }, items.map(i => ({ ...i, lineTotal: Math.round(i.lineTotal * 100) / 100 })));
      toast({ title: 'Invoice saved' });
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
          {existingInvoice ? 'Edit Invoice' : 'New Invoice'}
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: Products */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Add {isService ? 'Services' : 'Products'}</CardTitle>
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

        {/* Right: Invoice details */}
        <div className="space-y-4">
          {/* Customer details */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Bill To (Customer)</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <Input placeholder="Customer name (optional)" value={customerName} onChange={e => setCustomerName(e.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Phone" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} />
                <Input placeholder="Email" value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} />
              </div>
              <Input
                placeholder="Customer TPIN (10 digits, optional)"
                inputMode="numeric"
                maxLength={10}
                value={customerTpin}
                onChange={e => setCustomerTpin(e.target.value.replace(/\D/g, ''))}
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Invoice Date</Label>
                  <Input type="date" value={issuedDate} onChange={e => setIssuedDate(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs">Due Date</Label>
                  <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Status</Label>
                  <Select value={status} onValueChange={(v) => setStatus(v as Invoice['status'])}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="sent">Sent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => setApplyTax(v => !v)}
                    className={`w-full flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${applyTax ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}
                  >
                    <BadgePercent className="h-4 w-4" />
                    {applyTax ? 'Tax applies' : 'No tax'}
                  </button>
                </div>
              </div>
              <Textarea placeholder="Notes / Terms" value={notes} onChange={e => setNotes(e.target.value)} className="h-16" />
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
                  <div className="flex gap-2">
                    <Select value={item.discountType || "none"} onValueChange={v => updateItem(idx, { discountType: v === 'none' ? null : v })}>
                      <SelectTrigger className="w-24 h-7 text-xs"><SelectValue placeholder="Disc." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No disc.</SelectItem>
                        <SelectItem value="percentage">%</SelectItem>
                        <SelectItem value="amount">ZMW</SelectItem>
                      </SelectContent>
                    </Select>
                    {item.discountType && (
                      <Input type="number" min={0} value={item.discountValue || ""} onChange={e => updateItem(idx, { discountValue: Number(e.target.value) || 0 })} className="w-20 h-7 text-xs" placeholder="0" />
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Totals & global discount */}
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <Label className="text-sm flex items-center gap-1"><Percent className="h-3.5 w-3.5" /> Global Discount</Label>
              </div>
              <div className="flex gap-2">
                <Select value={globalDiscountType || "none"} onValueChange={v => setGlobalDiscountType(v === 'none' ? null : v)}>
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="percentage">%</SelectItem>
                    <SelectItem value="amount">ZMW</SelectItem>
                  </SelectContent>
                </Select>
                {globalDiscountType && (
                  <Input type="number" value={globalDiscountValue} onChange={e => setGlobalDiscountValue(e.target.value)} className="flex-1" placeholder="0" />
                )}
              </div>

              <div className="border-t pt-3 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>ZMW {subtotal.toFixed(2)}</span>
                </div>
                {globalDiscount > 0 && (
                  <div className="flex justify-between text-sm text-success">
                    <span>Discount</span>
                    <span>-ZMW {globalDiscount.toFixed(2)}</span>
                  </div>
                )}
                {taxInfo && taxInfo.taxAmount > 0 ? (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{taxInfo.label} (incl.)</span>
                      <span>ZMW {taxInfo.taxAmount.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm text-muted-foreground">
                      <span>Tax-exclusive total</span>
                      <span>ZMW {Math.max(0, total - taxInfo.taxAmount).toFixed(2)}</span>
                    </div>
                  </>
                ) : null}
                <div className="flex justify-between font-bold">
                  <span>Total</span>
                  <span className="text-lg">ZMW {total.toFixed(2)}</span>
                </div>
              </div>

              <Button variant="pos" className="w-full" onClick={handleSave} disabled={isSaving}>
                <Save className="h-4 w-4 mr-2" />
                {isSaving ? 'Saving…' : existingInvoice ? 'Update Invoice' : 'Save Invoice'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default InvoiceForm;
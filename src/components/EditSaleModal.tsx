import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2, RotateCcw, Save, Check, Clock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

type SaleItem = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
};

type Sale = {
  id: string;
  items: SaleItem[];
  subtotal: number;
  total: number;
  paymentMethod: string;
  createdAt: string;
  synced: boolean;
  status?: 'completed' | 'refunded' | 'partially_refunded';
  discountAmount?: number;
};

type EditSaleModalProps = {
  sale: Sale | null;
  businessId?: string;
  onClose: () => void;
  onUpdated: () => void;
};

const EditSaleModal = ({ sale, businessId, onClose, onUpdated }: EditSaleModalProps) => {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [items, setItems] = useState<SaleItem[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [refundItems, setRefundItems] = useState<{ [key: string]: number }>({});

  useEffect(() => {
    if (sale) {
      setItems(sale.items);
      setPaymentMethod(sale.paymentMethod);
      setRefundItems({});
    }
  }, [sale]);

  if (!sale) return null;

  const updateItemQuantity = (idx: number, quantity: number) => {
    setItems(prev => prev.map((item, i) => 
      i === idx ? { ...item, quantity: Math.max(0, quantity) } : item
    ).filter(item => item.quantity > 0));
  };

  const calculateTotals = () => {
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return { subtotal, total: subtotal };
  };

  const handleSave = async () => {
    if (items.length === 0) {
      toast({ variant: 'destructive', title: 'Error', description: 'Sale must have at least one item' });
      return;
    }

    setSaving(true);
    const { subtotal, total } = calculateTotals();

    try {
      const { error } = await supabase
        .from('sales')
        .update({
          items: items as any,
          subtotal,
          total,
          payment_method: paymentMethod,
        })
        .eq('id', sale.id)
        .match(businessId ? { business_id: businessId } : {});

      if (error) throw error;

      toast({ title: 'Sale Updated' });
      onUpdated();
      onClose();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Failed', description: e?.message ?? 'Could not update sale' });
    } finally {
      setSaving(false);
    }
  };

  const handleRefund = async () => {
    const itemsToRefund = Object.entries(refundItems).filter(([_, qty]) => qty > 0);
    
    if (itemsToRefund.length === 0) {
      toast({ variant: 'destructive', title: 'Select items', description: 'Choose items to refund' });
      return;
    }

    // Validate refund quantities
    for (const [productId, qty] of itemsToRefund) {
      const originalItem = sale.items.find(i => i.productId === productId);
      if (originalItem && qty > originalItem.quantity) {
        toast({ variant: 'destructive', title: 'Invalid quantity', description: `Cannot refund more than purchased` });
        return;
      }
    }

    if (!confirm('Refund selected items? Stock will be returned.')) return;

    setRefunding(true);
    try {
      // Calculate new items after refund
      const newItems = sale.items.map(item => {
        const refundQty = refundItems[item.productId] || 0;
        return { ...item, quantity: item.quantity - refundQty };
      }).filter(item => item.quantity > 0);

      // Determine new status
      const isFullRefund = newItems.length === 0;
      const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';

      // Calculate new totals
      const newSubtotal = newItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const newTotal = newSubtotal;

      // Update sale
      const { error: saleError } = await supabase
        .from('sales')
        .update({
          items: newItems as any,
          subtotal: newSubtotal,
          total: newTotal,
          status: newStatus,
        })
        .eq('id', sale.id)
        .match(businessId ? { business_id: businessId } : {});

      if (saleError) throw saleError;

      // Return stock to products
      for (const [productId, qty] of itemsToRefund) {
        if (qty > 0) {
          // Get current stock
          const { data: product } = await supabase
            .from('products')
            .select('stock')
            .eq('id', productId)
            .match(businessId ? { business_id: businessId } : {})
            .maybeSingle();

          if (product) {
            const newStock = Number(product.stock) + qty;
            await supabase
              .from('products')
              .update({ stock: newStock })
              .eq('id', productId)
              .match(businessId ? { business_id: businessId } : {});
          }
        }
      }

      toast({ title: 'Refund Processed', description: 'Stock has been returned' });
      onUpdated();
      onClose();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Failed', description: e?.message ?? 'Could not process refund' });
    } finally {
      setRefunding(false);
    }
  };

  const { subtotal, total } = calculateTotals();
  const status = sale.status || 'completed';

  const getStatusBadge = () => {
    switch (status) {
      case 'refunded':
        return <Badge variant="destructive"><RotateCcw className="h-3 w-3 mr-1" /> Refunded</Badge>;
      case 'partially_refunded':
        return <Badge className="bg-amber-500"><Clock className="h-3 w-3 mr-1" /> Partial Refund</Badge>;
      default:
        return <Badge className="bg-green-500"><Check className="h-3 w-3 mr-1" /> Completed</Badge>;
    }
  };

  return (
    <Dialog open={!!sale} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Edit Sale</DialogTitle>
            {getStatusBadge()}
          </div>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Items</Label>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {items.map((item, idx) => (
                <div key={idx} className="flex items-center justify-between bg-secondary rounded-lg p-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{item.name}</p>
                    <p className="text-xs text-muted-foreground">ZMW {item.price.toFixed(2)} each</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step={1}
                      value={item.quantity}
                      onChange={(e) => updateItemQuantity(idx, parseInt(e.target.value) || 0)}
                      className="w-16 h-8 text-center"
                      disabled={status === 'refunded'}
                    />
                  </div>
                </div>
              ))}
              {items.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  All items refunded.
                </p>
              )}
            </div>
          </div>

          {status === 'completed' && (
            <div className="space-y-2">
              <Label>Payment Method</Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="mobile_money">Mobile Money</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="bg-secondary rounded-lg p-3">
            <div className="flex justify-between text-sm">
              <span>Subtotal</span>
              <span>ZMW {subtotal.toFixed(2)}</span>
            </div>
            {sale.discountAmount && sale.discountAmount > 0 && (
              <div className="flex justify-between text-sm text-green-600">
                <span>Discount</span>
                <span>-ZMW {sale.discountAmount.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-lg mt-1">
              <span>Total</span>
              <span>ZMW {total.toFixed(2)}</span>
            </div>
          </div>

          {/* Refund Section */}
          {status === 'completed' && (
            <div className="border-t pt-4">
              <Label className="mb-2 block">Refund Items (select quantities)</Label>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {sale.items.map((item) => (
                  <div key={item.productId} className="flex items-center justify-between bg-secondary/50 rounded p-2">
                    <span className="text-sm">{item.name} (max: {item.quantity})</span>
                    <Input
                      type="number"
                      min="0"
                      max={item.quantity}
                      value={refundItems[item.productId] || 0}
                      onChange={(e) => setRefundItems(prev => ({
                        ...prev,
                        [item.productId]: Math.min(item.quantity, parseInt(e.target.value) || 0)
                      }))}
                      className="w-16 h-8 text-center"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            {status === 'completed' && (
              <>
                <Button 
                  variant="destructive" 
                  className="flex-1"
                  onClick={handleRefund}
                  disabled={saving || refunding}
                >
                  {refunding ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <RotateCcw className="h-4 w-4 mr-2" /> Refund
                    </>
                  )}
                </Button>
                <Button 
                  variant="pos" 
                  className="flex-1"
                  onClick={handleSave}
                  disabled={saving || refunding || items.length === 0}
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" /> Save
                    </>
                  )}
                </Button>
              </>
            )}
            {status !== 'completed' && (
              <Button variant="outline" className="w-full" onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default EditSaleModal;

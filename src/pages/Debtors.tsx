import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, Plus, Users, DollarSign, Check, Clock, Trash2, Search, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ConnectionStatus from '@/components/ConnectionStatus';
import OfflineBanner from '@/components/OfflineBanner';
import LockScreen from '@/components/LockScreen';
import { useAuthContext } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useProducts } from '@/hooks/useProducts';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { cacheDebtors, getCachedDebtors, updateCachedDebtor, generateOfflineId, updateCachedProductStock, queuePendingOp, saveOfflineSale, markSaleAsSynced } from '@/lib/offlineStorage';

type Debtor = {
  id: string;
  saleId: string | null;
  customerName: string;
  customerPhone: string | null;
  amountOwed: number;
  amountPaid: number;
  status: 'unpaid' | 'partially_paid' | 'paid';
  notes: string | null;
  createdAt: string;
  linkedItems?: Array<{ productId: string; name: string; price: number; quantity: number }>;
};

type CreditCartLine = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  stock: number;
};

type DebtorPayment = {
  id: string;
  amount: number;
  paymentDate: string;
  notes: string | null;
};

const Debtors = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isLoading: authLoading } = useAuthContext();
  const { business, isLoading: bizLoading, refetch: refetchBusiness, checkSubscriptionStatus } = useBusiness(user?.id);
  const { isLocked } = checkSubscriptionStatus();
  const { isOnline } = useOnlineStatus();

  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [selectedDebtor, setSelectedDebtor] = useState<Debtor | null>(null);
  const [payments, setPayments] = useState<DebtorPayment[]>([]);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('unpaid');

  // Add debtor form
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const { activeProducts, isLoading: productsLoading } = useProducts(business?.id);
  const [productSearch, setProductSearch] = useState('');
  const [creditCart, setCreditCart] = useState<CreditCartLine[]>([]);

  // Payment form
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [authLoading, user, navigate]);

  const fetchDebtors = async () => {
    if (!business?.id) return;
    setLoading(true);
    try {
      if (isOnline) {
        const { data, error } = await supabase
          .from('debtors')
          .select('*')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(1000);

        if (error) throw error;

        // Batch fetch linked sale items
        const saleIds = (data || []).map(d => d.sale_id).filter(Boolean);
        const saleItemsMap: Record<string, Array<{ productId: string; name: string; price: number; quantity: number }>> = {};
        if (saleIds.length > 0) {
          const { data: salesData } = await supabase
            .from('sales')
            .select('id, items')
            .in('id', saleIds);
          if (salesData) {
            for (const s of salesData) {
              if (s.items && Array.isArray(s.items)) {
                saleItemsMap[s.id] = s.items.map((i: any) => ({
                  productId: i.productId || i.product_id,
                  name: i.name,
                  price: Number(i.price || 0),
                  quantity: Number(i.quantity || 0),
                }));
              }
            }
          }
        }

        const mappedDebtors = (data || []).map((d: any) => ({
          id: d.id,
          saleId: d.sale_id || null,
          customerName: d.customer_name,
          customerPhone: d.customer_phone,
          amountOwed: Number(d.amount_owed),
          amountPaid: Number(d.amount_paid),
          status: d.status as 'unpaid' | 'partially_paid' | 'paid',
          notes: d.notes,
          createdAt: d.created_at,
          linkedItems: d.sale_id ? (saleItemsMap[d.sale_id] || []) : undefined,
        }));
        setDebtors(mappedDebtors);

        // Cache for offline use
        await cacheDebtors(mappedDebtors.map(d => ({
          id: d.id,
          businessId: business.id,
          customerName: d.customerName,
          customerPhone: d.customerPhone,
          amountOwed: d.amountOwed,
          amountPaid: d.amountPaid,
          status: d.status,
          notes: d.notes,
          createdAt: d.createdAt,
        })));
      } else {
        // Use cached data when offline
        const cached = await getCachedDebtors(business.id);
        setDebtors(cached.map(d => ({
          id: d.id,
          saleId: null,
          customerName: d.customerName,
          customerPhone: d.customerPhone,
          amountOwed: d.amountOwed,
          amountPaid: d.amountPaid,
          status: d.status as 'unpaid' | 'partially_paid' | 'paid',
          notes: d.notes,
          createdAt: d.createdAt,
        })));
      }
    } catch (e) {
      console.error('Failed to fetch debtors:', e);
      // Fallback to cache on error
      try {
        const cached = await getCachedDebtors(business.id);
        setDebtors(cached.map(d => ({
          id: d.id,
          saleId: null,
          customerName: d.customerName,
          customerPhone: d.customerPhone,
          amountOwed: d.amountOwed,
          amountPaid: d.amountPaid,
          status: d.status as 'unpaid' | 'partially_paid' | 'paid',
          notes: d.notes,
          createdAt: d.createdAt,
        })));
      } catch {
        // ignore
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchPayments = async (debtorId: string) => {
    try {
      if (!isOnline) {
        setPayments([]);
        return;
      }
      const { data, error } = await supabase
        .from('debtor_payments')
        .select('*')
        .eq('debtor_id', debtorId)
        .order('payment_date', { ascending: false })
        .limit(100);

      if (error) throw error;

      setPayments((data || []).map((p: any) => ({
        id: p.id,
        amount: Number(p.amount),
        paymentDate: p.payment_date,
        notes: p.notes,
      })));
    } catch (e) {
      console.error('Failed to fetch payments:', e);
      setPayments([]);
    }
  };

  useEffect(() => {
    if (business?.id) {
      fetchDebtors();
    }
  }, [business?.id, isOnline]);

  const resetAddForm = () => {
    setCustomerName('');
    setCustomerPhone('');
    setDueDate('');
    setNotes('');
    setProductSearch('');
    setCreditCart([]);
  };

  const addToCreditCart = (productId: string) => {
    const p = activeProducts.find(x => x.id === productId);
    if (!p) return;
    // Fail closed: only an explicit `false` lets stock go below zero, and
    // trackStock === false means a quick-added item that is not counted yet.
    const blockOnStock = business?.preventNegativeStock !== false;
    setCreditCart(prev => {
      const existing = prev.find(l => l.productId === productId);
      if (existing) {
        const nextQty = existing.quantity + 1;
        if (blockOnStock && p.itemType !== 'service' && p.trackStock !== false && nextQty > (p.stock ?? 0)) {
          return prev;
        }
        return prev.map(l => l.productId === productId ? { ...l, quantity: nextQty } : l);
      }
      if (blockOnStock && p.itemType !== 'service' && p.trackStock !== false && p.stock <= 0) return prev;
      return [...prev, { productId, name: p.variantLabel ? `${p.name} · ${p.variantLabel}` : p.name, price: p.price ?? 0, quantity: 1, stock: p.stock ?? 0 }];
    });
  };

  const updateCartQty = (productId: string, delta: number) => {
    setCreditCart(prev => {
      const line = prev.find(l => l.productId === productId);
      if (!line) return prev;
      const nextQty = line.quantity + delta;
      if (nextQty <= 0) return prev.filter(l => l.productId !== productId);
      return prev.map(l => l.productId === productId ? { ...l, quantity: nextQty } : l);
    });
  };

  const removeFromCart = (productId: string) => {
    setCreditCart(prev => prev.filter(l => l.productId !== productId));
  };

  const creditCartTotal = useMemo(() =>
    creditCart.reduce((s, l) => s + l.price * l.quantity, 0),
  [creditCart]);

  const filteredProductsForAdd = useMemo(() => {
    if (!productSearch.trim()) return activeProducts;
    const q = productSearch.toLowerCase();
    return activeProducts.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.category && p.category.toLowerCase().includes(q))
    );
  }, [activeProducts, productSearch]);

  const handleAddDebtor = async () => {
    if (!customerName.trim()) {
      toast({ variant: 'destructive', title: 'Missing fields', description: 'Customer name is required.' });
      return;
    }
    if (creditCart.length === 0) {
      toast({ variant: 'destructive', title: 'No products', description: 'Select at least one product.' });
      return;
    }

    setSaving(true);
    try {
      const now = new Date().toISOString();
      const offlineId = generateOfflineId();
      const items = creditCart.map(l => ({
        productId: l.productId,
        name: l.name,
        price: l.price,
        quantity: l.quantity,
        costPrice: activeProducts.find(x => x.id === l.productId)?.costPrice ?? null,
        discountType: null,
        discountValue: 0,
        notes: null,
        taxCategory: 'taxable' as const,
      }));
      const total = creditCartTotal;

      // OFFLINE-FIRST: persist the sale locally before touching the network so
      // a flaky connection can never lose it. synced:false keeps it retryable.
      await saveOfflineSale({
        id: offlineId,
        businessId: business!.id,
        items,
        subtotal: total,
        total,
        discountAmount: 0,
        discountType: null,
        paymentMethod: 'credit',
        createdAt: now,
        synced: false,
        taxAmount: 0,
        taxableAmount: 0,
        zeroRatedAmount: 0,
        exemptAmount: 0,
        customerName: customerName.trim() || null,
        customerTpin: null,
        customerPhone: customerPhone.trim() || null,
        amountPaid: 0,
        dueDate: dueDate || null,
      } as any);

      for (const line of creditCart) {
        const p = activeProducts.find(x => x.id === line.productId);
        if (p) {
          // Quick-added items are not counted until someone enters a real stock.
          if (p.trackStock === false) continue;
          const nextStock = Number(p.stock ?? 0) - line.quantity;
          await updateCachedProductStock(
            line.productId,
            business?.preventNegativeStock === false ? nextStock : Math.max(0, nextStock),
          );
        }
      }

      if (isOnline) {
        let returnedSaleId: string | null = null;
        try {
          const { data: rid, error: saleErr } = await (supabase.rpc as any)('sync_offline_sale', {
            p_business_id: business!.id,
            p_offline_id: offlineId,
            p_items: items,
            p_subtotal: total,
            p_total: total,
            p_discount_amount: 0,
            p_discount_type: null,
            p_payment_method: 'credit',
            p_created_at: now,
            p_tax_amount: 0,
            p_taxable_amount: 0,
            p_zero_rated_amount: 0,
            p_exempt_amount: 0,
            p_customer_name: customerName.trim(),
            p_customer_tpin: null,
            p_amount_paid: 0,
            p_due_date: dueDate || null,
            p_customer_phone: customerPhone.trim() || null,
          });
          if (saleErr) throw saleErr;
          returnedSaleId = (rid as string | null) ?? null;
          await markSaleAsSynced(offlineId);

          const { error: debtorErr } = await supabase.from('debtors').insert({
            business_id: business!.id,
            sale_id: returnedSaleId,
            customer_name: customerName.trim(),
            customer_phone: customerPhone.trim() || null,
            amount_owed: total,
            amount_paid: 0,
            status: 'unpaid',
            notes: notes.trim() || null,
          });

          if (debtorErr) throw debtorErr;

          toast({ title: 'Credit Sale Recorded', description: `ZMW ${total.toFixed(2)} — stock deducted.` });
          setAddOpen(false);
          setCreditCart([]);
          setCustomerName('');
          setCustomerPhone('');
          setDueDate('');
          setNotes('');
          resetAddForm();
          if (business?.id) {
            await fetchDebtors();
          }
          return;
        } catch (e) {
          console.warn('Immediate credit sale sync failed — queuing for retry:', e);
          returnedSaleId = null;
        }
      }

      // Online-but-push-failed, or offline: queue the debtor (and linked sale)
      // so it is created exactly once when the connection recovers.
      {
        const tempDebtorId = generateOfflineId();
        await cacheDebtors([...(await getCachedDebtors(business!.id)), {
          id: tempDebtorId,
          businessId: business!.id,
          customerName: customerName.trim(),
          customerPhone: customerPhone.trim() || null,
          amountOwed: total,
          amountPaid: 0,
          status: 'unpaid',
          notes: notes.trim() || null,
          createdAt: now,
        }]);

        await queuePendingOp({
          id: generateOfflineId(),
          businessId: business!.id,
          type: 'debtor_create',
          payload: {
            offlineId,
            items,
            total,
            customerName: customerName.trim(),
            customerPhone: customerPhone.trim() || null,
            notes: notes.trim() || null,
            dueDate: dueDate || null,
            createdAt: now,
          },
          createdAt: now,
        });

        toast({ title: 'Saved Offline', description: 'Credit sale will sync when online.' });
      }

      setAddOpen(false);
      resetAddForm();
      await fetchDebtors();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Failed', description: e?.message ?? 'Could not create credit sale' });
    } finally {
      setSaving(false);
    }
  };

  const openPaymentDialog = async (debtor: Debtor) => {
    setSelectedDebtor(debtor);
    setPaymentAmount('');
    setPaymentNotes('');
    await fetchPayments(debtor.id);
    setPayOpen(true);
  };

  const handleRecordPayment = async () => {
    if (!selectedDebtor || !paymentAmount) {
      toast({ variant: 'destructive', title: 'Missing amount' });
      return;
    }

    const amount = Number(paymentAmount);
    const remaining = selectedDebtor.amountOwed - selectedDebtor.amountPaid;

    if (amount > remaining) {
      toast({ variant: 'destructive', title: 'Amount exceeds balance', description: `Maximum: ZMW ${remaining.toFixed(2)}` });
      return;
    }

    setSaving(true);
    try {
      const newAmountPaid = selectedDebtor.amountPaid + amount;
      const newStatus = newAmountPaid >= selectedDebtor.amountOwed ? 'paid' : 'partially_paid';

      if (isOnline) {
        // Insert payment record
        const { error: payError } = await supabase.from('debtor_payments').insert({
          debtor_id: selectedDebtor.id,
          amount,
          notes: paymentNotes.trim() || null,
        });

        if (payError) throw payError;

        // Update debtor
        const { error: updateError } = await supabase
          .from('debtors')
          .update({ amount_paid: newAmountPaid, status: newStatus })
          .eq('id', selectedDebtor.id);

        if (updateError) throw updateError;

        // If this debtor has a linked sale, also update the sale's payment status
        const { data: debtorData } = await supabase
          .from('debtors')
          .select('sale_id')
          .eq('id', selectedDebtor.id)
          .maybeSingle();

        if (debtorData?.sale_id) {
          try {
            const { data: saleRow } = await supabase
              .from('sales')
              .select('amount_paid, total')
              .eq('id', debtorData.sale_id)
              .maybeSingle();

            if (saleRow) {
              const currentPaid = Number(saleRow.amount_paid || 0);
              const newSalePaid = Math.min(currentPaid + amount, Number(saleRow.total || 0));

              await supabase.from('sale_payments').insert({
                sale_id: debtorData.sale_id,
                business_id: business!.id,
                amount,
                payment_method: 'cash',
                notes: 'Payment via debtors',
                recorded_by: user!.id,
              });

              await supabase
                .from('sales')
                .update({ amount_paid: newSalePaid })
                .eq('id', debtorData.sale_id);
            }
          } catch (e: any) {
            console.error('Failed to update linked sale payment:', e);
          }
        }
      } else {
        // Offline: update local cache and queue for sync
        const cached = await getCachedDebtors(business!.id);
        const idx = cached.findIndex((d) => d.id === selectedDebtor.id);
        if (idx >= 0) {
          cached[idx].amountPaid = newAmountPaid;
          cached[idx].status = newStatus;
          await cacheDebtors(cached);
        }

        await queuePendingOp({
          id: generateOfflineId(),
          businessId: business!.id,
          type: 'debtor_payment',
          payload: {
            debtorId: selectedDebtor.id,
            amount,
            notes: paymentNotes.trim() || null,
            userId: user!.id,
          },
          createdAt: new Date().toISOString(),
        });

        toast({ title: 'Saved Offline', description: 'Payment will sync when online.' });
      }

      setPayOpen(false);
      await fetchDebtors();
      // Notify sales history to refresh
      window.dispatchEvent(new CustomEvent('zampos:sale-payment-changed'));
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Failed', description: e?.message ?? 'Could not record payment' });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteDebtor = async (debtor: Debtor) => {
    if (!confirm("Delete this debtor record? If there was a linked sale, stock will be restored.")) return;

    try {
      if (!isOnline) {
        await queuePendingOp({
          id: generateOfflineId(),
          businessId: business!.id,
          type: 'debtor_delete',
          payload: { id: debtor.id },
          createdAt: new Date().toISOString(),
        });
        setDebtors(prev => prev.filter(d => d.id !== debtor.id));
        toast({ title: 'Deletion queued', description: 'Debtor will be deleted and stock restored when online.' });
        return;
      }

      // Find if there's a linked sale to restore stock
      const { data: debtorData } = await supabase
        .from('debtors')
        .select('sale_id')
        .eq('id', debtor.id)
        .maybeSingle();

      if (debtorData?.sale_id) {
        // Get the sale items to restore stock
        const { data: saleData } = await supabase
          .from('sales')
          .select('items')
          .eq('id', debtorData.sale_id)
          .maybeSingle();

        if (saleData?.items && Array.isArray(saleData.items)) {
          const items = saleData.items as any[];
          const productIds = [...new Set(items.map((i: any) => i.productId).filter(Boolean))];
          if (productIds.length > 0) {
            const { data: products } = await supabase
              .from('products')
              .select('id, stock')
              .in('id', productIds);
            if (products) {
              const stockMap = Object.fromEntries(products.map((p: any) => [p.id, Number(p.stock ?? 0)]));
              const updates = items
                .map((item: any) => item.productId && stockMap[item.productId] !== undefined
                  ? supabase.from('products').update({ stock: stockMap[item.productId] + (item.quantity || 0) }).eq('id', item.productId)
                  : null
                ).filter(Boolean);
              await Promise.all(updates);
            }
          }
        }

        // Also delete the linked sale
        await supabase.from('sales').delete().eq('id', debtorData.sale_id);
      }

      // Delete all payments for this debtor
      await supabase.from('debtor_payments').delete().eq('debtor_id', debtor.id);

      // Delete the debtor record
      const { error } = await supabase.from('debtors').delete().eq('id', debtor.id);
      if (error) throw error;

      toast({ title: 'Debtor Deleted', description: 'Stock has been restored if applicable.' });
      await fetchDebtors();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Failed', description: e?.message ?? 'Could not delete debtor' });
    }
  };

  const filteredDebtors = useMemo(() => {
    if (activeTab === 'all') return debtors;
    return debtors.filter(d => d.status === activeTab);
  }, [debtors, activeTab]);

  const stats = useMemo(() => {
    const totalOwed = debtors.reduce((sum, d) => sum + d.amountOwed, 0);
    const totalPaid = debtors.reduce((sum, d) => sum + d.amountPaid, 0);
    const outstanding = totalOwed - totalPaid;
    const unpaidCount = debtors.filter(d => d.status !== 'paid').length;
    return { totalOwed, totalPaid, outstanding, unpaidCount };
  }, [debtors]);

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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'paid':
        return <Badge className="bg-green-500"><Check className="h-3 w-3 mr-1" /> Paid</Badge>;
      case 'partially_paid':
        return <Badge className="bg-amber-500"><Clock className="h-3 w-3 mr-1" /> Partial</Badge>;
      default:
        return <Badge variant="destructive"><Clock className="h-3 w-3 mr-1" /> Unpaid</Badge>;
    }
  };

  return (
    <>
      <ConnectionStatus />
      <OfflineBanner isOnline={isOnline} message="Offline mode - Changes saved locally and sync when online" />
      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-4 py-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard')}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="font-display font-bold text-lg flex items-center gap-2">
                  <Users className="h-5 w-5" /> Debtors
                </h1>
                <p className="text-xs text-muted-foreground">{isOnline ? 'Online' : 'Offline (changes sync when online)'}</p>
              </div>
            </div>

            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button variant="pos" size="sm">
                  <Plus className="h-4 w-4 mr-2" /> Add
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>New Credit Sale</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Customer Name</Label>
                    <Input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="John Doe" />
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 space-y-2">
                      <Label>Phone (optional)</Label>
                      <Input value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="+260..." />
                    </div>
                    <div className="w-36 space-y-2">
                      <Label>Due Date</Label>
                      <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
                    </div>
                  </div>

                  {/* Product selection */}
                  <div className="border rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Package className="h-4 w-4" /> Products on Credit
                    </div>
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        className="pl-8"
                        placeholder="Search products..."
                        value={productSearch}
                        onChange={e => setProductSearch(e.target.value)}
                      />
                    </div>
                    <div className="max-h-32 overflow-y-auto space-y-1">
                      {productsLoading ? (
                        <p className="text-xs text-muted-foreground py-2 text-center">Loading products...</p>
                      ) : filteredProductsForAdd.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2 text-center">No products found</p>
                      ) : (
                        filteredProductsForAdd.map(p => {
                          const inCart = creditCart.find(l => l.productId === p.id);
                          return (
                            <div key={p.id} className="flex items-center justify-between py-1 px-1 rounded hover:bg-secondary cursor-pointer" onClick={() => addToCreditCart(p.id)}>
                              <div className="text-sm">
                                <span>{p.variantLabel ? `${p.name} · ${p.variantLabel}` : p.name}</span>
                                <span className="text-muted-foreground ml-2">ZMW {Number(p.price).toFixed(2)}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {p.itemType !== 'service' && (
                                  <span className={`text-xs ${Number(p.stock) <= 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                                    {Number(p.stock)} left
                                  </span>
                                )}
                                {inCart && <Badge className="bg-green-500 text-xs">{inCart.quantity}</Badge>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Credit cart */}
                  {creditCart.length > 0 && (
                    <div className="border rounded-lg p-3 space-y-2">
                      <div className="text-sm font-medium">Selected Items</div>
                      {creditCart.map(line => (
                        <div key={line.productId} className="flex items-center justify-between bg-secondary rounded p-2 text-sm">
                          <div className="flex-1 min-w-0">
                            <p className="truncate">{line.name}</p>
                            <p className="text-muted-foreground">ZMW {line.price.toFixed(2)} × {line.quantity}</p>
                          </div>
                          <div className="flex items-center gap-1 ml-2">
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => updateCartQty(line.productId, -1)}>
                              -
                            </Button>
                            <span className="w-6 text-center font-medium">{line.quantity}</span>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => updateCartQty(line.productId, 1)}>
                              +
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => removeFromCart(line.productId)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ))}
                      <div className="text-right font-bold pt-1">
                        Total: ZMW {creditCartTotal.toFixed(2)}
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label>Notes (optional)</Label>
                    <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Details about the credit..." />
                  </div>
                  <Button variant="pos" className="w-full" onClick={handleAddDebtor} disabled={saving || creditCart.length === 0}>
                    {saving ? 'Processing...' : `Record Credit Sale`}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </header>

        <main className="p-4 max-w-4xl mx-auto space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground">Outstanding</p>
                <p className="text-xl font-display font-bold text-destructive">ZMW {stats.outstanding.toFixed(2)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground">Collected</p>
                <p className="text-xl font-display font-bold text-green-600">ZMW {stats.totalPaid.toFixed(2)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground">Total Credit</p>
                <p className="text-xl font-display font-bold">ZMW {stats.totalOwed.toFixed(2)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground">Unpaid</p>
                <p className="text-xl font-display font-bold">{stats.unpaidCount}</p>
              </CardContent>
            </Card>
          </div>

          {/* Debtors List */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Credit Customers</CardTitle>
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                  <TabsTrigger value="unpaid">Unpaid</TabsTrigger>
                  <TabsTrigger value="partially_paid">Partial</TabsTrigger>
                  <TabsTrigger value="paid">Paid</TabsTrigger>
                  <TabsTrigger value="all">All</TabsTrigger>
                </TabsList>
              </Tabs>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground text-center py-4">Loading...</p>
              ) : filteredDebtors.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No debtors in this category.</p>
              ) : (
                <div className="space-y-2">
                  {filteredDebtors.map(debtor => (
                    <div key={debtor.id} className="bg-secondary rounded-lg p-3">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="font-medium">{debtor.customerName}</p>
                          <p className="text-xs text-muted-foreground">
                            {debtor.customerPhone || 'No phone'} • {format(new Date(debtor.createdAt), 'MMM d, yyyy')}
                          </p>
                          {debtor.notes && <p className="text-xs text-muted-foreground mt-1">{debtor.notes}</p>}
                        </div>
                        {getStatusBadge(debtor.status)}
                      </div>

                      {/* Linked products */}
                      {debtor.linkedItems && debtor.linkedItems.length > 0 && (
                        <div className="mb-2 space-y-0.5">
                          {debtor.linkedItems.map((item, idx) => (
                            <div key={idx} className="text-xs text-muted-foreground flex justify-between">
                              <span>{item.quantity}× {item.name}</span>
                              <span>ZMW {(item.price * item.quantity).toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        <div className="text-sm">
                          <span className="text-muted-foreground">Owed: </span>
                          <span className="font-bold">ZMW {debtor.amountOwed.toFixed(2)}</span>
                          <span className="text-muted-foreground"> | Paid: </span>
                          <span className="text-green-600">ZMW {debtor.amountPaid.toFixed(2)}</span>
                          <span className="text-muted-foreground"> | Balance: </span>
                          <span className="text-destructive font-bold">ZMW {(debtor.amountOwed - debtor.amountPaid).toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {debtor.status !== 'paid' && (
                            <Button variant="outline" size="sm" onClick={() => openPaymentDialog(debtor)}>
                              <DollarSign className="h-4 w-4 mr-1" /> Pay
                            </Button>
                          )}
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            onClick={() => handleDeleteDebtor(debtor)} 
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </main>

        {/* Payment Dialog */}
        <Dialog open={payOpen} onOpenChange={setPayOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Record Payment - {selectedDebtor?.customerName}</DialogTitle>
            </DialogHeader>
            {selectedDebtor && (
              <div className="space-y-4">
                <div className="bg-secondary rounded-lg p-3">
                  <div className="flex justify-between text-sm">
                    <span>Total Owed</span>
                    <span>ZMW {selectedDebtor.amountOwed.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Already Paid</span>
                    <span className="text-green-600">ZMW {selectedDebtor.amountPaid.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-lg mt-1">
                    <span>Balance</span>
                    <span className="text-destructive">ZMW {(selectedDebtor.amountOwed - selectedDebtor.amountPaid).toFixed(2)}</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Payment Amount (ZMW)</Label>
                  <Input
                    type="number"
                    value={paymentAmount}
                    onChange={e => setPaymentAmount(e.target.value)}
                    placeholder="0.00"
                    max={selectedDebtor.amountOwed - selectedDebtor.amountPaid}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Notes (optional)</Label>
                  <Textarea value={paymentNotes} onChange={e => setPaymentNotes(e.target.value)} placeholder="Payment details..." />
                </div>

                <Button variant="pos" className="w-full" onClick={handleRecordPayment} disabled={saving}>
                  {saving ? 'Recording...' : 'Record Payment'}
                </Button>

                {payments.length > 0 && (
                  <div className="mt-4">
                    <p className="text-sm font-medium mb-2">Payment History</p>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {payments.map(p => (
                        <div key={p.id} className="flex justify-between text-sm bg-secondary rounded p-2">
                          <span>{format(new Date(p.paymentDate), 'MMM d, yyyy')}</span>
                          <span className="font-medium text-green-600">ZMW {p.amount.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
};

export default Debtors;

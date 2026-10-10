import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { generateOfflineId, queuePendingOp, cacheInvoices, getCachedInvoices } from '@/lib/offlineStorage';
import { openCashDrawerIfEnabled } from '@/lib/cashDrawer';

export interface InvoiceItem {
  id?: string;
  productId: string | null;
  productName: string;
  quantity: number;
  unitPrice: number;
  discountType: string | null;
  discountValue: number;
  lineTotal: number;
}

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'void';

export interface Invoice {
  id: string;
  invoiceNumber: string;
  businessId: string;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  customerTpin: string | null;
  subtotal: number;
  discountType: string | null;
  discountValue: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  status: InvoiceStatus;
  issuedDate: string;
  dueDate: string | null;
  paymentMethod: string | null;
  quotationId: string | null;
  deliveryNoteId: string | null;
  convertedSaleId: string | null;
  notes: string | null;
  offlineId?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  items?: InvoiceItem[];
}

const isUuid = (v: string): boolean => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);

const mapRow = (row: any): Invoice => ({
  id: row.id,
  invoiceNumber: row.invoice_number,
  businessId: row.business_id,
  customerName: row.customer_name,
  customerPhone: row.customer_phone,
  customerEmail: row.customer_email,
  customerTpin: row.customer_tpin ?? null,
  subtotal: Number(row.subtotal),
  discountType: row.discount_type,
  discountValue: Number(row.discount_value),
  discountAmount: Number(row.discount_amount),
  taxAmount: Number(row.tax_amount ?? 0),
  total: Number(row.total),
  status: row.status,
  issuedDate: row.issued_date,
  dueDate: row.due_date,
  paymentMethod: row.payment_method,
  quotationId: row.quotation_id,
  deliveryNoteId: row.delivery_note_id,
  convertedSaleId: row.converted_sale_id,
  notes: row.notes,
  offlineId: row.offline_id ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

const mapItemRow = (row: any): InvoiceItem => ({
  id: row.id,
  productId: row.product_id,
  productName: row.product_name,
  quantity: row.quantity,
  unitPrice: Number(row.unit_price),
  discountType: row.discount_type,
  discountValue: Number(row.discount_value),
  lineTotal: Number(row.line_total),
});

const toCached = (inv: Invoice) => ({
  id: inv.id,
  businessId: inv.businessId,
  invoiceNumber: inv.invoiceNumber,
  offlineId: inv.offlineId ?? null,
  customerName: inv.customerName,
  customerPhone: inv.customerPhone,
  customerEmail: inv.customerEmail,
  customerTpin: inv.customerTpin,
  subtotal: inv.subtotal,
  discountType: inv.discountType,
  discountValue: inv.discountValue,
  discountAmount: inv.discountAmount,
  taxAmount: inv.taxAmount,
  total: inv.total,
  status: inv.status,
  issuedDate: inv.issuedDate,
  dueDate: inv.dueDate,
  paymentMethod: inv.paymentMethod,
  quotationId: inv.quotationId,
  deliveryNoteId: inv.deliveryNoteId,
  convertedSaleId: inv.convertedSaleId,
  notes: inv.notes,
  createdAt: inv.createdAt,
  updatedAt: inv.updatedAt,
  deletedAt: inv.deletedAt,
});

const fromCached = (c: any): Invoice => ({
  id: c.id,
  invoiceNumber: c.invoiceNumber,
  businessId: c.businessId,
  customerName: c.customerName ?? null,
  customerPhone: c.customerPhone ?? null,
  customerEmail: c.customerEmail ?? null,
  customerTpin: c.customerTpin ?? null,
  subtotal: Number(c.subtotal),
  discountType: c.discountType ?? null,
  discountValue: Number(c.discountValue),
  discountAmount: Number(c.discountAmount),
  taxAmount: Number(c.taxAmount ?? 0),
  total: Number(c.total),
  status: c.status as InvoiceStatus,
  issuedDate: c.issuedDate,
  dueDate: c.dueDate ?? null,
  paymentMethod: c.paymentMethod ?? null,
  quotationId: c.quotationId ?? null,
  deliveryNoteId: c.deliveryNoteId ?? null,
  convertedSaleId: c.convertedSaleId ?? null,
  notes: c.notes ?? null,
  offlineId: c.offlineId ?? null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  deletedAt: c.deletedAt ?? null,
});

export function useInvoices(businessId: string | undefined) {
  const { isOnline } = useOnlineStatus();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  const fetchInvoices = useCallback(async () => {
    if (!businessId) { setInvoices([]); setIsLoading(false); return; }
    setIsLoading(true);

    const loadCache = async () => {
      try {
        const cached = await getCachedInvoices(businessId);
        setInvoices(cached.map(fromCached));
      } catch {
        // ignore
      }
    };

    if (!isOnline) {
      await loadCache();
      setIsLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('invoices')
        .select('id, business_id, invoice_number, offline_id, customer_name, customer_phone, customer_email, customer_tpin, subtotal, discount_type, discount_value, discount_amount, tax_amount, total, status, issued_date, due_date, payment_method, quotation_id, delivery_note_id, converted_sale_id, notes, created_at, updated_at, deleted_at')
        .eq('business_id', businessId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      const mapped = (data ?? []).map(mapRow);
      setInvoices(mapped);
      try {
        await cacheInvoices(businessId, mapped.map(toCached));
      } catch {
        // cache write failure is non-fatal
      }
    } catch (e: any) {
      // Network-class failures → serve the offline cache instead of toasting.
      const msg = String(e?.message || '');
      if (/Failed to fetch|NetworkError|load failed|fetch/i.test(msg)) {
        await loadCache();
      } else {
        toast({ variant: 'destructive', title: 'Error', description: msg });
        await loadCache();
      }
    } finally {
      setIsLoading(false);
    }
  }, [businessId, isOnline, toast]);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  const getInvoiceWithItems = async (id: string): Promise<Invoice | null> => {
    if (!businessId) return null;
    const { data: invData, error: invErr } = await supabase
      .from('invoices')
      .select('*')
      .eq('business_id', businessId)
      .or(isUuid(id) ? `id.eq.${id}` : `offline_id.eq.${id}`)
      .maybeSingle();
    if (invErr || !invData) return null;

    const { data: items } = await supabase
      .from('invoice_items')
      .select('*')
      .eq('invoice_id', invData.id)
      .order('created_at', { ascending: true });

    const inv = mapRow(invData);
    inv.items = (items ?? []).map(mapItemRow);
    return inv;
  };

  const createInvoice = async (
    inv: Omit<Invoice, 'id' | 'invoiceNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'convertedSaleId'>,
    items: InvoiceItem[]
  ) => {
    if (!businessId) return null;

    if (!isOnline) {
      const opId = generateOfflineId();
      await queuePendingOp({
        id: opId,
        businessId,
        type: 'invoice_create',
        payload: {
          offlineId: opId,
          header: {
            customer_name: inv.customerName,
            customer_phone: inv.customerPhone,
            customer_email: inv.customerEmail,
            customer_tpin: inv.customerTpin,
            subtotal: inv.subtotal,
            discount_type: inv.discountType,
            discount_value: inv.discountValue,
            discount_amount: inv.discountAmount,
            tax_amount: inv.taxAmount,
            total: inv.total,
            status: inv.status || 'draft',
            issued_date: inv.issuedDate,
            due_date: inv.dueDate,
            notes: inv.notes,
            quotation_id: inv.quotationId,
            delivery_note_id: inv.deliveryNoteId,
          },
          items: items.map(i => ({
            product_id: i.productId,
            product_name: i.productName,
            quantity: i.quantity,
            unit_price: i.unitPrice,
            discount_type: i.discountType,
            discount_value: i.discountValue,
            line_total: i.lineTotal,
          })),
        },
        createdAt: new Date().toISOString(),
      });
      toast({ title: 'Invoice saved offline', description: 'Will sync when connected.' });
      return { id: opId } as any;
    }

    const { data: newId, error } = await (supabase.rpc as any)('create_invoice_with_items', {
      p_business_id: businessId,
      p_header: {
        customer_name: inv.customerName,
        customer_phone: inv.customerPhone,
        customer_email: inv.customerEmail,
        customer_tpin: inv.customerTpin,
        subtotal: inv.subtotal,
        discount_type: inv.discountType,
        discount_value: inv.discountValue,
        discount_amount: inv.discountAmount,
        tax_amount: inv.taxAmount,
        total: inv.total,
        status: inv.status || 'draft',
        issued_date: inv.issuedDate,
        due_date: inv.dueDate,
        notes: inv.notes,
        quotation_id: inv.quotationId,
        delivery_note_id: inv.deliveryNoteId,
      },
      p_items: items.map(i => ({
        product_id: i.productId,
        product_name: i.productName,
        quantity: i.quantity,
        unit_price: i.unitPrice,
        discount_type: i.discountType,
        discount_value: i.discountValue,
        line_total: i.lineTotal,
      })),
    });
    if (error) throw error;

    await fetchInvoices();
    return { id: newId } as any;
  };

  const updateInvoice = async (
    id: string,
    inv: Partial<Invoice>,
    items?: InvoiceItem[]
  ) => {
    if (!businessId) return;
    const updateData: any = {};
    if (inv.customerName !== undefined) updateData.customer_name = inv.customerName;
    if (inv.customerPhone !== undefined) updateData.customer_phone = inv.customerPhone;
    if (inv.customerEmail !== undefined) updateData.customer_email = inv.customerEmail;
    if (inv.customerTpin !== undefined) updateData.customer_tpin = inv.customerTpin;
    if (inv.subtotal !== undefined) updateData.subtotal = inv.subtotal;
    if (inv.discountType !== undefined) updateData.discount_type = inv.discountType;
    if (inv.discountValue !== undefined) updateData.discount_value = inv.discountValue;
    if (inv.discountAmount !== undefined) updateData.discount_amount = inv.discountAmount;
    if (inv.taxAmount !== undefined) updateData.tax_amount = inv.taxAmount;
    if (inv.total !== undefined) updateData.total = inv.total;
    if (inv.status !== undefined) updateData.status = inv.status;
    if (inv.issuedDate !== undefined) updateData.issued_date = inv.issuedDate;
    if (inv.dueDate !== undefined) updateData.due_date = inv.dueDate;
    if (inv.notes !== undefined) updateData.notes = inv.notes;

    if (!isOnline) {
      await queuePendingOp({
        id: generateOfflineId(),
        businessId,
        type: 'invoice_update',
        payload: {
          id,
          header: updateData,
          items: (items ?? []).map(i => ({
            product_id: i.productId,
            product_name: i.productName,
            quantity: i.quantity,
            unit_price: i.unitPrice,
            discount_type: i.discountType,
            discount_value: i.discountValue,
            line_total: i.lineTotal,
          })),
        },
        createdAt: new Date().toISOString(),
      });
      toast({ title: 'Invoice saved offline', description: 'Will sync when connected.' });
      return;
    }

    const realId = isUuid(id) ? id : ((await supabase.from('invoices').select('id').eq('offline_id', id).maybeSingle()).data?.id ?? id);
    const { error } = await supabase.from('invoices').update(updateData).eq('id', realId).eq('business_id', businessId);
    if (error) throw error;

    if (items) {
      await supabase.from('invoice_items').delete().eq('invoice_id', realId);
      if (items.length > 0) {
        const { error: itemsErr } = await supabase.from('invoice_items').insert(
          items.map(i => ({
            invoice_id: realId,
            product_id: i.productId,
            product_name: i.productName,
            quantity: i.quantity,
            unit_price: i.unitPrice,
            discount_type: i.discountType,
            discount_value: i.discountValue,
            line_total: i.lineTotal,
          }))
        );
        if (itemsErr) throw itemsErr;
      }
    }

    await fetchInvoices();
  };

  const updateStatus = async (id: string, status: InvoiceStatus) => {
    if (!businessId) return;

    if (!isOnline) {
      await queuePendingOp({
        id: generateOfflineId(),
        businessId,
        type: 'invoice_status',
        payload: { id, status },
        createdAt: new Date().toISOString(),
      });
      setInvoices(prev => prev.map(i => i.id === id ? { ...i, status } : i));
      toast({ title: 'Status saved offline', description: 'Will sync when connected.' });
      return;
    }

    const { error } = await (supabase.rpc as any)('update_invoice_status', {
      p_invoice_id: id,
      p_status: status,
    });
    if (error) throw error;
    await fetchInvoices();
  };

  const payInvoice = async (id: string, paymentMethod: string = 'cash') => {
    if (!businessId) return null;

    if (!isOnline) {
      await queuePendingOp({
        id: generateOfflineId(),
        businessId,
        type: 'invoice_pay',
        payload: { id, paymentMethod },
        createdAt: new Date().toISOString(),
      });
      setInvoices(prev => prev.map(i => i.id === id ? { ...i, status: 'paid', paymentMethod } : i));
      toast({ title: 'Invoice payment saved offline', description: 'Sale will be created when connected.' });
      if (paymentMethod === 'cash') openCashDrawerIfEnabled();
      return null;
    }

    const { data: saleId, error } = await (supabase.rpc as any)('pay_invoice', {
      p_invoice_id: id,
      p_payment_method: paymentMethod,
    });
    if (error) throw error;
    if (paymentMethod === 'cash') openCashDrawerIfEnabled();
    await fetchInvoices();
    return saleId as string;
  };

  const softDeleteInvoice = async (id: string) => {
    if (!businessId) return;
    if (!isOnline) {
      await queuePendingOp({
        id: generateOfflineId(),
        businessId,
        type: 'invoice_delete',
        payload: { id },
        createdAt: new Date().toISOString(),
      });
      setInvoices(prev => prev.filter(i => i.id !== id));
      toast({ title: 'Invoice deleted offline', description: 'Will sync when connected.' });
      return;
    }
    const realId = isUuid(id) ? id : ((await supabase.from('invoices').select('id').eq('business_id', businessId).eq('offline_id', id).maybeSingle()).data?.id ?? id);
    const { error } = await supabase.from('invoices')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', realId)
      .eq('business_id', businessId);
    if (error) throw error;
    await fetchInvoices();
  };

  return {
    invoices,
    isLoading,
    fetchInvoices,
    getInvoiceWithItems,
    createInvoice,
    updateInvoice,
    updateStatus,
    payInvoice,
    softDeleteInvoice,
  };
}
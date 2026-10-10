import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { generateOfflineId, queuePendingOp } from '@/lib/offlineStorage';

export interface QuotationItem {
  id?: string;
  productId: string | null;
  productName: string;
  quantity: number;
  unitPrice: number;
  discountType: string | null;
  discountValue: number;
  lineTotal: number;
}

export interface Quotation {
  id: string;
  quotationNumber: string;
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
  status: 'draft' | 'sent' | 'approved' | 'rejected' | 'expired' | 'converted';
  notes: string | null;
  expiryDate: string | null;
  convertedSaleId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  items?: QuotationItem[];
}

const mapRow = (row: any): Quotation => ({
  id: row.id,
  quotationNumber: row.quotation_number,
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
  notes: row.notes,
  expiryDate: row.expiry_date,
  convertedSaleId: row.converted_sale_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

const mapItemRow = (row: any): QuotationItem => ({
  id: row.id,
  productId: row.product_id,
  productName: row.product_name,
  quantity: row.quantity,
  unitPrice: Number(row.unit_price),
  discountType: row.discount_type,
  discountValue: Number(row.discount_value),
  lineTotal: Number(row.line_total),
});

export function useQuotations(businessId: string | undefined) {
  const { isOnline } = useOnlineStatus();
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  const fetchQuotations = useCallback(async () => {
    if (!businessId) { setQuotations([]); setIsLoading(false); return; }
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('quotations')
        .select('id, business_id, quotation_number, customer_name, customer_phone, customer_email, customer_tpin, subtotal, discount_type, discount_value, discount_amount, tax_amount, total, status, notes, expiry_date, converted_sale_id, created_at, updated_at, deleted_at')
        .eq('business_id', businessId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      setQuotations((data ?? []).map(mapRow));
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Error', description: e.message });
    } finally {
      setIsLoading(false);
    }
  }, [businessId, toast]);

  useEffect(() => { fetchQuotations(); }, [fetchQuotations]);

  const getQuotationWithItems = async (id: string): Promise<Quotation | null> => {
    if (!businessId) return null;
    const { data: qData, error: qErr } = await supabase
      .from('quotations')
      .select('*')
      .eq('id', id)
      .eq('business_id', businessId)
      .single();
    if (qErr || !qData) return null;

    const { data: items } = await supabase
      .from('quotation_items')
      .select('*')
      .eq('quotation_id', id)
      .order('created_at', { ascending: true });

    const q = mapRow(qData);
    q.items = (items ?? []).map(mapItemRow);
    return q;
  };

  const generateNumber = async (): Promise<string> => {
    if (!businessId) return 'QT-0000-0001';
    const { data, error } = await supabase.rpc('generate_quotation_number', { biz_id: businessId });
    if (error) throw error;
    return data as string;
  };

  const createQuotation = async (
    q: Omit<Quotation, 'id' | 'quotationNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'convertedSaleId'>,
    items: QuotationItem[]
  ) => {
    if (!businessId) return null;

    if (!isOnline) {
      const opId = generateOfflineId();
      await queuePendingOp({
        id: opId,
        businessId,
        type: 'quotation_create',
        payload: {
          header: {
            customer_name: q.customerName,
            customer_phone: q.customerPhone,
            customer_email: q.customerEmail,
            customer_tpin: q.customerTpin,
            subtotal: q.subtotal,
            discount_type: q.discountType,
            discount_value: q.discountValue,
            discount_amount: q.discountAmount,
            tax_amount: q.taxAmount,
            total: q.total,
            status: q.status || 'draft',
            notes: q.notes,
            expiry_date: q.expiryDate,
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
      toast({ title: 'Quotation saved offline', description: 'Will sync when connected.' });
      return { id: opId } as any;
    }

    // Atomic: header + items in one transaction (SECURITY DEFINER RPC).
    // Works for both owners and cashiers.
    const { data: newId, error } = await (supabase.rpc as any)('create_quotation_with_items', {
      p_business_id: businessId,
      p_header: {
        customer_name: q.customerName,
        customer_phone: q.customerPhone,
        customer_email: q.customerEmail,
        customer_tpin: q.customerTpin,
        subtotal: q.subtotal,
        discount_type: q.discountType,
        discount_value: q.discountValue,
        discount_amount: q.discountAmount,
        tax_amount: q.taxAmount,
        total: q.total,
        status: q.status || 'draft',
        notes: q.notes,
        expiry_date: q.expiryDate,
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

    await fetchQuotations();
    return { id: newId } as any;
  };

  const updateQuotation = async (
    id: string,
    q: Partial<Quotation>,
    items?: QuotationItem[]
  ) => {
    if (!businessId) return;
    const updateData: any = {};
    if (q.customerName !== undefined) updateData.customer_name = q.customerName;
    if (q.customerPhone !== undefined) updateData.customer_phone = q.customerPhone;
    if (q.customerEmail !== undefined) updateData.customer_email = q.customerEmail;
    if (q.customerTpin !== undefined) updateData.customer_tpin = q.customerTpin;
    if (q.subtotal !== undefined) updateData.subtotal = q.subtotal;
    if (q.discountType !== undefined) updateData.discount_type = q.discountType;
    if (q.discountValue !== undefined) updateData.discount_value = q.discountValue;
    if (q.discountAmount !== undefined) updateData.discount_amount = q.discountAmount;
    if (q.taxAmount !== undefined) updateData.tax_amount = q.taxAmount;
    if (q.total !== undefined) updateData.total = q.total;
    if (q.status !== undefined) updateData.status = q.status;
    if (q.notes !== undefined) updateData.notes = q.notes;
    if (q.expiryDate !== undefined) updateData.expiry_date = q.expiryDate;

    if (!isOnline) {
      await queuePendingOp({
        id: generateOfflineId(),
        businessId: businessId,
        type: 'quotation_update',
        payload: { id, header: updateData, items: items || [] },
        createdAt: new Date().toISOString(),
      });
      toast({ title: 'Quotation saved offline', description: 'Will sync when connected.' });
      return;
    }

    const { error } = await supabase.from('quotations').update(updateData).eq('id', id).eq('business_id', businessId);
    if (error) throw error;

    if (items) {
      await supabase.from('quotation_items').delete().eq('quotation_id', id);
      if (items.length > 0) {
        const { error: itemsErr } = await supabase.from('quotation_items').insert(
          items.map(i => ({
            quotation_id: id,
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

    await fetchQuotations();
  };

  const softDeleteQuotation = async (id: string) => {
    if (!businessId) return;
    if (!isOnline) {
      await queuePendingOp({
        id: generateOfflineId(),
        businessId: businessId,
        type: 'quotation_delete',
        payload: { id },
        createdAt: new Date().toISOString(),
      });
      setQuotations(prev => prev.filter(q => q.id !== id));
      toast({ title: 'Quotation deleted offline', description: 'Will sync when connected.' });
      return;
    }
    const { error } = await supabase.from('quotations')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('business_id', businessId);
    if (error) throw error;
    await fetchQuotations();
  };

  const convertToSale = async (quotationId: string) => {
    // This returns the quotation data so the POS page can use it
    const q = await getQuotationWithItems(quotationId);
    if (!q || !q.items) throw new Error('Quotation not found');
    return q;
  };

  const markConverted = async (quotationId: string, saleId: string) => {
    if (!businessId) return;
    await supabase.from('quotations').update({
      status: 'converted' as any,
      converted_sale_id: saleId,
    }).eq('id', quotationId).eq('business_id', businessId);
    await fetchQuotations();
  };

  return {
    quotations,
    isLoading,
    fetchQuotations,
    getQuotationWithItems,
    createQuotation,
    updateQuotation,
    softDeleteQuotation,
    convertToSale,
    markConverted,
  };
}

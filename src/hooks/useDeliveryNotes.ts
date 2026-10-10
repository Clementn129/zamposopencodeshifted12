import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { generateOfflineId, queuePendingOp } from '@/lib/offlineStorage';

export interface DeliveryNoteItem {
  id?: string;
  productId: string | null;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface DeliveryNote {
  id: string;
  deliveryNoteNumber: string;
  businessId: string;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  driverName: string | null;
  carPlate: string | null;
  notes: string | null;
  status: 'pending' | 'delivered' | 'invoiced' | 'completed';
  quotationId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  items?: DeliveryNoteItem[];
}

const mapRow = (row: any): DeliveryNote => ({
  id: row.id,
  deliveryNoteNumber: row.delivery_note_number,
  businessId: row.business_id,
  customerName: row.customer_name,
  customerPhone: row.customer_phone,
  deliveryAddress: row.delivery_address,
  driverName: row.driver_name,
  carPlate: row.car_plate,
  notes: row.notes,
  status: row.status,
  quotationId: row.quotation_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

const mapItemRow = (row: any): DeliveryNoteItem => ({
  id: row.id,
  productId: row.product_id,
  productName: row.product_name,
  quantity: row.quantity,
  unitPrice: Number(row.unit_price),
  lineTotal: Number(row.line_total),
});

export function useDeliveryNotes(businessId: string | undefined) {
  const { isOnline } = useOnlineStatus();
  const [deliveryNotes, setDeliveryNotes] = useState<DeliveryNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  const fetchDeliveryNotes = useCallback(async () => {
    if (!businessId) { setDeliveryNotes([]); setIsLoading(false); return; }
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('delivery_notes')
        .select('id, business_id, delivery_note_number, customer_name, customer_phone, delivery_address, driver_name, car_plate, notes, status, quotation_id, created_at, updated_at, deleted_at')
        .eq('business_id', businessId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      setDeliveryNotes((data ?? []).map(mapRow));
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Error', description: e.message });
    } finally {
      setIsLoading(false);
    }
  }, [businessId, toast]);

  useEffect(() => { fetchDeliveryNotes(); }, [fetchDeliveryNotes]);

  const getDeliveryNoteWithItems = async (id: string): Promise<DeliveryNote | null> => {
    if (!businessId) return null;
    const { data: dnData, error: dnErr } = await supabase
      .from('delivery_notes')
      .select('*')
      .eq('id', id)
      .eq('business_id', businessId)
      .single();
    if (dnErr || !dnData) return null;

    const { data: items } = await supabase
      .from('delivery_note_items')
      .select('*')
      .eq('delivery_note_id', id)
      .order('created_at', { ascending: true });

    const dn = mapRow(dnData);
    dn.items = (items ?? []).map(mapItemRow);
    return dn;
  };

  const createDeliveryNote = async (
    dn: Omit<DeliveryNote, 'id' | 'deliveryNoteNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
    items: DeliveryNoteItem[]
  ) => {
    if (!businessId) return null;

    if (!isOnline) {
      const opId = generateOfflineId();
      await queuePendingOp({
        id: opId,
        businessId,
        type: 'delivery_note_create' as any,
        payload: {
          header: {
            customer_name: dn.customerName,
            customer_phone: dn.customerPhone,
            delivery_address: dn.deliveryAddress,
            driver_name: dn.driverName,
            car_plate: dn.carPlate,
            notes: dn.notes,
            status: dn.status || 'pending',
            quotation_id: dn.quotationId,
          },
          items: items.map(i => ({
            product_id: i.productId,
            product_name: i.productName,
            quantity: i.quantity,
            unit_price: i.unitPrice,
            line_total: i.lineTotal,
          })),
        },
        createdAt: new Date().toISOString(),
      });
      toast({ title: 'Delivery note saved offline', description: 'Will sync when connected.' });
      return { id: opId } as any;
    }

    const { data: newId, error } = await (supabase.rpc as any)('create_delivery_note_with_items', {
      p_business_id: businessId,
      p_header: {
        customer_name: dn.customerName,
        customer_phone: dn.customerPhone,
        delivery_address: dn.deliveryAddress,
        driver_name: dn.driverName,
        car_plate: dn.carPlate,
        notes: dn.notes,
        status: dn.status || 'pending',
        quotation_id: dn.quotationId,
      },
      p_items: items.map(i => ({
        product_id: i.productId,
        product_name: i.productName,
        quantity: i.quantity,
        unit_price: i.unitPrice,
        line_total: i.lineTotal,
      })),
    });
    if (error) throw error;

    await fetchDeliveryNotes();
    return { id: newId } as any;
  };

  const updateDeliveryNoteStatus = async (id: string, status: 'pending' | 'delivered') => {
    if (!businessId) return;

    if (!isOnline) {
      await queuePendingOp({
        id: generateOfflineId(),
        businessId,
        type: 'delivery_note_status' as any,
        payload: { id, status },
        createdAt: new Date().toISOString(),
      });
      toast({ title: 'Status saved offline', description: 'Will sync when connected.' });
      return;
    }

    const { error } = await supabase.rpc('update_delivery_note_status' as any, {
      p_delivery_note_id: id,
      p_status: status,
    });
    if (error) throw error;
    await fetchDeliveryNotes();
  };

  const softDeleteDeliveryNote = async (id: string) => {
    if (!businessId) return;
    if (!isOnline) {
      await queuePendingOp({
        id: generateOfflineId(),
        businessId,
        type: 'delivery_note_delete' as any,
        payload: { id },
        createdAt: new Date().toISOString(),
      });
      setDeliveryNotes(prev => prev.filter(dn => dn.id !== id));
      toast({ title: 'Delivery note deleted offline', description: 'Will sync when connected.' });
      return;
    }
    const { error } = await supabase.from('delivery_notes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('business_id', businessId);
    if (error) throw error;
    await fetchDeliveryNotes();
  };

  return {
    deliveryNotes,
    isLoading,
    fetchDeliveryNotes,
    getDeliveryNoteWithItems,
    createDeliveryNote,
    updateDeliveryNoteStatus,
    softDeleteDeliveryNote,
  };
}

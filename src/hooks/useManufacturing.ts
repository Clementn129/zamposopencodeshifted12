import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useToast } from '@/hooks/use-toast';
import {
  checkMaterialSufficiency,
  computeBomUnitCost,
  computeProductionDeltas,
  formatShortfallMessage,
  type BomLine,
  type ProductionStatus,
} from '@/lib/manufacturing';
import {
  generateOfflineId,
  getCachedProducts,
  queuePendingOp,
  updateCachedProductStock,
} from '@/lib/offlineStorage';

type BomItemRow = Database['public']['Tables']['bom_items']['Row'];
type ProductionOrderRow = Database['public']['Tables']['production_orders']['Row'];

export type BomItem = {
  id: string;
  businessId: string;
  finishedProductId: string;
  componentProductId: string;
  quantityRequired: number;
};

export type ProductionOrder = {
  id: string;
  businessId: string;
  productId: string;
  quantityToProduce: number;
  status: ProductionStatus;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** Material cost of one finished unit, snapshotted at completion. */
  unitCost: number;
  /** unitCost * quantityToProduce, snapshotted at completion. */
  totalCost: number;
  /** true when this order was created offline and has not synced yet. */
  pendingSync?: boolean;
};

const mapBom = (row: BomItemRow): BomItem => ({
  id: row.id,
  businessId: row.business_id,
  finishedProductId: row.finished_product_id,
  componentProductId: row.component_product_id,
  quantityRequired: Number(row.quantity_required),
});

const mapOrder = (row: ProductionOrderRow): ProductionOrder => ({
  id: row.id,
  businessId: row.business_id,
  productId: row.product_id,
  quantityToProduce: Number(row.quantity_to_produce),
  status: row.status as ProductionStatus,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  createdAt: row.created_at,
  unitCost: Number(row.unit_cost ?? 0),
  totalCost: Number(row.total_cost ?? 0),
});

export interface UseManufacturing {
  bomItems: BomItem[];
  orders: ProductionOrder[];
  isLoading: boolean;
  loadError: string | null;
  refetch: () => Promise<void>;
  saveBomItem: (finishedProductId: string, componentProductId: string, quantityRequired: number) => Promise<boolean>;
  deleteBomItem: (id: string) => Promise<boolean>;
  startOrder: (productId: string, quantity: number) => Promise<boolean>;
  completeOrder: (orderId: string) => Promise<boolean>;
  cancelOrder: (orderId: string) => Promise<boolean>;
  reverseOrder: (orderId: string) => Promise<boolean>;
}

/**
 * Service hook for the manufacturing / production module.
 *
 * Mirrors the `useIngredients` house pattern (useState/useCallback/useEffect,
 * boolean-returning mutations, window-event refresh). Production completion is
 * atomic server-side via `complete_production_order`; offline it is queued and
 * the cached stock is moved immediately so the UI stays consistent.
 */
export function useManufacturing(businessId?: string, enabled = true): UseManufacturing {
  const { isOnline } = useOnlineStatus();
  const { toast } = useToast();

  const [bomItems, setBomItems] = useState<BomItem[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!businessId || !enabled) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const [bomRes, orderRes] = await Promise.all([
        supabase
          .from('bom_items')
          .select('*')
          .eq('business_id', businessId)
          .order('created_at', { ascending: true }),
        supabase
          .from('production_orders')
          .select('*')
          .eq('business_id', businessId)
          .order('created_at', { ascending: false })
          .limit(500),
      ]);

      if (bomRes.error) {
        console.warn('bom_items load error', bomRes.error.message);
        setLoadError(bomRes.error.message);
      } else {
        setBomItems((bomRes.data ?? []).map(mapBom));
      }

      if (orderRes.error) {
        console.warn('production_orders load error', orderRes.error.message);
        setLoadError(orderRes.error.message);
      } else {
        setOrders((orderRes.data ?? []).map(mapOrder));
      }
    } finally {
      setIsLoading(false);
    }
  }, [businessId, enabled]);

  useEffect(() => {
    if (!businessId || !enabled) return;
    void refetch();
  }, [businessId, enabled, refetch]);

  const notifyChanged = useCallback(() => {
    try {
      window.dispatchEvent(new CustomEvent('zampos:production-changed'));
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new CustomEvent('zampos:products-changed'));
    } catch {
      // ignore
    }
  }, []);

  const saveBomItem = useCallback(
    async (finishedProductId: string, componentProductId: string, quantityRequired: number): Promise<boolean> => {
      if (!businessId) return false;
      try {
        const { error } = await (supabase.rpc as any)('save_bom_item', {
          p_business_id: businessId,
          p_finished_product_id: finishedProductId,
          p_component_product_id: componentProductId,
          p_quantity_required: quantityRequired,
        });
        if (error) throw error;
        await refetch();
        notifyChanged();
        return true;
      } catch (e) {
        toast({
          variant: 'destructive',
          title: 'Could not save BOM item',
          description: e instanceof Error ? e.message : 'Try again',
        });
        return false;
      }
    },
    [businessId, refetch, notifyChanged, toast]
  );

  const deleteBomItem = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const { error } = await (supabase.rpc as any)('delete_bom_item', { p_id: id });
        if (error) throw error;
        setBomItems((prev) => prev.filter((b) => b.id !== id));
        notifyChanged();
        return true;
      } catch (e) {
        toast({
          variant: 'destructive',
          title: 'Could not remove BOM item',
          description: e instanceof Error ? e.message : 'Try again',
        });
        return false;
      }
    },
    [notifyChanged, toast]
  );

  const startOrder = useCallback(
    async (productId: string, quantity: number): Promise<boolean> => {
      if (!businessId || quantity <= 0) return false;

      if (!isOnline) {
        toast({
          variant: 'destructive',
          title: 'Offline',
          description: 'Creating a work order needs a connection. It will be available when you reconnect.',
        });
        return false;
      }

      try {
        const { error } = await (supabase.rpc as any)('start_production_order', {
          p_business_id: businessId,
          p_product_id: productId,
          p_quantity: quantity,
        });
        if (error) throw error;
        await refetch();
        notifyChanged();
        return true;
      } catch (e) {
        toast({
          variant: 'destructive',
          title: 'Could not start work order',
          description: e instanceof Error ? e.message : 'Try again',
        });
        return false;
      }
    },
    [businessId, isOnline, refetch, notifyChanged, toast]
  );

  const completeOrder = useCallback(
    async (orderId: string): Promise<boolean> => {
      if (!businessId) return false;

      const order = orders.find((o) => o.id === orderId);

      if (!isOnline) {
        // Offline: validate against cached stocks, move cached stock, and queue.
        if (!order) return false;
        const [cachedProducts, bomRes] = await Promise.all([
          getCachedProducts(businessId),
          // BOM for the product is already in state.
          Promise.resolve(bomItems.filter((b) => b.finishedProductId === order.productId)),
        ]);

        const stockById = new Map(
          cachedProducts.map((p) => [p.id, { name: p.name, stock: Number(p.stock ?? 0) }])
        );
        const shortfalls = checkMaterialSufficiency(
          bomRes.map((b) => ({ componentProductId: b.componentProductId, quantityRequired: b.quantityRequired })),
          order.quantityToProduce,
          stockById
        );
        if (shortfalls.length > 0) {
          toast({
            variant: 'destructive',
            title: 'Insufficient materials',
            description: formatShortfallMessage(shortfalls),
          });
          return false;
        }

        const deltas = computeProductionDeltas(
          bomRes.map((b) => ({ componentProductId: b.componentProductId, quantityRequired: b.quantityRequired })),
          order.quantityToProduce,
          order.productId
        );
        for (const [productId, delta] of deltas) {
          const current = stockById.get(productId)?.stock ?? 0;
          await updateCachedProductStock(productId, current + delta);
        }

        // Snapshot the material cost from the cached component costs so the
        // offline order shows a cost immediately (the server recomputes its own
        // authoritative value when the queued op replays).
        const costById = new Map<string, number | null | undefined>(
          cachedProducts.map((p) => [p.id, p.costPrice ?? null])
        );
        const unitCost = computeBomUnitCost(
          bomRes.map((b) => ({ componentProductId: b.componentProductId, quantityRequired: b.quantityRequired })),
          costById
        );
        const totalCost = unitCost * order.quantityToProduce;

        const offlineOrderId = generateOfflineId();
        await queuePendingOp({
          id: offlineOrderId,
          businessId,
          type: 'production_complete',
          payload: {
            offlineOrderId,
            serverOrderId: order.id,
            productId: order.productId,
            quantity: order.quantityToProduce,
            unitCost,
            totalCost,
            bom: bomRes.map((b) => ({
              componentProductId: b.componentProductId,
              quantityRequired: b.quantityRequired,
            })),
          },
          createdAt: new Date().toISOString(),
        });

        setOrders((prev) =>
          prev.map((o) =>
            o.id === orderId
              ? {
                  ...o,
                  status: 'COMPLETED',
                  completedAt: new Date().toISOString(),
                  unitCost,
                  totalCost,
                  pendingSync: true,
                }
              : o
          )
        );
        notifyChanged();
        toast({
          title: 'Production completed offline',
          description: 'Stock updated on this device. Will sync when connected.',
        });
        return true;
      }

      try {
        const { error } = await (supabase.rpc as any)('complete_production_order', {
          p_order_id: orderId,
        });
        if (error) throw error;
        await refetch();
        notifyChanged();
        toast({ title: 'Production complete', description: 'Stock updated.' });
        return true;
      } catch (e) {
        toast({
          variant: 'destructive',
          title: 'Insufficient materials',
          description: e instanceof Error ? e.message : 'Could not complete production',
        });
        return false;
      }
    },
    [businessId, isOnline, orders, bomItems, refetch, notifyChanged, toast]
  );

  const cancelOrder = useCallback(
    async (orderId: string): Promise<boolean> => {
      if (!isOnline) {
        toast({
          variant: 'destructive',
          title: 'Offline',
          description: 'Cancelling a work order needs a connection.',
        });
        return false;
      }
      try {
        const { error } = await (supabase.rpc as any)('cancel_production_order', {
          p_order_id: orderId,
        });
        if (error) throw error;
        await refetch();
        notifyChanged();
        return true;
      } catch (e) {
        toast({
          variant: 'destructive',
          title: 'Could not cancel work order',
          description: e instanceof Error ? e.message : 'Try again',
        });
        return false;
      }
    },
    [isOnline, refetch, notifyChanged, toast]
  );

  // Undo a COMPLETED run: adds materials back and removes the finished good.
  const reverseOrder = useCallback(
    async (orderId: string): Promise<boolean> => {
      if (!isOnline) {
        toast({
          variant: 'destructive',
          title: 'Offline',
          description: 'Reversing a completed order needs a connection.',
        });
        return false;
      }
      try {
        const { error } = await (supabase.rpc as any)('reverse_production_order', {
          p_order_id: orderId,
        });
        if (error) throw error;
        await refetch();
        notifyChanged();
        toast({ title: 'Production reversed', description: 'Materials returned, finished good removed.' });
        return true;
      } catch (e) {
        toast({
          variant: 'destructive',
          title: 'Could not reverse order',
          description: e instanceof Error ? e.message : 'Try again',
        });
        return false;
      }
    },
    [isOnline, refetch, notifyChanged, toast]
  );

  return {
    bomItems,
    orders,
    isLoading,
    loadError,
    refetch,
    saveBomItem,
    deleteBomItem,
    startOrder,
    completeOrder,
    cancelOrder,
    reverseOrder,
  };
}

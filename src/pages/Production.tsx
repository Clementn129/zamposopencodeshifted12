import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Factory, Plus, Loader2, Play, CheckCircle2, XCircle, Clock, Boxes, Undo2 } from 'lucide-react';
import { useBusiness } from '@/hooks/useBusiness';
import { useAuthContext } from '@/contexts/AuthContext';
import { useProducts } from '@/hooks/useProducts';
import { useManufacturing, type ProductionOrder } from '@/hooks/useManufacturing';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import BomEditor from '@/components/BomEditor';
import { PRODUCTION_STATUS_LABELS, type ProductionStatus } from '@/lib/manufacturing';

const STATUS_STYLES: Record<ProductionStatus, string> = {
  PENDING: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
  IN_PROGRESS: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  COMPLETED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  CANCELLED: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

const Production = () => {
  const navigate = useNavigate();
  const { business } = useBusiness();
  const { role } = useAuthContext();
  const { products, activeProducts } = useProducts(business?.id);
  const {
    bomItems,
    orders,
    isLoading,
    saveBomItem,
    deleteBomItem,
    startOrder,
    completeOrder,
    cancelOrder,
    reverseOrder,
  } = useManufacturing(business?.id);

  const readOnly = role === 'cashier';

  const [newProductId, setNewProductId] = useState('');
  const [newQty, setNewQty] = useState('1');
  const [creating, setCreating] = useState(false);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  const productById = useMemo(() => {
    const m = new Map(products.map((p) => [p.id, p]));
    return m;
  }, [products]);

  const finishedOptions = useMemo(
    () => activeProducts.filter((p) => ((p as unknown as { productType?: string }).productType ?? 'FINISHED_GOOD') !== 'RAW_MATERIAL'),
    [activeProducts]
  );

  // Products that already have a BOM are the only meaningful work-order targets.
  const produceableOptions = useMemo(() => {
    const withBom = new Set(bomItems.map((b) => b.finishedProductId));
    return finishedOptions.filter((p) => withBom.has(p.id));
  }, [finishedOptions, bomItems]);

  const handleCreate = async () => {
    if (!newProductId) return;
    const quantity = Number(newQty);
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    setCreating(true);
    const ok = await startOrder(newProductId, quantity);
    setCreating(false);
    if (ok) {
      setNewProductId('');
      setNewQty('1');
    }
  };

  const handleComplete = async (order: ProductionOrder) => {
    setBusyOrderId(order.id);
    await completeOrder(order.id);
    setBusyOrderId(null);
  };

  const handleCancel = async (order: ProductionOrder) => {
    setBusyOrderId(order.id);
    await cancelOrder(order.id);
    setBusyOrderId(null);
  };

  const handleReverse = async (order: ProductionOrder) => {
    const product = productById.get(order.productId);
    const name = product?.name ?? 'this product';
    const ok = window.confirm(
      `Reverse this completed run?\n\n` +
        `• ${order.quantityToProduce} × "${name}" will be removed from stock.\n` +
        `• The raw materials will be added back.\n\n` +
        `This cannot be undone. If the finished goods were already sold, reverse will be refused.`
    );
    if (!ok) return;
    setBusyOrderId(order.id);
    await reverseOrder(order.id);
    setBusyOrderId(null);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-4 space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <Factory className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-xl font-bold">Production</h1>
              <p className="text-sm text-muted-foreground">Bill of Materials & work orders</p>
            </div>
          </div>
        </div>

        <Tabs defaultValue="orders">
          <TabsList className="grid grid-cols-2 w-full sm:w-auto">
            <TabsTrigger value="orders">Work Orders</TabsTrigger>
            <TabsTrigger value="bom">Bill of Materials</TabsTrigger>
          </TabsList>

          <TabsContent value="orders" className="space-y-4 mt-4">
            {!readOnly && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Plus className="h-5 w-5 text-primary" /> New Work Order
                  </CardTitle>
                  <CardDescription>Start producing a finished good from its BOM.</CardDescription>
                </CardHeader>
                <CardContent>
                  {produceableOptions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Add a Bill of Materials first — work orders can only target products that have components.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 items-end">
                      <div className="space-y-2">
                        <Label>Finished Good</Label>
                        <Select value={newProductId} onValueChange={setNewProductId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a product" />
                          </SelectTrigger>
                          <SelectContent>
                            {produceableOptions.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2 w-full sm:w-28">
                        <Label>Quantity</Label>
                        <Input
                          type="number"
                          min="1"
                          value={newQty}
                          onChange={(e) => setNewQty(e.target.value)}
                        />
                      </div>
                      <Button onClick={handleCreate} disabled={!newProductId || creating}>
                        {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        <span className="ml-1">Start</span>
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Boxes className="h-5 w-5 text-primary" /> Work Orders
                </CardTitle>
                <CardDescription>
                  {readOnly ? 'Read-only view of production runs.' : 'Start, complete or cancel production runs.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading && orders.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : orders.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">No work orders yet.</p>
                ) : (
                  <div className="rounded-lg border divide-y">
                    {orders.map((o) => {
                      const product = productById.get(o.productId);
                      const isOpen = o.status === 'PENDING' || o.status === 'IN_PROGRESS';
                      const busy = busyOrderId === o.id;
                      return (
                        <div key={o.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-medium truncate">{product?.name ?? 'Unknown product'}</p>
                              <Badge className={STATUS_STYLES[o.status]} variant="secondary">
                                {PRODUCTION_STATUS_LABELS[o.status]}
                              </Badge>
                              {o.pendingSync && (
                                <Badge variant="outline" className="text-[10px]">Pending sync</Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              Qty {o.quantityToProduce}
                              {o.createdAt ? ` · ${new Date(o.createdAt).toLocaleDateString()}` : ''}
                              {o.completedAt ? ` · completed ${new Date(o.completedAt).toLocaleDateString()}` : ''}
                            </p>
                          </div>
                          {!readOnly && isOpen && (
                            <div className="flex items-center gap-2 shrink-0">
                              <Button size="sm" onClick={() => handleComplete(o)} disabled={busy}>
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                <span className="ml-1">Complete</span>
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => handleCancel(o)} disabled={busy}>
                                <XCircle className="h-4 w-4" />
                                <span className="ml-1">Cancel</span>
                              </Button>
                            </div>
                          )}
                          {!readOnly && o.status === 'COMPLETED' && !o.pendingSync && (
                            <div className="flex items-center gap-2 shrink-0">
                              <Button size="sm" variant="outline" onClick={() => handleReverse(o)} disabled={busy}>
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                                <span className="ml-1">Reverse</span>
                              </Button>
                            </div>
                          )}
                          {o.status === 'COMPLETED' && o.pendingSync && (
                            <span className="text-xs text-muted-foreground shrink-0">Sync to reverse</span>
                          )}
                          {isOpen && o.status === 'PENDING' && readOnly && (
                            <Clock className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="bom" className="mt-4">
            <BomEditor
              products={products}
              bomItems={bomItems}
              readOnly={readOnly}
              onSave={saveBomItem}
              onDelete={deleteBomItem}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default Production;

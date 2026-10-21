import { useMemo, useState } from 'react';
import { Plus, Trash2, Loader2, Package, Boxes } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Product } from '@/hooks/useProducts';
import type { BomItem } from '@/hooks/useManufacturing';
import { computeBomUnitCost, wouldCreateBomCycle, PRODUCT_TYPE_LABELS, type ProductType } from '@/lib/manufacturing';

interface Props {
  products: Product[];
  bomItems: BomItem[];
  readOnly: boolean;
  onSave: (finishedProductId: string, componentProductId: string, quantityRequired: number) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}

const productTypeOf = (p: Product): ProductType =>
  ((p as unknown as { productType?: ProductType }).productType ?? 'FINISHED_GOOD');

const BomEditor = ({ products, bomItems, readOnly, onSave, onDelete }: Props) => {
  const [finishedId, setFinishedId] = useState<string>('');
  const [componentId, setComponentId] = useState<string>('');
  const [qty, setQty] = useState<string>('1');
  const [saving, setSaving] = useState(false);

  const activeProducts = useMemo(() => products.filter((p) => p.isActive), [products]);

  // Anything except a raw material can be a finished good / assembly output.
  const finishedOptions = useMemo(
    () => activeProducts.filter((p) => productTypeOf(p) !== 'RAW_MATERIAL'),
    [activeProducts]
  );

  const linesForSelected = useMemo(
    () => bomItems.filter((b) => b.finishedProductId === finishedId),
    [bomItems, finishedId]
  );

  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  // Components can be any other product.
  const componentOptions = useMemo(
    () => activeProducts.filter((p) => p.id !== finishedId),
    [activeProducts, finishedId]
  );

  const unitCost = useMemo(() => {
    const costById = new Map<string, number | null>();
    for (const p of products) costById.set(p.id, p.costPrice);
    return computeBomUnitCost(
      linesForSelected.map((b) => ({ componentProductId: b.componentProductId, quantityRequired: b.quantityRequired })),
      costById
    );
  }, [linesForSelected, products]);

  const handleAdd = async () => {
    if (!finishedId || !componentId) return;
    const quantity = Number(qty);
    if (!Number.isFinite(quantity) || quantity <= 0) return;

    if (
      wouldCreateBomCycle(
        bomItems.map((b) => ({ finishedProductId: b.finishedProductId, componentProductId: b.componentProductId })),
        finishedId,
        componentId
      )
    ) {
      // Surfaces through the hook's toast too, but keep a local short-circuit.
      setSaving(false);
      return;
    }

    setSaving(true);
    const ok = await onSave(finishedId, componentId, quantity);
    setSaving(false);
    if (ok) {
      setComponentId('');
      setQty('1');
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Boxes className="h-5 w-5 text-primary" /> Bill of Materials
          </CardTitle>
          <CardDescription>
            Define the raw materials needed to manufacture one unit of a finished good.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Finished Good</Label>
            <Select value={finishedId} onValueChange={setFinishedId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a finished product" />
              </SelectTrigger>
              <SelectContent>
                {finishedOptions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {finishedOptions.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No finished goods yet. Add a product and set its type to Finished Good.
              </p>
            )}
          </div>

          {finishedId && (
            <>
              {!readOnly && (
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 items-end">
                  <div className="space-y-2">
                    <Label>Raw Material / Component</Label>
                    <Select value={componentId} onValueChange={setComponentId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a component" />
                      </SelectTrigger>
                      <SelectContent>
                        {componentOptions.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                            <span className="text-muted-foreground ml-2">
                              ({PRODUCT_TYPE_LABELS[productTypeOf(p)]})
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2 w-full sm:w-28">
                    <Label>Qty / unit</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.0001"
                      value={qty}
                      onChange={(e) => setQty(e.target.value)}
                    />
                  </div>
                  <Button onClick={handleAdd} disabled={!componentId || saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    <span className="ml-1">Add</span>
                  </Button>
                </div>
              )}

              <div className="rounded-lg border divide-y">
                {linesForSelected.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    No components yet. Add raw materials above.
                  </p>
                ) : (
                  linesForSelected.map((b) => {
                    const comp = productById.get(b.componentProductId);
                    return (
                      <div key={b.id} className="flex items-center justify-between p-3 gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0">
                            <p className="font-medium truncate">{comp?.name ?? 'Unknown product'}</p>
                            <p className="text-xs text-muted-foreground">
                              {b.quantityRequired} per unit
                              {comp ? ` · ${comp.stock} in stock` : ''}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {comp && (
                            <Badge variant="outline" className="hidden sm:inline-flex">
                              {PRODUCT_TYPE_LABELS[productTypeOf(comp)]}
                            </Badge>
                          )}
                          {!readOnly && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => void onDelete(b.id)}
                              aria-label="Remove component"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {linesForSelected.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    Estimated material cost per unit:{' '}
                    <span className="font-medium text-foreground">K{unitCost.toFixed(2)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    When the finished good has no cost price yet, saving this BOM fills it from its
                    materials. A cost you set manually is kept — use “Sync cost from BOM” on the
                    product to refresh it.
                  </p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default BomEditor;

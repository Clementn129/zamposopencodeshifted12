import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Product } from '@/hooks/useProducts';
import {
  cacheProducts,
  generateOfflineId,
  getCachedProducts,
  queuePendingOp,
} from '@/lib/offlineStorage';

interface QuickAddProductProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessId: string;
  isOnline: boolean;
  /** Used for exact-name dedupe — no barcode matching. */
  products: Product[];
  /** Hand the resolved product (existing or new) back so it can go straight into the cart. */
  onResolved: (product: Product) => void;
}

/** The untracked skeleton handed back before the server has confirmed anything. */
const buildProduct = (
  id: string,
  businessId: string,
  name: string,
  price: number,
): Product => ({
  id,
  businessId,
  name,
  price,
  costPrice: null,
  stock: 0,
  minimumStock: 0,
  category: null,
  barcode: null,
  isActive: true,
  itemType: 'product',
  trackStock: false,
  taxCategory: 'taxable',
  imageUrl: null,
  imagePath: null,
  parentId: null,
  variantLabel: null,
});

const QuickAddProduct = ({
  open,
  onOpenChange,
  businessId,
  isOnline,
  products,
  onResolved,
}: QuickAddProductProps) => {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setPrice('');
      setError(null);
      setBusy(false);
      const t = setTimeout(() => nameRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [open]);

  const trimmed = name.trim();
  // Exact name match only — deliberately no barcode, category or fuzzy matching.
  const duplicate = trimmed ? products.find((p) => p.name.trim() === trimmed) : undefined;
  const priceNum = Number(price);
  const priceValid = price.trim() !== '' && Number.isFinite(priceNum) && priceNum >= 0;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;

    if (!trimmed) {
      setError('Enter a name.');
      nameRef.current?.focus();
      return;
    }
    if (!priceValid) {
      setError('Enter a price of 0 or more.');
      return;
    }

    // Already exists -> add the existing item, create nothing.
    if (duplicate) {
      onResolved(duplicate);
      onOpenChange(false);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (isOnline) {
        // Direct INSERT is owner-only (RLS), so cashiers have to go through the
        // member-callable function, which only ever creates an untracked item.
        const { data: newId, error: rpcErr } = await supabase.rpc('quick_add_product', {
          p_business_id: businessId,
          p_name: trimmed,
          p_price: priceNum,
        });
        if (rpcErr) throw rpcErr;
        if (!newId) throw new Error('Product was created but no id came back.');
        onResolved(buildProduct(newId, businessId, trimmed, priceNum));
        onOpenChange(false);
        return;
      }

      // Offline: create locally with a temp id and queue the real insert.
      const tempId = generateOfflineId();
      const existing = await getCachedProducts(businessId);
      await cacheProducts([
        ...existing,
        {
          id: tempId,
          businessId,
          name: trimmed,
          price: priceNum,
          costPrice: null,
          stock: 0,
          minimumStock: 0,
          category: null,
          barcode: null,
          isActive: true,
          taxCategory: 'taxable',
          imageUrl: null,
          imagePath: null,
          parentId: null,
          variantLabel: null,
          trackStock: false,
          trackExpiry: false,
          expiryDate: null,
        },
      ]);
      await queuePendingOp({
        id: generateOfflineId(),
        businessId,
        type: 'product_create',
        payload: {
          tempId,
          // Marks this for replay via quick_add_product instead of a direct insert.
          quickAdd: true,
          name: trimmed,
          price: priceNum,
          cost_price: null,
          stock: 0,
          minimum_stock: 0,
          category: null,
          tax_category: 'taxable',
          barcode: null,
          item_type: 'product',
          track_expiry: false,
          track_stock: false,
          image_url: null,
          expiry_date: null,
        },
        createdAt: new Date().toISOString(),
      });
      onResolved(buildProduct(tempId, businessId, trimmed, priceNum));
      onOpenChange(false);
    } catch (err: unknown) {
      // Supabase throws plain PostgrestError objects, not Error instances.
      const fromObject = typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : undefined;
      const message = err instanceof Error
        ? err.message
        : typeof fromObject === 'string' && fromObject
          ? fromObject
          : 'Could not create the product.';
      setError(message);
      toast({ variant: 'destructive', title: 'Could not create product', description: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Quick sale</DialogTitle>
          <DialogDescription>
            Add an item you have not set up yet. It will not be counted in stock until you enter a
            quantity in Products.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quickadd-name">Name</Label>
            <Input
              id="quickadd-name"
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder="e.g. Airtime K10"
              autoComplete="off"
            />
            {duplicate && (
              <p className="text-xs text-muted-foreground">
                “{duplicate.name}” already exists — it will be added instead of created.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="quickadd-price">Price (ZMW)</Label>
            <Input
              id="quickadd-price"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                if (error) setError(null);
              }}
              placeholder="0.00"
            />
          </div>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={busy}>
              {busy ? 'Adding…' : duplicate ? 'Add item' : 'Create & add'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default QuickAddProduct;

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cacheProducts, getCachedProducts, getUnsyncedSales, getUnsyncedStockUpdates, cacheProductImageBlob, getCachedImageBlob, getCachedImageBlobWithAge, getPendingOps } from "@/lib/offlineStorage";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import type { Database } from "@/integrations/supabase/types";

type ProductRow = Database["public"]["Tables"]["products"]["Row"];
type CachedProduct = Parameters<typeof cacheProducts>[0][number];

export type ItemType = 'product' | 'service';

export type Product = {
  id: string;
  businessId: string;
  name: string;
  price: number;
  costPrice: number | null;
  stock: number;
  minimumStock: number;
  category: string | null;
  barcode: string | null;
  isActive: boolean;
  itemType: ItemType;
  /** true = recipe-based dish; stock comes from ingredients, cost from recipe. */
  isDish: boolean;
  /** false = quick-added item whose stock is not counted yet. */
  trackStock: boolean;
  taxCategory: 'taxable' | 'zero_rated' | 'exempt';
  imageUrl: string | null;
  imagePath: string | null;
  parentId: string | null;
  variantLabel: string | null;
  createdAt?: string;
  updatedAt?: string;
  trackExpiry?: boolean;
  expiryDate?: string | null;
};

const mapRowToProduct = (row: ProductRow): Product => ({
  id: row.id,
  businessId: row.business_id,
  name: row.name,
  price: Number(row.price),
  costPrice: row.cost_price ? Number(row.cost_price) : null,
  stock: Number(row.stock),
  minimumStock: Number(row.minimum_stock ?? 5),
  category: row.category,
  barcode: (row as any).barcode ?? null,
  isActive: row.is_active,
  itemType: (((row as any).item_type ?? 'product') === 'service' ? 'service' : 'product'),
  isDish: (row as any).is_dish === true,
  trackStock: row.track_stock !== false,
  taxCategory: (row.tax_category ?? 'taxable') as Product['taxCategory'],
  imageUrl: null,
  imagePath: (row as any).image_url ?? null,
  parentId: (row as any).parent_id ?? null,
  trackExpiry: (row as any).track_expiry ?? false,
  expiryDate: (row as any).expiry_date ?? null,
  variantLabel: (row as any).variant_label ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapCachedProduct = (p: CachedProduct): Product => ({
  id: p.id,
  businessId: p.businessId,
  createdAt: p.createdAt ?? undefined,
  name: p.name,
  price: Number(p.price ?? 0),
  costPrice: p.costPrice ?? null,
  stock: Number(p.stock ?? 0),
  minimumStock: Number(p.minimumStock ?? 5),
  category: p.category ?? null,
  barcode: (p as any).barcode ?? null,
  trackExpiry: (p as any).trackExpiry ?? false,
  expiryDate: (p as any).expiryDate ?? null,
  isActive: p.isActive !== false,
  itemType: (((p as any).itemType ?? 'product') === 'service' ? 'service' : 'product'),
  isDish: (p as any).isDish === true,
  trackStock: p.trackStock !== false,
  taxCategory: ((p as any).taxCategory ?? 'taxable') as Product['taxCategory'],
  imageUrl: (p as any).imageUrl ?? null,
  imagePath: (p as any).imagePath ?? null,
  parentId: (p as any).parentId ?? null,
  variantLabel: (p as any).variantLabel ?? null,
});

// One deterministic order for products no matter their source. Server rows come
// back newest-first, but IndexedDB returns rows in id order, so without this the
// list reshuffles every time the cache and the server swap in (on mount and on
// every sync-complete refetch). Ties fall back to id so equal timestamps are
// stable, and rows without a timestamp (legacy cache entries) sort last.
const byNewestFirst = (a: Product, b: Product): number => {
  const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
  const aHas = !Number.isNaN(at);
  const bHas = !Number.isNaN(bt);
  if (aHas && bHas) {
    if (at !== bt) return bt - at;
  } else if (aHas !== bHas) {
    return aHas ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const sortProductsNewestFirst = (list: Product[]): Product[] =>
  list.slice().sort(byNewestFirst);

// Resolve product-images storage paths to signed URLs in one round trip.
// We use a 1-year expiry so URLs are effectively permanent for caching/CDN
// purposes — the workspace blocks public buckets, so this is the longest-lived
// option without exposing the bucket.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365; // ~1 year
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const PAGE_SIZE = 100;

// Batch signed URL creation. Supabase caps a single call at a few hundred
// paths and the JSON payload for 20k+ items would be huge; chunking keeps
// each request small and lets us fail-soft on individual chunks.
const SIGNED_URL_CHUNK = 100;

const resolveImageUrls = async (products: Product[]): Promise<Product[]> => {
  const paths = Array.from(
    new Set(products.map((p) => p.imagePath).filter((x): x is string => !!x))
  );
  if (paths.length === 0) return products;

  const urlByPath = new Map<string, string>();
  for (let i = 0; i < paths.length; i += SIGNED_URL_CHUNK) {
    const chunk = paths.slice(i, i + SIGNED_URL_CHUNK);
    try {
      const { data } = await supabase.storage
        .from("product-images")
        .createSignedUrls(chunk, SIGNED_URL_TTL_SECONDS);
      if (data) {
        for (const item of data) {
          if (item.signedUrl && item.path) {
            urlByPath.set(item.path, item.signedUrl);
          }
        }
      }
    } catch {
      // ignore chunk failure — remaining products just render without an image
    }
  }

  if (urlByPath.size === 0) return products;
  return products.map((p) =>
    p.imagePath && urlByPath.has(p.imagePath)
      ? { ...p, imageUrl: urlByPath.get(p.imagePath) ?? null }
      : p
  );
};

// Background-download image blobs for offline viewing with a concurrency limit of 3.
// Runs at low priority after initial render so it never blocks the UI.
const CONCURRENT_BLOB_DOWNLOADS = 3;

const downloadImageBlob = async (path: string, signedUrl: string): Promise<void> => {
  try {
    const cached = await getCachedImageBlobWithAge(path);
    if (cached && (Date.now() - new Date(cached.cachedAt).getTime() < CACHE_MAX_AGE_MS)) return;
    const response = await fetch(signedUrl);
    if (!response.ok) return;
    const blob = await response.blob();
    await cacheProductImageBlob(path, blob);
  } catch {
    // skip silently — image will fall back to signed URL next time
  }
};

// Resolve cached image blobs to object URLs for instant display (no network needed)
const resolveCachedBlobs = async (products: Product[], blobUrlsRef: React.MutableRefObject<string[]>): Promise<{ products: Product[]; hasBlobs: boolean }> => {
  let hasBlobs = false;
  const resolved = await Promise.all(
    products.map(async (p) => {
      if (!p.imagePath) return p;
      try {
        const blob = await getCachedImageBlob(p.imagePath);
        if (!blob) return p;
        hasBlobs = true;
        const url = URL.createObjectURL(blob);
        blobUrlsRef.current.push(url);
        return { ...p, imageUrl: url };
      } catch {
        return p;
      }
    })
  );
  return { products: resolved, hasBlobs };
};

const backgroundCacheImageBlobs = (products: Product[]): void => {
  const toDownload = products.filter((p): p is Product & { imagePath: string; imageUrl: string } =>
    !!p.imagePath && !!p.imageUrl
  );
  if (toDownload.length === 0) return;

  const run = async () => {
    for (let i = 0; i < toDownload.length; i += CONCURRENT_BLOB_DOWNLOADS) {
      const chunk = toDownload.slice(i, i + CONCURRENT_BLOB_DOWNLOADS);
      await Promise.all(chunk.map((p) => downloadImageBlob(p.imagePath, p.imageUrl)));
      // Yield to the event loop between chunks
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  // Defer to idle time or a microtask if requestIdleCallback is not available
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => { run(); });
  } else {
    setTimeout(() => { run(); }, 1000);
  }
};

export function useProducts(businessId: string | undefined) {
  const { isOnline } = useOnlineStatus();
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const blobUrlsRef = useRef<string[]>([]);
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  // Revoke blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, []);

  // POS-facing list: hide parents that have active variants (parent is just a grouping)
  // and always exclude inactive products.
  const activeProducts = useMemo(() => {
    const parentIdsWithVariants = new Set(
      products
        .filter((p) => p.isActive && p.parentId)
        .map((p) => p.parentId as string)
    );
    return products.filter(
      (p) => p.isActive && !parentIdsWithVariants.has(p.id)
    );
  }, [products]);

  const searchProductsServerSide = useCallback(async (
    businessId: string,
    query: string,
    offset: number = 0,
    limit: number = PAGE_SIZE
  ): Promise<{ data: Product[]; total: number }> => {
    try {
      let dbQuery = supabase
        .from("products")
        .select("id, business_id, name, price, cost_price, stock, minimum_stock, category, barcode, track_expiry, track_stock, expiry_date, is_active, tax_category, image_url, parent_id, variant_label, item_type, is_dish, created_at, updated_at", { count: "exact" })
        .eq("business_id", businessId)
        .eq("is_active", true);

      if (query.trim()) {
        const q = query.trim();
        dbQuery = dbQuery.or(`name.ilike.%${q}%,category.ilike.%${q}%,barcode.ilike.%${q}%`);
      }

      const { data, error: fetchError, count } = await dbQuery
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);

      if (fetchError) throw fetchError;
      return { data: (data ?? []).map(mapRowToProduct), total: count ?? 0 };
    } catch (e) {
      console.error("Server-side product search failed:", e);
      return { data: [], total: 0 };
    }
  }, []);

  const refetch = useCallback(async () => {
    if (!businessId) {
      setProducts([]);
      setIsLoading(false);
      return;
    }

    // Revoke previous blob URLs from offline image cache
    blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    blobUrlsRef.current = [];

    setError(null);

    // Show cached products immediately for instant display
    const cached = await getCachedProducts(businessId);
    if (cached.length > 0) {
      const cachedMapped = cached.map(mapCachedProduct);
      setProducts(sortProductsNewestFirst(cachedMapped));
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }

    // If online, fetch fresh data and apply in ONE update
    if (isOnlineRef.current) {
      try {
        const [unsyncedSales, unsyncedStockUpdates, pendingOps] = await Promise.all([
          getUnsyncedSales(businessId),
          getUnsyncedStockUpdates(businessId),
          getPendingOps(businessId),
        ]);

        const hasPendingProductOps = pendingOps.some(op => op.type.startsWith('product_'));
        if (unsyncedSales.length > 0 || unsyncedStockUpdates.length > 0 || hasPendingProductOps) {
          if (cached.length === 0) {
            const retryCached = await getCachedProducts(businessId);
            if (retryCached.length > 0) {
              const rcm = retryCached.map(mapCachedProduct);
              setProducts(sortProductsNewestFirst(rcm));
            }
            setIsLoading(false);
          }
          return;
        }

        const { data, error: fetchError } = await supabase
          .from("products")
          .select("id, business_id, name, price, cost_price, stock, minimum_stock, category, barcode, track_expiry, track_stock, expiry_date, is_active, tax_category, image_url, parent_id, variant_label, item_type, is_dish, created_at, updated_at")
          .eq("business_id", businessId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(25000);

        if (fetchError) throw fetchError;

        const mapped = (data ?? []).map(mapRowToProduct);

        // Resolve signed URLs (network) before updating state — single render
        const withUrls = await resolveImageUrls(mapped);
        // Keep existing imageUrl when available (object URL from cached blobs
        // or signed URL from a prior fetch) to avoid reloading images that
        // already have a working URL.
        setProducts(prev => {
          const prevMap = new Map(prev.map(p => [p.id, p.imageUrl]));
          return sortProductsNewestFirst(withUrls.map(p => ({
            ...p,
            imageUrl: prevMap.get(p.id) ?? p.imageUrl,
          })));
        });
        setIsLoading(false);

        backgroundCacheImageBlobs(withUrls);

        await cacheProducts(
          withUrls.map((p) => ({
            id: p.id,
            businessId: p.businessId,
            createdAt: p.createdAt,
            name: p.name,
            price: p.price,
            costPrice: p.costPrice,
            stock: p.stock,
            minimumStock: p.minimumStock,
            category: p.category,
            barcode: p.barcode,
            trackExpiry: p.trackExpiry,
            trackStock: p.trackStock,
            expiryDate: p.expiryDate,
            isActive: p.isActive,
            itemType: p.itemType,
            isDish: p.isDish,
            taxCategory: p.taxCategory,
            imageUrl: p.imageUrl,
            imagePath: p.imagePath,
            parentId: p.parentId,
            variantLabel: p.variantLabel,
          }) as any)
        );
      } catch (e: unknown) {
        if (cached.length === 0) {
          const msg = e instanceof Error ? e.message : "Failed to load products";
          try {
            const retryCached = businessId ? await getCachedProducts(businessId) : [];
            setProducts(sortProductsNewestFirst(retryCached.map(mapCachedProduct)));
            setError(retryCached.length ? null : msg);
          } catch {
            setError(msg);
          }
          setIsLoading(false);
        }
      }
    } else if (cached.length > 0) {
      // Offline: resolve cached blobs for images (no signed URLs available)
      const cachedMapped = cached.map(mapCachedProduct);
      resolveCachedBlobs(cachedMapped, blobUrlsRef).then(({ products: withBlobs, hasBlobs }) => {
        if (hasBlobs) setProducts(sortProductsNewestFirst(withBlobs));
      });
    } else {
      setError("No internet connection and no cached products");
      setIsLoading(false);
    }
  }, [businessId]);

  // A business/branch change must never leave the previous branch's rows on
  // screen. This is declared BEFORE the refetch effect below so React flushes
  // the clear first — otherwise the POS renders the other branch's catalogue
  // until the (async) replacement lands, which is exactly the reported flash.
  useEffect(() => {
    blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    blobUrlsRef.current = [];
    setProducts([]);
    setIsLoading(true);
    setError(null);
  }, [businessId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refetch();
      }, 2000);
    };
    window.addEventListener("zampos:sync-complete", handler);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("zampos:sync-complete", handler);
    };
  }, [refetch]);

  return {
    products,
    activeProducts,
    isLoading,
    error,
    isOnline,
    refetch,
    searchProductsServerSide,
  };
}

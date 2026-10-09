// Offline storage utilities using IndexedDB and localStorage

const DB_NAME = 'zampos_db';
const DB_VERSION = 13; // Increment when schema changes; must always be > any previously deployed version

// Detect browser's existing DB version to handle downgrade
const getExistingVersion = (): Promise<number> => {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => {
      const version = req.result.version;
      req.result.close();
      resolve(version);
    };
    req.onerror = () => resolve(0);
    req.onupgradeneeded = () => {
      // No upgrade needed just to read the version
      const db = req.result;
      const version = db.version;
      db.close();
      resolve(version);
    };
  });
};

interface OfflineSale {
  id: string;
  businessId: string;
  items: Array<{
    productId: string;
    name: string;
    price: number;
    quantity: number;
    costPrice?: number | null;
    discountType?: string | null;
    discountValue?: number;
    taxCategory?: 'taxable' | 'zero_rated' | 'exempt';
  }>;
  subtotal: number;
  total: number;
  discountAmount?: number;
  discountType?: string | null;
  paymentMethod: string;
  createdAt: string;
  synced: boolean;
  taxAmount?: number;
  taxableAmount?: number;
  zeroRatedAmount?: number;
  exemptAmount?: number;
  customerName?: string | null;
  customerTpin?: string | null;
  customerPhone?: string | null;
  amountPaid?: number;
  dueDate?: string | null;
  tableId?: string | null;
}

interface OfflineStockUpdate {
  id: string;
  productId: string;
  businessId: string;
  stockChange: number; // positive for add, negative for subtract
  createdAt: string;
  /** Optional back-dated occurrence time; absent for normal (now-stamped) changes. */
  effectiveAt?: string | null;
  synced: boolean;
}

interface OfflineProduct {
  id: string;
  businessId: string;
  /** Server created_at (or client time for offline creates). Keeps list order stable. */
  createdAt?: string;
  name: string;
  price: number;
  costPrice: number | null;
  stock: number;
  minimumStock: number;
  category: string | null;
  barcode?: string | null;
  isActive: boolean;
  taxCategory?: 'taxable' | 'zero_rated' | 'exempt';
  imageUrl?: string | null;
  imagePath?: string | null;
  parentId?: string | null;
  variantLabel?: string | null;
  /** false = quick-added item whose stock is not counted yet. */
  trackStock?: boolean;
  trackExpiry?: boolean;
  expiryDate?: string | null;
}

interface SubscriptionCache {
  expiresAt: string;
  status: string;
  lastSyncAt: string;
  isLocked: boolean;
}

interface CachedBusiness {
  id: string;
  name: string;
  paymentCode: string;
  subscriptionStatus: string;
  subscriptionExpiresAt: string | null;
  isLocked: boolean;
  lastSyncAt: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxMode?: 'none' | 'vat' | 'custom';
  vatRate?: number;
  customTaxName?: string | null;
  customTaxRate?: number | null;
  tpin?: string | null;
  logoUrl?: string | null;
  vatNumber?: string | null;
  businessType?: string | null;
  /** Admin-assigned plan label ("1 cashier", etc.); absent on older caches. */
  planTier?: string | null;
  /** Grandfathered monthly price (ZMW); NULL/absent = derive from the tier table. */
  monthlyPriceZmw?: number | null;
  /** Absent on older caches -> must be read as `true` (block negatives). */
  preventNegativeStock?: boolean;
  /** Absent on older caches, and false on unmigrated databases -> CAPEX off. */
  capexEnabled?: boolean;
  /** Allow overriding a line's unit price in the POS cart; absent = off. */
  allowCartPriceEdit?: boolean;
  /** Allow back-dating sales and stock adjustments; absent = off. */
  allowBackdating?: boolean;
  cachedForUser?: string;
  /** Absent on older caches -> tie-break falls back to store key order. */
  lastUsedAt?: number;
}

let dbInstance: IDBDatabase | null = null;

// Maximum number of retries for database operations
const MAX_DB_RETRIES = 3;

// Maximum retries for pending operation sync before marking permanently failed
// Retries are cheap and a transient outage must not strand money/stock ops.
// The manual "retry failed items" action still exists for genuinely rejected ops.
const MAX_RETRIES = 20;

// Initialize IndexedDB with safe version handling
export const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    // Return cached instance if available and open
    if (dbInstance) {
      try {
        if (dbInstance.objectStoreNames.length > 0 && (dbInstance as any).readyState !== 'closing') {
          resolve(dbInstance);
          return;
        }
      } catch {
        dbInstance = null;
      }
      if ((dbInstance as any)?.readyState === 'closing') {
        dbInstance = null;
      }
    }

    tryCreate(DB_VERSION).then(resolve).catch((err) => {
      const msg = String(err?.message || err || '');
      if (/less than the existing|version.*lower/i.test(msg)) {
        // Instead of deleting the entire database (which destroys user data),
        // try to open with the existing version and add missing stores
        console.warn('Database version mismatch. Attempting safe migration...');
        openExistingAndMigrate().then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
};

// Safely open existing database and add any missing object stores
const openExistingAndMigrate = async (): Promise<IDBDatabase> => {
  // First, detect the existing version
  const existingVersion = await getExistingVersion();
  if (existingVersion === 0) {
    // Database doesn't exist, create fresh
    return tryCreate(DB_VERSION);
  }
  
  // Try to open with the higher of existing or current version
  const targetVersion = Math.max(existingVersion, DB_VERSION);
  
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, targetVersion);
    
    request.onerror = () => {
      // If still failing, try opening without version upgrade
      const fallbackReq = indexedDB.open(DB_NAME);
      fallbackReq.onsuccess = () => {
      dbInstance = fallbackReq.result;
      const db = fallbackReq.result;
      db.onversionchange = () => {
        try { db.close(); } catch {}
        dbInstance = null;
      };
      db.onclose = () => {
        if (dbInstance === db) dbInstance = null;
      };
      resolve(db);
    };
    fallbackReq.onerror = () => reject(fallbackReq.error);
  };
  
  request.onsuccess = () => {
    dbInstance = request.result;
    const db = request.result;
    db.onversionchange = () => {
      try { db.close(); } catch {}
      dbInstance = null;
    };
    db.onclose = () => {
      if (dbInstance === db) dbInstance = null;
    };
    resolve(db);
  };
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      // Add any missing stores without deleting existing data
      if (!db.objectStoreNames.contains('sales')) {
        const salesStore = db.createObjectStore('sales', { keyPath: 'id' });
        salesStore.createIndex('synced', 'synced', { unique: false });
        salesStore.createIndex('businessId', 'businessId', { unique: false });
      }
      if (!db.objectStoreNames.contains('products')) {
        const productsStore = db.createObjectStore('products', { keyPath: 'id' });
        productsStore.createIndex('businessId', 'businessId', { unique: false });
      }
      if (!db.objectStoreNames.contains('cart')) {
        db.createObjectStore('cart', { keyPath: 'productId' });
      }
      if (!db.objectStoreNames.contains('cartLines')) {
        db.createObjectStore('cartLines', { keyPath: 'lineId' });
      }
      if (!db.objectStoreNames.contains('stockUpdates')) {
        const stockStore = db.createObjectStore('stockUpdates', { keyPath: 'id' });
        stockStore.createIndex('synced', 'synced', { unique: false });
        stockStore.createIndex('businessId', 'businessId', { unique: false });
        stockStore.createIndex('productId', 'productId', { unique: false });
      }
      if (!db.objectStoreNames.contains('business')) {
        db.createObjectStore('business', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('debtors')) {
        const debtorsStore = db.createObjectStore('debtors', { keyPath: 'id' });
        debtorsStore.createIndex('businessId', 'businessId', { unique: false });
      }
      if (!db.objectStoreNames.contains('offline_users')) {
        db.createObjectStore('offline_users', { keyPath: 'email' });
      }
      if (!db.objectStoreNames.contains('salesCache')) {
        const salesCacheStore = db.createObjectStore('salesCache', { keyPath: 'id' });
        salesCacheStore.createIndex('businessId', 'businessId', { unique: false });
      }
      if (!db.objectStoreNames.contains('expensesCache')) {
        const expensesCacheStore = db.createObjectStore('expensesCache', { keyPath: 'id' });
        expensesCacheStore.createIndex('businessId', 'businessId', { unique: false });
      }
      if (!db.objectStoreNames.contains('debtorPaymentsCache')) {
        const debtorPaymentsCacheStore = db.createObjectStore('debtorPaymentsCache', { keyPath: 'id' });
        debtorPaymentsCacheStore.createIndex('businessId', 'businessId', { unique: false });
      }
      if (!db.objectStoreNames.contains('pendingOps')) {
        const pendingOpsStore = db.createObjectStore('pendingOps', { keyPath: 'id' });
        pendingOpsStore.createIndex('businessId', 'businessId', { unique: false });
        pendingOpsStore.createIndex('type', 'type', { unique: false });
      }
      if (!db.objectStoreNames.contains('productImageBlobs')) {
        db.createObjectStore('productImageBlobs', { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains('pendingImageUploads')) {
        db.createObjectStore('pendingImageUploads', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('cashierLookup')) {
        db.createObjectStore('cashierLookup', { keyPath: 'lookupKey' });
      }
      if (!db.objectStoreNames.contains('invoicesCache')) {
        const invoicesCacheStore = db.createObjectStore('invoicesCache', { keyPath: 'id' });
        invoicesCacheStore.createIndex('businessId', 'businessId', { unique: false });
      }
    };
  });
};

const tryCreate = (version: number): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('sales')) {
        const salesStore = db.createObjectStore('sales', { keyPath: 'id' });
        salesStore.createIndex('synced', 'synced', { unique: false });
        salesStore.createIndex('businessId', 'businessId', { unique: false });
      }

      if (!db.objectStoreNames.contains('products')) {
        const productsStore = db.createObjectStore('products', { keyPath: 'id' });
        productsStore.createIndex('businessId', 'businessId', { unique: false });
      }

      if (!db.objectStoreNames.contains('cart')) {
        db.createObjectStore('cart', { keyPath: 'productId' });
      }
      if (!db.objectStoreNames.contains('cartLines')) {
        db.createObjectStore('cartLines', { keyPath: 'lineId' });
      }

      if (!db.objectStoreNames.contains('stockUpdates')) {
        const stockStore = db.createObjectStore('stockUpdates', { keyPath: 'id' });
        stockStore.createIndex('synced', 'synced', { unique: false });
        stockStore.createIndex('businessId', 'businessId', { unique: false });
        stockStore.createIndex('productId', 'productId', { unique: false });
      }

      if (!db.objectStoreNames.contains('business')) {
        db.createObjectStore('business', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('debtors')) {
        const debtorsStore = db.createObjectStore('debtors', { keyPath: 'id' });
        debtorsStore.createIndex('businessId', 'businessId', { unique: false });
      }

      if (!db.objectStoreNames.contains('offline_users')) {
        db.createObjectStore('offline_users', { keyPath: 'email' });
      }

      if (!db.objectStoreNames.contains('salesCache')) {
        const salesCacheStore = db.createObjectStore('salesCache', { keyPath: 'id' });
        salesCacheStore.createIndex('businessId', 'businessId', { unique: false });
      }

      if (!db.objectStoreNames.contains('expensesCache')) {
        const expensesCacheStore = db.createObjectStore('expensesCache', { keyPath: 'id' });
        expensesCacheStore.createIndex('businessId', 'businessId', { unique: false });
      }

      if (!db.objectStoreNames.contains('debtorPaymentsCache')) {
        const debtorPaymentsCacheStore = db.createObjectStore('debtorPaymentsCache', { keyPath: 'id' });
        debtorPaymentsCacheStore.createIndex('businessId', 'businessId', { unique: false });
      }

      if (!db.objectStoreNames.contains('pendingOps')) {
        const pendingOpsStore = db.createObjectStore('pendingOps', { keyPath: 'id' });
        pendingOpsStore.createIndex('businessId', 'businessId', { unique: false });
        pendingOpsStore.createIndex('type', 'type', { unique: false });
      }

      if (!db.objectStoreNames.contains('productImageBlobs')) {
        db.createObjectStore('productImageBlobs', { keyPath: 'path' });
      }

      if (!db.objectStoreNames.contains('pendingImageUploads')) {
        db.createObjectStore('pendingImageUploads', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('cashierLookup')) {
        db.createObjectStore('cashierLookup', { keyPath: 'lookupKey' });
      }
      if (!db.objectStoreNames.contains('invoicesCache')) {
        const invoicesCacheStore = db.createObjectStore('invoicesCache', { keyPath: 'id' });
        invoicesCacheStore.createIndex('businessId', 'businessId', { unique: false });
      }
    };
  });
};

// Get database instance
const getDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const db = await initDB();
        if ((db as any).readyState === 'closing') {
          dbInstance = null;
          setTimeout(() => attempt().then(resolve).catch(reject), 10);
          return;
        }
        resolve(db);
      } catch (e) {
        reject(e as any);
      }
    };
    attempt();
  });
};

// Sales operations
export const saveOfflineSale = async (sale: OfflineSale): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sales'], 'readwrite');
    const store = transaction.objectStore('sales');
    const request = store.add(sale);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getUnsyncedSales = async (businessId: string): Promise<OfflineSale[]> => {
  if (!businessId) return [];

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sales'], 'readonly');
    const store = transaction.objectStore('sales');
    const request = store.getAll();

    request.onsuccess = () => {
      const sales = request.result.filter((s) => s.synced !== true && s.businessId === businessId);
      resolve(sales);
    };
    request.onerror = () => reject(request.error);
  });
};

export const markSaleAsSynced = async (saleId: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sales'], 'readwrite');
    const store = transaction.objectStore('sales');
    const getRequest = store.get(saleId);

    getRequest.onsuccess = () => {
      const sale = getRequest.result;
      if (sale) {
        sale.synced = true;
        const putRequest = store.put(sale);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      } else {
        resolve();
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
};

// Products cache
export const cacheProducts = async (products: OfflineProduct[]): Promise<void> => {
  if (!Array.isArray(products)) {
    console.error('[offline] cacheProducts: non-array payload, cache left untouched');
    return;
  }
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['products'], 'readwrite');
    const store = transaction.objectStore('products');
    // Replace only the affected business's rows. A wholesale store.clear()
    // would destroy other businesses' cached product lists.
    const index = store.index('businessId');
    const delReq = index.openKeyCursor(IDBKeyRange.only(products[0]?.businessId ?? ''));
    delReq.onerror = () => reject(delReq.error);
    delReq.onsuccess = () => {
      const cursor = delReq.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        products.forEach((product) => {
          store.put(product);
        });
      }
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getCachedProducts = async (businessId: string): Promise<OfflineProduct[]> => {
  if (!businessId) return [];

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['products'], 'readonly');
    const store = transaction.objectStore('products');
    const index = store.index('businessId');
    const request = index.getAll(IDBKeyRange.only(businessId));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const updateCachedProductStock = async (productId: string, newStock: number): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['products'], 'readwrite');
    const store = transaction.objectStore('products');
    const getRequest = store.get(productId);

    getRequest.onsuccess = () => {
      const product = getRequest.result;
      if (product) {
        product.stock = newStock;
        const putRequest = store.put(product);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      } else {
        resolve();
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
};

// Merge server products into the local cache WITHOUT dropping local state.
// Products that have pending local work (unsynced stock updates, unsynced
// sales, pending product ops) keep their local stock — the server hasn't
// caught up yet, and `cacheProducts` would otherwise wipe the offline floor.
export const mergeServerProducts = async (businessId: string, serverProducts: OfflineProduct[]): Promise<void> => {
  if (!businessId) return;

  const [local, stockUpdates, pendingOps, unsyncedSales] = await Promise.all([
    getCachedProducts(businessId),
    getUnsyncedStockUpdates(businessId),
    getPendingOps(businessId),
    getUnsyncedSales(businessId),
  ]);

  const localMap = new Map(local.map((p) => [p.id, p]));
  const locked = new Set<string>();
  for (const u of stockUpdates) locked.add(u.productId);
  for (const op of pendingOps) {
    if (op.type === 'product_create') locked.add((op.payload as any).tempId);
    if (op.type === 'product_update' || op.type === 'product_deactivate') locked.add((op.payload as any).productId);
    if (op.type === 'sale_delete' || op.type === 'debtor_delete') {
      for (const it of ((op.payload as any).items ?? [])) {
        if (it?.productId) locked.add(it.productId);
      }
    }
  }
  for (const s of unsyncedSales) {
    for (const it of ((s as any).items ?? [])) {
      if (it?.productId) locked.add(it.productId);
    }
  }

  const merged: OfflineProduct[] = serverProducts.map((p) => {
    const lp = localMap.get(p.id);
    if (locked.has(p.id) && lp) return { ...p, stock: lp.stock };
    return p;
  });

  // Keep any local products the server pull didn't return — never drop local rows.
  const serverIds = new Set(serverProducts.map((p) => p.id));
  for (const lp of local) {
    if (!serverIds.has(lp.id)) merged.push(lp);
  }

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['products'], 'readwrite');
    const store = transaction.objectStore('products');
    for (const p of merged) store.put(p);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

// Subscription cache using localStorage (simpler for critical data)
export const cacheSubscription = (data: SubscriptionCache): void => {
  localStorage.setItem('zampos_subscription', JSON.stringify({
    ...data,
    cachedAt: new Date().toISOString()
  }));
};

export const getCachedSubscription = (): (SubscriptionCache & { cachedAt: string }) | null => {
  const data = localStorage.getItem('zampos_subscription');
  if (!data) return null;
  return JSON.parse(data);
};

// Anti-tamper: Store server time reference
export const cacheServerTime = (serverTime: Date): void => {
  if (!(serverTime instanceof Date) || Number.isNaN(serverTime.getTime())) return;
  const localTime = new Date();
  const offset = serverTime.getTime() - localTime.getTime();
  localStorage.setItem('zampos_time_offset', offset.toString());
  localStorage.setItem('zampos_last_server_sync', serverTime.toISOString());
};

export const getAdjustedTime = (): Date => {
  const offsetStr = localStorage.getItem('zampos_time_offset');
  if (!offsetStr) return new Date();
  
  const offset = parseInt(offsetStr, 10);
  if (isNaN(offset)) {
    localStorage.removeItem('zampos_time_offset');
    return new Date();
  }
  return new Date(Date.now() + offset);
};

export const getLastServerSync = (): Date | null => {
  const lastSync = localStorage.getItem('zampos_last_server_sync');
  if (!lastSync) return null;
  return new Date(lastSync);
};

// Check if offline too long (35 days max)
export const isOfflineTooLong = (maxDays: number = 35): boolean => {
  const lastSync = getLastServerSync();
  if (!lastSync) return false;

  const now = getAdjustedTime();
  const diffDays = (now.getTime() - lastSync.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > maxDays;
};

// Cart operations
interface CartItem {
  lineId: string;
  /** Owning business. Cart is scoped per business so switching branch can
   *  never surface (and sell) another branch's lines. */
  businessId?: string;
  productId: string;
  name: string;
  price: number;
  quantity: number;
  costPrice?: number | null;
  discountType?: 'percentage' | 'amount' | null;
  discountValue?: number;
  notes?: string;
  taxCategory?: 'taxable' | 'zero_rated' | 'exempt';
  /** Product's catalogue price when the line was added. Differs from `price` only when overridden. */
  catalogPrice?: number;
  modifiers?: Array<{ id: string; groupId: string; name: string; priceAdjustment: number }>;
}

/**
 * Lines are keyed by product + modifier combo (NOT productId alone) so that
 * two lines for the same product with different modifiers stay separate.
 */
export const computeLineId = (productId: string, modifiers?: Array<{ id: string }>): string => {
  const modKey = (modifiers ?? []).map((m) => m.id).sort().join('|') || 'plain';
  return `${productId}::${modKey}`;
};

export const saveCartItem = async (item: CartItem): Promise<void> => {
  const record = item.lineId ? item : { ...item, lineId: computeLineId(item.productId, item.modifiers) };
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['cartLines'], 'readwrite');
    const store = transaction.objectStore('cartLines');
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getCart = async (businessId?: string): Promise<CartItem[]> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['cartLines'], 'readonly');
    const store = transaction.objectStore('cartLines');
    const request = store.getAll();
    request.onsuccess = () => {
      let items = request.result as CartItem[];
      // Scope to a business when asked. Legacy lines with no businessId are
      // dropped rather than risk selling them under the wrong branch.
      if (businessId) items = items.filter((item) => item.businessId === businessId);
      resolve(items.map((item) => (item.lineId ? item : { ...item, lineId: computeLineId(item.productId, item.modifiers) })));
    };
    request.onerror = () => reject(request.error);
  });
};

export const clearCart = async (businessId?: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['cartLines'], 'readwrite');
    const store = transaction.objectStore('cartLines');
    if (!businessId) {
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      return;
    }
    const cursorReq = store.openKeyCursor();
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        const getReq = store.get(cursor.primaryKey);
        getReq.onsuccess = () => {
          const item = getReq.result as CartItem | undefined;
          if (item?.businessId === businessId) store.delete(cursor.primaryKey);
          cursor.continue();
        };
        getReq.onerror = () => reject(getReq.error);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const removeCartItem = async (lineId: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['cartLines'], 'readwrite');
    const store = transaction.objectStore('cartLines');
    const request = store.delete(lineId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

// Stock update operations for offline mode
export const saveOfflineStockUpdate = async (update: OfflineStockUpdate): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['stockUpdates'], 'readwrite');
    const store = transaction.objectStore('stockUpdates');
    const request = store.add(update);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getUnsyncedStockUpdates = async (businessId: string): Promise<OfflineStockUpdate[]> => {
  if (!businessId) return [];

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['stockUpdates'], 'readonly');
    const store = transaction.objectStore('stockUpdates');
    const request = store.getAll();

    request.onsuccess = () => {
      const updates = request.result.filter((u) => u.synced !== true && u.businessId === businessId);
      resolve(updates);
    };
    request.onerror = () => reject(request.error);
  });
};

export const markStockUpdateAsSynced = async (updateId: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['stockUpdates'], 'readwrite');
    const store = transaction.objectStore('stockUpdates');
    const getRequest = store.get(updateId);

    getRequest.onsuccess = () => {
      const update = getRequest.result;
      if (update) {
        update.synced = true;
        const putRequest = store.put(update);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      } else {
        resolve();
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
};

// Generate unique offline ID
export const generateOfflineId = (): string => {
  return `offline_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Business cache operations.
// The store is keyed by business id and holds one entry per cached business.
// Entries are tagged with the user they were cached for (`cachedForUser`) so
// offline sign-in always restores the right business for the signed-in account
// instead of whoever logged in last. Writes are upserts — we never clear the
// store, so a failed write can never wipe an existing cached business.
export const cacheBusiness = async (business: CachedBusiness, userId?: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['business'], 'readwrite');
    const store = transaction.objectStore('business');
    const request = store.put({
      ...business,
      cachedForUser: userId || undefined,
      lastUsedAt: Date.now(),
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getCachedBusinessById = async (businessId: string): Promise<CachedBusiness | null> => {
  if (!businessId) return null;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['business'], 'readonly');
    const store = transaction.objectStore('business');
    const request = store.get(businessId);
    request.onsuccess = () => resolve((request.result as CachedBusiness | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
};

const mostRecentlyUsed = (entries: CachedBusiness[]): CachedBusiness => {
  let best = entries[0];
  for (const entry of entries) {
    if ((entry.lastUsedAt ?? 0) > (best.lastUsedAt ?? 0)) best = entry;
  }
  return best;
};

export const getCachedBusiness = async (userId?: string): Promise<CachedBusiness | null> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['business'], 'readonly');
    const store = transaction.objectStore('business');
    const request = store.getAll();

    request.onsuccess = () => {
      const results = request.result as CachedBusiness[];
      if (results.length === 0) {
        resolve(null);
        return;
      }
      if (userId) {
        const mine = results.filter((entry) => entry.cachedForUser === userId);
        if (mine.length > 0) {
          resolve(mostRecentlyUsed(mine));
          return;
        }
        // Pre-per-account data has no tag. If there's exactly one untagged
        // entry it was this device's single business — keep using it so
        // existing installs don't lose offline access. Tagged entries belong
        // to other accounts and are never shown to a different account.
        const untagged = results.filter((entry) => !entry.cachedForUser);
        if (untagged.length === 1) {
          resolve(untagged[0]);
          return;
        }
        resolve(null);
        return;
      }
      // No specific user requested — return the most recently used business.
      resolve(mostRecentlyUsed(results));
    };
    request.onerror = () => reject(request.error);
  });
};

// Debtors cache operations
interface CachedDebtor {
  id: string;
  businessId: string;
  customerName: string;
  customerPhone: string | null;
  amountOwed: number;
  amountPaid: number;
  status: string;
  notes: string | null;
  createdAt: string;
  dueDate: string | null;
}

export const cacheDebtors = async (debtors: CachedDebtor[]): Promise<void> => {
  if (!Array.isArray(debtors)) {
    console.error('[offline] cacheDebtors: non-array payload, cache left untouched');
    return;
  }
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['debtors'], 'readwrite');
    const store = transaction.objectStore('debtors');
    // Replace only the affected business's rows. A wholesale store.clear()
    // would destroy other businesses' cached debtor lists.
    const index = store.index('businessId');
    const delReq = index.openKeyCursor(IDBKeyRange.only(debtors[0]?.businessId ?? ''));
    delReq.onerror = () => reject(delReq.error);
    delReq.onsuccess = () => {
      const cursor = delReq.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        debtors.forEach((debtor) => {
          store.put(debtor);
        });
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

// Merge server debtors into the local cache WITHOUT dropping local state.
// Offline placeholders for still-queued debtor ops must survive a refresh.
export const mergeServerDebtors = async (businessId: string, serverDebtors: CachedDebtor[]): Promise<void> => {
  if (!businessId) return;

  const [local, pendingOps] = await Promise.all([
    getCachedDebtors(businessId),
    getPendingOps(businessId),
  ]);

  const localMap = new Map(local.map((d) => [d.id, d]));
  const locked = new Set<string>();
  for (const op of pendingOps) {
    const p = op.payload as any;
    if (op.type === 'debtor_create') {
      if (p?.tempId) locked.add(p.tempId);
      if (p?.offlineId) locked.add(p.offlineId);
      if (p?.id) locked.add(p.id);
    }
    if (op.type === 'debtor_payment' || op.type === 'debtor_delete') {
      const did = p?.debtorId ?? p?.id;
      if (did) locked.add(did);
    }
  }

  const serverIds = new Set(serverDebtors.map((d) => d.id));
  const merged: CachedDebtor[] = serverDebtors.map((d) => {
    const ld = localMap.get(d.id);
    if (ld && locked.has(d.id)) {
      return { ...d, amountOwed: ld.amountOwed, amountPaid: ld.amountPaid, status: ld.status };
    }
    return d;
  });
  // Never drop local rows the server pull didn't return.
  for (const ld of local) {
    if (!serverIds.has(ld.id)) merged.push(ld);
  }

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['debtors'], 'readwrite');
    const store = transaction.objectStore('debtors');
    for (const d of merged) store.put(d);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getCachedDebtors = async (businessId: string): Promise<CachedDebtor[]> => {
  if (!businessId) return [];

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['debtors'], 'readonly');
    const store = transaction.objectStore('debtors');
    const index = store.index('businessId');
    const request = index.getAll(IDBKeyRange.only(businessId));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const updateCachedDebtor = async (debtor: CachedDebtor): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['debtors'], 'readwrite');
    const store = transaction.objectStore('debtors');
    const request = store.put(debtor);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

// Offline credentials cache
export interface OfflineUser {
  email: string;
  passwordHash: string;
  userId: string;
  role: string;
  lastOnlineLogin: string;
}

/**
 * Snapshot of an offline (cached-credentials / cashier PIN) login.
 *
 * Supabase never sees these logins, so there is no server-side session to
 * restore from — without persisting this record the login only survives as
 * long as the page is never reloaded (service-worker update, tab refresh,
 * Android WebView process kill), which logged cashiers out at random.
 */
export interface OfflineSessionRecord {
  userId: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: number;
}

const OFFLINE_SESSION_KEY = 'zampos_offline_session';
export const OFFLINE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const persistOfflineSession = (record: Omit<OfflineSessionRecord, 'expiresAt'>): void => {
  try {
    localStorage.setItem(
      OFFLINE_SESSION_KEY,
      JSON.stringify({ ...record, expiresAt: Date.now() + OFFLINE_SESSION_TTL_MS }),
    );
    // Point the per-user session cache (see buildMultiAccountStorage in
    // integrations/supabase/client.ts) at this user, so a real session left
    // behind by a different account can't take over after a reload.
    localStorage.setItem('zampos_active_user', record.userId);
  } catch {
    // Storage unavailable/full — the login still works for this page view.
  }
};

export const readOfflineSessionRecord = (): OfflineSessionRecord | null => {
  try {
    const raw = localStorage.getItem(OFFLINE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OfflineSessionRecord;
    if (!parsed?.userId || typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(OFFLINE_SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const clearOfflineSession = (): void => {
  try {
    localStorage.removeItem(OFFLINE_SESSION_KEY);
  } catch {
    // noop
  }
};

export const hashPassword = async (password: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

export const cacheOfflineCredentials = async (user: OfflineUser): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['offline_users'], 'readwrite');
    const store = transaction.objectStore('offline_users');
    const request = store.put(user);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const verifyOfflineCredentials = async (email: string, password: string): Promise<OfflineUser | null> => {
  try {
    const db = await getDB();
    const passwordHash = await hashPassword(password);
    return new Promise((resolve) => {
      const transaction = db.transaction(['offline_users'], 'readonly');
      const store = transaction.objectStore('offline_users');
      const request = store.get(email);
      request.onsuccess = () => {
        const user = request.result;
        if (user && user.passwordHash === passwordHash) {
          resolve(user);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
};

export const getCachedOfflineUsers = async (): Promise<OfflineUser[]> => {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(['offline_users'], 'readonly');
      const store = transaction.objectStore('offline_users');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
};

export const clearOfflineCredentials = async (email: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['offline_users'], 'readwrite');
    const store = transaction.objectStore('offline_users');
    const request = store.delete(email);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

// Sales history cache for offline viewing
interface CachedSale {
  id: string;
  businessId: string;
  items: Array<{
    productId: string;
    name: string;
    price: number;
    quantity: number;
    costPrice?: number | null;
    discountType?: string | null;
    discountValue?: number;
  }>;
  subtotal: number;
  total: number;
  discountAmount: number;
  paymentMethod: string;
  createdAt: string;
  synced: boolean;
  status: string;
  taxAmount?: number;
  taxableAmount?: number;
  zeroRatedAmount?: number;
  exemptAmount?: number;
  customerName?: string | null;
  customerTpin?: string | null;
  customerPhone?: string | null;
  amountPaid?: number;
  balanceDue?: number;
  paymentStatus?: string;
  dueDate?: string | null;
  cashierName?: string | null;
  cashierUsername?: string | null;
}

export const cacheSalesHistory = async (businessId: string, sales: CachedSale[]): Promise<void> => {
  if (!businessId || sales.length === 0) return;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['salesCache'], 'readwrite');
    const store = transaction.objectStore('salesCache');
    // Merge (upsert) rather than clear — the page's windowed fetch and the
    // background downstream pull must accumulate, not wipe each other. Only
    // rows for this business are touched so other businesses stay intact.
    sales.forEach((sale) => {
      if (sale.businessId === businessId) store.put(sale);
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getCachedSalesHistory = async (businessId: string): Promise<CachedSale[]> => {
  if (!businessId) return [];

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['salesCache'], 'readonly');
    const store = transaction.objectStore('salesCache');
    const index = store.index('businessId');
    const request = index.getAll(IDBKeyRange.only(businessId));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// Expenses cache for offline viewing
interface CachedExpense {
  id: string;
  businessId: string;
  name: string;
  amount: number;
  expense_date: string;
  notes: string | null;
  category: string;
}

export const cacheExpenses = async (businessId: string, expenses: CachedExpense[]): Promise<void> => {
  if (!Array.isArray(expenses)) {
    console.error('[offline] cacheExpenses: non-array payload, cache left untouched');
    return;
  }
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['expensesCache'], 'readwrite');
    const store = transaction.objectStore('expensesCache');
    // Replace only this business's rows. A wholesale store.clear() (or
    // clear-before-put) would wipe every other business's cached expenses.
    const index = store.index('businessId');
    const delReq = index.openKeyCursor(IDBKeyRange.only(businessId));
    delReq.onerror = () => reject(delReq.error);
    delReq.onsuccess = () => {
      const cursor = delReq.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        expenses.forEach((exp) => store.put(exp));
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getCachedExpenses = async (businessId: string): Promise<CachedExpense[]> => {
  if (!businessId) return [];

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['expensesCache'], 'readonly');
    const store = transaction.objectStore('expensesCache');
    const index = store.index('businessId');
    const request = index.getAll(IDBKeyRange.only(businessId));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// Debtor payments cache for offline viewing
interface CachedDebtorPayment {
  id: string;
  businessId: string;
  amount: number;
  payment_date: string;
}

export const cacheDebtorPayments = async (businessId: string, payments: CachedDebtorPayment[]): Promise<void> => {
  if (!Array.isArray(payments)) {
    console.error('[offline] cacheDebtorPayments: non-array payload, cache left untouched');
    return;
  }
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['debtorPaymentsCache'], 'readwrite');
    const store = transaction.objectStore('debtorPaymentsCache');
    // Replace only this business's rows — never clear the whole store, which
    // would destroy other businesses' cached payment history.
    const index = store.index('businessId');
    const delReq = index.openKeyCursor(IDBKeyRange.only(businessId));
    delReq.onerror = () => reject(delReq.error);
    delReq.onsuccess = () => {
      const cursor = delReq.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        payments.forEach((p) => store.put(p));
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getCachedDebtorPayments = async (businessId: string): Promise<CachedDebtorPayment[]> => {
  if (!businessId) return [];

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['debtorPaymentsCache'], 'readonly');
    const store = transaction.objectStore('debtorPaymentsCache');
    const index = store.index('businessId');
    const request = index.getAll(IDBKeyRange.only(businessId));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// Invoices cache for offline viewing
interface CachedInvoice {
  id: string;
  businessId: string;
  invoiceNumber: string;
  offlineId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  customerTpin?: string | null;
  subtotal: number;
  discountType?: string | null;
  discountValue: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  status: string;
  issuedDate: string;
  dueDate?: string | null;
  paymentMethod?: string | null;
  quotationId?: string | null;
  deliveryNoteId?: string | null;
  convertedSaleId?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export const cacheInvoices = async (businessId: string, invoices: CachedInvoice[]): Promise<void> => {
  if (!Array.isArray(invoices)) {
    console.error('[offline] cacheInvoices: non-array payload, cache left untouched');
    return;
  }
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['invoicesCache'], 'readwrite');
    const store = transaction.objectStore('invoicesCache');
    // Replace only this business's rows. A wholesale store.clear() (or
    // clear-before-put) would wipe every other business's cached invoices.
    const index = store.index('businessId');
    const delReq = index.openKeyCursor(IDBKeyRange.only(businessId));
    delReq.onerror = () => reject(delReq.error);
    delReq.onsuccess = () => {
      const cursor = delReq.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        invoices.forEach((inv) => store.put(inv));
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

// Merge server invoices into the local cache WITHOUT dropping local state.
// Offline placeholders for still-queued invoice ops must survive a refresh.
export const mergeServerInvoices = async (businessId: string, serverInvoices: CachedInvoice[]): Promise<void> => {
  if (!businessId) return;

  const [local, pendingOps] = await Promise.all([
    getCachedInvoices(businessId),
    getPendingOps(businessId),
  ]);

  const localMap = new Map(local.map((i) => [i.id, i]));
  const locked = new Set<string>();
  for (const op of pendingOps) {
    const p = op.payload as any;
    if (op.type.startsWith('invoice_')) {
      if (p?.id) locked.add(p.id);
      if (p?.offlineId) locked.add(p.offlineId);
    }
  }

  const serverIds = new Set(serverInvoices.map((i) => i.id));
  const merged: CachedInvoice[] = serverInvoices.map((i) => {
    const li = localMap.get(i.id);
    if (li && locked.has(i.id)) {
      return { ...i, status: li.status, total: li.total, updatedAt: li.updatedAt };
    }
    return i;
  });
  // Never drop local rows the server pull didn't return.
  for (const li of local) {
    if (!serverIds.has(li.id)) merged.push(li);
  }

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['invoicesCache'], 'readwrite');
    const store = transaction.objectStore('invoicesCache');
    for (const i of merged) store.put(i);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getCachedInvoices = async (businessId: string): Promise<CachedInvoice[]> => {
  if (!businessId) return [];

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['invoicesCache'], 'readonly');
    const store = transaction.objectStore('invoicesCache');
    const index = store.index('businessId');
    const request = index.getAll(IDBKeyRange.only(businessId));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// Pending operations queue for offline CRUD
interface PendingOp {
  id: string;
  businessId: string;
  type: 'product_create' | 'product_update' | 'product_deactivate'
    | 'debtor_create' | 'debtor_payment'
    | 'expense_create' | 'expense_delete'
    | 'category_create' | 'category_delete'
    | 'settings_update'
    | 'sale_delete'
    | 'debtor_delete'
    | 'quotation_create' | 'quotation_update' | 'quotation_delete'
    | 'delivery_note_create' | 'delivery_note_status' | 'delivery_note_delete'
    | 'invoice_create' | 'invoice_update' | 'invoice_status' | 'invoice_pay' | 'invoice_delete';
  payload: any;
  createdAt: string;
  retryCount?: number;
  lastError?: string;
  permanentlyFailed?: boolean;
}

export const queuePendingOp = async (op: PendingOp): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOps'], 'readwrite');
    const store = transaction.objectStore('pendingOps');
    const request = store.add(op);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getPendingOps = async (businessId: string): Promise<PendingOp[]> => {
  if (!businessId) return [];

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOps'], 'readonly');
    const store = transaction.objectStore('pendingOps');
    const index = store.index('businessId');
    const request = index.getAll(IDBKeyRange.only(businessId));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const removePendingOp = async (opId: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOps'], 'readwrite');
    const store = transaction.objectStore('pendingOps');
    const request = store.delete(opId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const updatePendingOpRetry = async (opId: string, retryCount: number, lastError: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOps'], 'readwrite');
    const store = transaction.objectStore('pendingOps');
    const getRequest = store.get(opId);
    
    getRequest.onsuccess = () => {
      const op = getRequest.result;
      if (op) {
        op.retryCount = retryCount;
        op.lastError = lastError;
        if (retryCount >= MAX_RETRIES) {
          op.permanentlyFailed = true;
        }
        const putRequest = store.put(op);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      } else {
        resolve();
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
};

// Product image blob cache (download image bytes for offline viewing)
export const cacheProductImageBlob = async (path: string, blob: Blob): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['productImageBlobs'], 'readwrite');
    const store = transaction.objectStore('productImageBlobs');
    store.put({ path, blob, cachedAt: new Date().toISOString() });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getCachedImageBlob = async (path: string): Promise<Blob | null> => {
  const db = await getDB();
  return new Promise((resolve) => {
    const transaction = db.transaction(['productImageBlobs'], 'readonly');
    const store = transaction.objectStore('productImageBlobs');
    const request = store.get(path);
    request.onsuccess = () => resolve(request.result?.blob ?? null);
    request.onerror = () => resolve(null);
  });
};

export const getCachedImageBlobWithAge = async (path: string): Promise<{ blob: Blob; cachedAt: string } | null> => {
  const db = await getDB();
  return new Promise((resolve) => {
    const transaction = db.transaction(['productImageBlobs'], 'readonly');
    const store = transaction.objectStore('productImageBlobs');
    const request = store.get(path);
    request.onsuccess = () => {
      const result = request.result;
      if (result?.blob && result?.cachedAt) {
        resolve({ blob: result.blob, cachedAt: result.cachedAt });
      } else {
        resolve(null);
      }
    };
    request.onerror = () => resolve(null);
  });
};

export const removeCachedImageBlob = async (path: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['productImageBlobs'], 'readwrite');
    const store = transaction.objectStore('productImageBlobs');
    store.delete(path);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

// Pending image uploads (blobs selected offline, uploaded when online)
interface PendingImageUpload {
  id: string;
  blob: Blob;
  mimeType: string;
  businessId: string;
  originalName: string;
}

export const storePendingImageUpload = async (upload: PendingImageUpload): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingImageUploads'], 'readwrite');
    const store = transaction.objectStore('pendingImageUploads');
    const request = store.add(upload);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getPendingImageUpload = async (id: string): Promise<PendingImageUpload | null> => {
  const db = await getDB();
  return new Promise((resolve) => {
    const transaction = db.transaction(['pendingImageUploads'], 'readonly');
    const store = transaction.objectStore('pendingImageUploads');
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
};

export const removePendingImageUpload = async (id: string): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingImageUploads'], 'readwrite');
    const store = transaction.objectStore('pendingImageUploads');
    store.delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

// Offline cashier login support.
// Cashier accounts have a deterministic email (c-<shortId>-<username>@zampos.local)
// and a password derived from the PIN. We cache a lookup keyed by
// `${businessCode}:${username}` so offline login can find the stored credentials
// without needing the business id.

/** Derive a cashier account password from their PIN (mirrors server logic). */
export const cashierPinPassword = (pin: string): string => `zampos-${pin}`;

interface CashierLookup {
  lookupKey: string;
  email: string;
  username: string;
  businessCode: string;
}

export const cacheCashierLookup = async (entry: CashierLookup): Promise<void> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['cashierLookup'], 'readwrite');
    const store = transaction.objectStore('cashierLookup');
    const request = store.put(entry);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getCashierLookup = async (lookupKey: string): Promise<CashierLookup | null> => {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(['cashierLookup'], 'readonly');
      const store = transaction.objectStore('cashierLookup');
      const request = store.get(lookupKey);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
};

// Permanently-failed pending ops — surface these to the user instead of
// dropping them silently, so nothing is lost without being noticed.

export const getPermanentlyFailedOps = async (businessId: string): Promise<PendingOp[]> => {
  if (!businessId) return [];
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOps'], 'readonly');
    const store = transaction.objectStore('pendingOps');
    const index = store.index('businessId');
    const request = index.getAll(IDBKeyRange.only(businessId));
    request.onsuccess = () => {
      resolve(request.result.filter((op) => op.permanentlyFailed === true));
    };
    request.onerror = () => reject(request.error);
  });
};

export const resetFailedOps = async (opIds: string[]): Promise<void> => {
  if (opIds.length === 0) return;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOps'], 'readwrite');
    const store = transaction.objectStore('pendingOps');
    for (const id of opIds) {
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const op = getRequest.result;
        if (op) {
          op.permanentlyFailed = false;
          op.retryCount = 0;
          op.lastError = undefined;
          store.put(op);
        }
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

// Initialize DB on module load to ensure stores exist
initDB().catch(console.error);

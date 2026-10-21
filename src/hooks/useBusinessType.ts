import { useState, useEffect, useCallback } from 'react';

export type BusinessType = 'retail' | 'service' | 'hybrid' | 'restaurant' | 'producer';

interface BusinessTypeLabels {
  // Navigation & Headers
  productsTitle: string;
  productsDescription: string;
  addButtonLabel: string;

  // Product/Service fields
  itemName: string;
  itemNamePlaceholder: string;
  priceLabel: string;
  quantityLabel: string;
  stockLabel: string;
  minStockLabel: string;
  categoryLabel: string;

  // POS
  posItemsTitle: string;
  posItemsDescription: string;
  stockDisplay: (stock: number) => string;

  // Receipt
  receiptItemLabel: string;
  receiptQuantityPrefix: string;

  // Service-specific optional fields
  showStock: boolean;
  showDuration: boolean;
  showNotes: boolean;

  // Misc
  lowStockWarning: string;
  noItemsMessage: string;
}

const RETAIL_LABELS: BusinessTypeLabels = {
  productsTitle: 'Products',
  productsDescription: 'Search, edit and manage stock.',
  addButtonLabel: 'Add',
  itemName: 'Name',
  itemNamePlaceholder: 'Sugar 1kg',
  priceLabel: 'Selling Price (ZMW)',
  quantityLabel: 'Qty',
  stockLabel: 'Stock',
  minStockLabel: 'Min Stock (alerts)',
  categoryLabel: 'Category (optional)',
  posItemsTitle: 'Products',
  posItemsDescription: 'Tap to add to cart',
  stockDisplay: (stock: number) => `Stock: ${stock}`,
  receiptItemLabel: 'Item',
  receiptQuantityPrefix: 'x',
  showStock: true,
  showDuration: false,
  showNotes: false,
  lowStockWarning: 'LOW',
  noItemsMessage: 'No products yet.',
};

const SERVICE_LABELS: BusinessTypeLabels = {
  productsTitle: 'Services',
  productsDescription: 'Search, edit and manage services.',
  addButtonLabel: 'Add',
  itemName: 'Service Name',
  itemNamePlaceholder: 'Haircut',
  priceLabel: 'Service Fee (ZMW)',
  quantityLabel: 'Sessions',
  stockLabel: 'Available Slots',
  minStockLabel: 'Min Slots (alerts)',
  categoryLabel: 'Category (optional)',
  posItemsTitle: 'Services',
  posItemsDescription: 'Tap to add to invoice',
  stockDisplay: (stock: number) => `Slots: ${stock}`,
  receiptItemLabel: 'Service',
  receiptQuantityPrefix: '',
  showStock: false,
  showDuration: true,
  showNotes: true,
  lowStockWarning: 'LIMITED',
  noItemsMessage: 'No services yet.',
};

const HYBRID_LABELS: BusinessTypeLabels = {
  productsTitle: 'Products & Services',
  productsDescription: 'Manage stock items and services from one place.',
  addButtonLabel: 'Add',
  itemName: 'Name',
  itemNamePlaceholder: 'Sugar 1kg / Haircut',
  priceLabel: 'Price (ZMW)',
  quantityLabel: 'Qty',
  stockLabel: 'Stock',
  minStockLabel: 'Min Stock (alerts)',
  categoryLabel: 'Category (optional)',
  posItemsTitle: 'Catalog',
  posItemsDescription: 'Tap to add products or services',
  stockDisplay: (stock: number) => `Stock: ${stock}`,
  receiptItemLabel: 'Item',
  receiptQuantityPrefix: 'x',
  showStock: true,
  showDuration: false,
  showNotes: true,
  lowStockWarning: 'LOW',
  noItemsMessage: 'No items yet.',
};

const RESTAURANT_LABELS: BusinessTypeLabels = {
  productsTitle: 'Menu Items',
  productsDescription: 'Search, edit and manage your menu.',
  addButtonLabel: 'Add',
  itemName: 'Item Name',
  itemNamePlaceholder: 'Chicken & Chips',
  priceLabel: 'Price (ZMW)',
  quantityLabel: 'Qty',
  stockLabel: 'Stock',
  minStockLabel: 'Min Stock (alerts)',
  categoryLabel: 'Category (optional)',
  posItemsTitle: 'Menu',
  posItemsDescription: 'Tap to add to order',
  stockDisplay: (stock: number) => `Stock: ${stock}`,
  receiptItemLabel: 'Item',
  receiptQuantityPrefix: 'x',
  showStock: true,
  showDuration: false,
  showNotes: false,
  lowStockWarning: 'LOW',
  noItemsMessage: 'No menu items yet.',
};

const PRODUCER_LABELS: BusinessTypeLabels = {
  productsTitle: 'Finished Goods',
  productsDescription: 'Manage raw materials, sub-assemblies and finished goods.',
  addButtonLabel: 'Add',
  itemName: 'Product Name',
  itemNamePlaceholder: 'Packed Maize Meal 25kg',
  priceLabel: 'Selling Price (ZMW)',
  quantityLabel: 'Qty',
  stockLabel: 'Stock',
  minStockLabel: 'Min Stock (alerts)',
  categoryLabel: 'Category (optional)',
  posItemsTitle: 'Products',
  posItemsDescription: 'Tap to add to cart',
  stockDisplay: (stock: number) => `Stock: ${stock}`,
  receiptItemLabel: 'Item',
  receiptQuantityPrefix: 'x',
  showStock: true,
  showDuration: false,
  showNotes: false,
  lowStockWarning: 'LOW',
  noItemsMessage: 'No products yet.',
};

const STORAGE_KEY = 'zampos_business_type';

const HEALTHY_TYPES: BusinessType[] = ['retail', 'service', 'hybrid', 'restaurant', 'producer'];

const isBusinessType = (v: string | null | undefined): v is BusinessType => {
  return !!v && (HEALTHY_TYPES as string[]).includes(v);
};

export function useBusinessType(businessId?: string, serverBusinessType?: string | null) {
  const storageKey = businessId ? `${STORAGE_KEY}_${businessId}` : STORAGE_KEY;

  const parse = (raw: string | null): BusinessType => {
    if (isBusinessType(raw)) return raw;
    return 'retail';
  };

  const [businessType, setBusinessTypeState] = useState<BusinessType>(() => {
    if (typeof window === 'undefined') return 'retail';
    return parse(localStorage.getItem(storageKey));
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setBusinessTypeState(parse(localStorage.getItem(storageKey)));
  }, [storageKey]);

  // Server value only seeds the local cache when nothing valid is stored yet.
  // Existing users keep their localStorage value (localStorage wins on purpose).
  useEffect(() => {
    if (typeof window === 'undefined' || !isBusinessType(serverBusinessType)) return;
    const stored = localStorage.getItem(storageKey);
    if (isBusinessType(stored)) return;
    localStorage.setItem(storageKey, serverBusinessType);
    setBusinessTypeState(serverBusinessType);
  }, [storageKey, serverBusinessType]);

  const setBusinessType = useCallback(
    (type: BusinessType) => {
      setBusinessTypeState(type);
      if (typeof window !== 'undefined') {
        localStorage.setItem(storageKey, type);
      }
    },
    [storageKey]
  );

  const labels: BusinessTypeLabels =
    businessType === 'service' ? SERVICE_LABELS
    : businessType === 'hybrid' ? HYBRID_LABELS
    : businessType === 'restaurant' ? RESTAURANT_LABELS
    : businessType === 'producer' ? PRODUCER_LABELS
    : RETAIL_LABELS;

  const isRetail = businessType === 'retail';
  const isService = businessType === 'service';
  const isHybrid = businessType === 'hybrid';
  const isRestaurant = businessType === 'restaurant';
  const isProducer = businessType === 'producer';

  return {
    businessType,
    setBusinessType,
    labels,
    isRetail,
    isService,
    isHybrid,
    isRestaurant,
    isProducer,
  };
}

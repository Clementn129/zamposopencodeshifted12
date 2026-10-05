/**
 * Single source for the CAPEX category vocabulary, shared by the register page,
 * the Reports box and (mirrored) the CHECK constraint in migration
 * 20261005000000_capex_and_cashier_stock_access.sql.
 *
 * Free text fragments into "Van", "van", "Vehicle" and the breakdown stops
 * meaning anything, so the database refuses it and 'other' is the escape hatch.
 */
export const CAPEX_CATEGORIES = [
  { value: 'equipment', label: 'Equipment' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'tools', label: 'Tools' },
  { value: 'furniture', label: 'Furniture' },
  { value: 'it_software', label: 'IT / Software' },
  { value: 'renovation', label: 'Renovation' },
  { value: 'land_building', label: 'Land / Building' },
  { value: 'other', label: 'Other' },
] as const;

export type CapexCategory = (typeof CAPEX_CATEGORIES)[number]['value'];

export const CAPEX_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  CAPEX_CATEGORIES.map((c) => [c.value, c.label]),
);

// Pure helpers for the manufacturing / production module.
//
// Kept dependency-free so they can be unit-tested and shared between the
// online RPC path and the offline (cached-stock) path. The DB enforces the
// same rules server-side (migration 20261022000000_manufacturing.sql); these
// mirror them so the UI can validate before a round-trip and so offline
// production can decide whether it is possible at all.

export type ProductType = 'RAW_MATERIAL' | 'SUB_ASSEMBLY' | 'FINISHED_GOOD';

export type ProductionStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  RAW_MATERIAL: 'Raw Material',
  SUB_ASSEMBLY: 'Sub-Assembly',
  FINISHED_GOOD: 'Finished Good',
};

export const PRODUCTION_STATUS_LABELS: Record<ProductionStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export interface BomLine {
  id: string;
  finishedProductId: string;
  componentProductId: string;
  quantityRequired: number;
}

/** Minimal shape of a product needed by the sufficiency/cost helpers. */
export interface StockComponent {
  id: string;
  name: string;
  stock: number;
  costPrice?: number | null;
}

export interface MaterialShortfall {
  productId: string;
  name: string;
  required: number;
  available: number;
  shortBy: number;
}

/**
 * Check whether a production run is feasible given the BOM lines and the
 * current stock of each component.
 *
 * @param lines     BOM lines for the finished product
 * @param quantity  units of the finished good to produce
 * @param stockById map of component product id -> current stock
 * @returns list of shortfalls; empty array means there is enough material
 */
export function checkMaterialSufficiency(
  lines: Pick<BomLine, 'componentProductId' | 'quantityRequired'>[],
  quantity: number,
  stockById: Map<string, { name: string; stock: number }>
): MaterialShortfall[] {
  const shortfalls: MaterialShortfall[] = [];
  if (quantity <= 0) return shortfalls;

  for (const line of lines) {
    const component = stockById.get(line.componentProductId);
    if (!component) {
      shortfalls.push({
        productId: line.componentProductId,
        name: 'Unknown component',
        required: line.quantityRequired * quantity,
        available: 0,
        shortBy: line.quantityRequired * quantity,
      });
      continue;
    }
    const required = line.quantityRequired * quantity;
    if (component.stock < required) {
      shortfalls.push({
        productId: line.componentProductId,
        name: component.name,
        required,
        available: component.stock,
        shortBy: required - component.stock,
      });
    }
  }

  return shortfalls;
}

/**
 * Compute the net change to each product's stock for a production run.
 * Negative deltas for components, positive for the finished good.
 */
export function computeProductionDeltas(
  lines: Pick<BomLine, 'componentProductId' | 'quantityRequired'>[],
  quantity: number,
  finishedProductId: string
): Map<string, number> {
  const deltas = new Map<string, number>();
  if (quantity <= 0) return deltas;

  for (const line of lines) {
    const consumed = line.quantityRequired * quantity;
    deltas.set(line.componentProductId, (deltas.get(line.componentProductId) ?? 0) - consumed);
  }
  deltas.set(finishedProductId, (deltas.get(finishedProductId) ?? 0) + quantity);
  return deltas;
}

/**
 * Roll up the material cost of producing one unit of a finished good from its
 * BOM lines and the cost price of each component.
 */
export function computeBomUnitCost(
  lines: Pick<BomLine, 'componentProductId' | 'quantityRequired'>[],
  costById: Map<string, number | null | undefined>
): number {
  let total = 0;
  for (const line of lines) {
    const cost = costById.get(line.componentProductId) ?? 0;
    total += (cost ?? 0) * line.quantityRequired;
  }
  return total;
}

/**
 * Detect whether adding an edge (finished <- component) would create a cycle in
 * the BOM graph. Mirrors the recursive check in the `save_bom_item` RPC.
 *
 * @param existing lines already saved for this business
 * @param finishedProductId the product that would consume `componentProductId`
 * @param componentProductId the proposed component
 */
export function wouldCreateBomCycle(
  existing: Pick<BomLine, 'finishedProductId' | 'componentProductId'>[],
  finishedProductId: string,
  componentProductId: string
): boolean {
  if (finishedProductId === componentProductId) return true;

  // Build adjacency: finished -> [components]
  const children = new Map<string, string[]>();
  for (const l of existing) {
    const arr = children.get(l.finishedProductId) ?? [];
    arr.push(l.componentProductId);
    children.set(l.finishedProductId, arr);
  }

  // Walk downward from the proposed component. If we reach the finished
  // product, the new edge closes a loop.
  const stack = [componentProductId];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop() as string;
    if (current === finishedProductId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of children.get(current) ?? []) stack.push(next);
  }
  return false;
}

/** Format a shortfall list into a human-readable error message. */
export function formatShortfallMessage(shortfalls: MaterialShortfall[]): string {
  if (shortfalls.length === 0) return '';
  const first = shortfalls[0];
  const extra = shortfalls.length > 1 ? ` (and ${shortfalls.length - 1} more)` : '';
  return `Insufficient materials: "${first.name}" needs ${first.required} but only ${first.available} in stock${extra}`;
}

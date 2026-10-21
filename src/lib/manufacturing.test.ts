import { describe, it, expect } from "vitest";
import {
  checkMaterialSufficiency,
  computeProductionDeltas,
  computeBomUnitCost,
  wouldCreateBomCycle,
  formatShortfallMessage,
  PRODUCT_TYPE_LABELS,
  PRODUCTION_STATUS_LABELS,
  type BomLine,
} from "./manufacturing";

const line = (
  finishedProductId: string,
  componentProductId: string,
  quantityRequired: number,
  id = `${finishedProductId}:${componentProductId}`
): BomLine => ({ id, finishedProductId, componentProductId, quantityRequired });

describe("checkMaterialSufficiency", () => {
  const stock = new Map([
    ["flour", { name: "Flour", stock: 10 }],
    ["sugar", { name: "Sugar", stock: 3 }],
  ]);

  it("returns no shortfalls when there is enough material", () => {
    const lines = [line("cake", "flour", 2), line("cake", "sugar", 1)];
    expect(checkMaterialSufficiency(lines, 3, stock)).toEqual([]);
  });

  it("reports each component that is short", () => {
    const lines = [line("cake", "flour", 2), line("cake", "sugar", 2)];
    const result = checkMaterialSufficiency(lines, 3, stock);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      productId: "sugar",
      name: "Sugar",
      required: 6,
      available: 3,
      shortBy: 3,
    });
  });

  it("treats unknown components as fully short", () => {
    const lines = [line("cake", "ghost", 1)];
    const result = checkMaterialSufficiency(lines, 2, stock);
    expect(result[0]).toMatchObject({
      productId: "ghost",
      name: "Unknown component",
      required: 2,
      available: 0,
      shortBy: 2,
    });
  });

  it("returns nothing for non-positive quantity", () => {
    const lines = [line("cake", "flour", 2)];
    expect(checkMaterialSufficiency(lines, 0, stock)).toEqual([]);
    expect(checkMaterialSufficiency(lines, -5, stock)).toEqual([]);
  });

  it("boundary: exactly enough stock is not a shortfall", () => {
    const lines = [line("cake", "sugar", 1)];
    expect(checkMaterialSufficiency(lines, 3, stock)).toEqual([]);
  });
});

describe("computeProductionDeltas", () => {
  it("subtracts components and adds the finished good", () => {
    const lines = [line("cake", "flour", 2), line("cake", "sugar", 1)];
    const deltas = computeProductionDeltas(lines, 3, "cake");
    expect(deltas.get("flour")).toBe(-6);
    expect(deltas.get("sugar")).toBe(-3);
    expect(deltas.get("cake")).toBe(3);
  });

  it("aggregates repeated components", () => {
    const lines = [line("cake", "flour", 2), line("cake", "flour", 1)];
    const deltas = computeProductionDeltas(lines, 2, "cake");
    expect(deltas.get("flour")).toBe(-6);
  });

  it("nets a component that is also the finished good", () => {
    const lines = [line("kit", "kit", 1)];
    const deltas = computeProductionDeltas(lines, 5, "kit");
    expect(deltas.get("kit")).toBe(0);
  });

  it("returns empty map for non-positive quantity", () => {
    const lines = [line("cake", "flour", 2)];
    expect(computeProductionDeltas(lines, 0, "cake").size).toBe(0);
  });
});

describe("computeBomUnitCost", () => {
  it("rolls up component costs times quantity", () => {
    const lines = [line("cake", "flour", 2), line("cake", "sugar", 3)];
    const costs = new Map<string, number | null | undefined>([
      ["flour", 5],
      ["sugar", 2],
    ]);
    expect(computeBomUnitCost(lines, costs)).toBe(16);
  });

  it("treats missing/null cost as zero", () => {
    const lines = [line("cake", "flour", 2), line("cake", "sugar", 3)];
    const costs = new Map<string, number | null | undefined>([
      ["flour", null],
      ["sugar", undefined],
    ]);
    expect(computeBomUnitCost(lines, costs)).toBe(0);
  });
});

describe("wouldCreateBomCycle", () => {
  const existing = [
    line("cake", "batter", 1),
    line("batter", "flour", 2),
    line("flour", "wheat", 1),
  ];

  it("rejects self-reference", () => {
    expect(wouldCreateBomCycle(existing, "cake", "cake")).toBe(true);
  });

  it("allows a normal edge", () => {
    expect(wouldCreateBomCycle(existing, "cake", "sugar")).toBe(false);
  });

  it("detects a direct cycle", () => {
    // cake already consumes batter; making batter consume cake closes a loop.
    expect(wouldCreateBomCycle(existing, "batter", "cake")).toBe(true);
  });

  it("detects a deep transative cycle", () => {
    // wheat is beneath flour -> batter -> cake; making wheat consume cake loops.
    expect(wouldCreateBomCycle(existing, "wheat", "cake")).toBe(true);
  });

  it("is not confused by unrelated branches", () => {
    expect(wouldCreateBomCycle(existing, "cake", "cocoa")).toBe(false);
  });
});

describe("formatShortfallMessage", () => {
  it("returns empty string when nothing is short", () => {
    expect(formatShortfallMessage([])).toBe("");
  });

  it("names the first shortfall and notes extras", () => {
    const msg = formatShortfallMessage([
      { productId: "a", name: "Flour", required: 6, available: 3, shortBy: 3 },
      { productId: "b", name: "Sugar", required: 2, available: 1, shortBy: 1 },
    ]);
    expect(msg).toContain('"Flour"');
    expect(msg).toContain("and 1 more");
  });

  it("omits the extra clause for a single shortfall", () => {
    const msg = formatShortfallMessage([
      { productId: "a", name: "Flour", required: 6, available: 3, shortBy: 3 },
    ]);
    expect(msg).not.toContain("more");
  });
});

describe("labels", () => {
  it("covers every product type", () => {
    expect(Object.keys(PRODUCT_TYPE_LABELS)).toEqual([
      "RAW_MATERIAL",
      "SUB_ASSEMBLY",
      "FINISHED_GOOD",
    ]);
  });

  it("covers every production status", () => {
    expect(Object.keys(PRODUCTION_STATUS_LABELS)).toEqual([
      "PENDING",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
    ]);
  });
});

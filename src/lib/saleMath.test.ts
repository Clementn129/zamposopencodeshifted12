import { describe, it, expect } from "vitest";
import { lineCost, lineRevenue, saleTotals, computeProfit } from "./saleMath";

describe("lineCost", () => {
  it("multiplies cost by quantity", () => {
    expect(lineCost({ costPrice: 5, quantity: 3 })).toBe(15);
  });

  it("treats missing cost as zero", () => {
    expect(lineCost({ quantity: 3 })).toBe(0);
    expect(lineCost({ costPrice: null, quantity: 2 })).toBe(0);
  });
});

describe("lineRevenue", () => {
  it("uses finalSalePrice when present", () => {
    expect(lineRevenue({ price: 10, finalSalePrice: 8, quantity: 2 })).toBe(16);
  });

  it("apportions sale discount when finalSalePrice is absent", () => {
    const item = { price: 10, quantity: 1 };
    expect(lineRevenue(item, 10, 2)).toBe(8);
  });
});

describe("saleTotals", () => {
  it("computes subtotal, discount and net", () => {
    const items = [
      { price: 10, finalSalePrice: 8, quantity: 1 },
      { price: 5, finalSalePrice: 5, quantity: 2 },
    ];
    expect(saleTotals(items)).toEqual({ subtotal: 20, discountAmount: 2, net: 18 });
  });
});

describe("computeProfit", () => {
  it("removes tax from gross profit", () => {
    const { grossProfit } = computeProfit({ revenue: 116, tax: 16, cogs: 40 });
    expect(grossProfit).toBe(60);
  });

  it("subtracts business expenses and owner drawings from net profit", () => {
    const { grossProfit, netProfit } = computeProfit({
      revenue: 116,
      tax: 16,
      cogs: 40,
      businessExpenses: 10,
      ownerDrawings: 5,
    });
    expect(grossProfit).toBe(60);
    expect(netProfit).toBe(45);
  });

  it("defaults expenses and drawings to zero", () => {
    const { netProfit } = computeProfit({ revenue: 100, tax: 0, cogs: 30 });
    expect(netProfit).toBe(70);
  });

  it("handles zero cogs (no cost data)", () => {
    const { grossProfit } = computeProfit({ revenue: 116, tax: 16, cogs: 0 });
    expect(grossProfit).toBe(100);
  });
});

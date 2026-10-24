import { describe, expect, it } from 'vitest';
import { previewOpeningCorrection } from './openingStock';

describe('previewOpeningCorrection', () => {
  it('reduces current stock by the difference when opening is corrected down', () => {
    const preview = previewOpeningCorrection({
      openingStock: 500,
      currentStock: 200,
      newOpening: 300,
    });

    expect(preview.delta).toBe(-200);
    expect(preview.newCurrentStock).toBe(0);
    expect(preview.soldOrMoved).toBe(300);
    expect(preview.valid).toBe(true);
  });

  it('increases current stock when opening is corrected up', () => {
    const preview = previewOpeningCorrection({
      openingStock: 100,
      currentStock: 60,
      newOpening: 150,
    });

    expect(preview.delta).toBe(50);
    expect(preview.newCurrentStock).toBe(110);
    expect(preview.valid).toBe(true);
  });

  it('blocks a correction that would make current stock negative', () => {
    const preview = previewOpeningCorrection({
      openingStock: 500,
      currentStock: 100,
      newOpening: 300,
    });

    expect(preview.newCurrentStock).toBe(-100);
    expect(preview.valid).toBe(false);
    expect(preview.error).toContain('must be at least 400');
  });

  it('rejects negative or fractional opening values', () => {
    expect(
      previewOpeningCorrection({ openingStock: 5, currentStock: 5, newOpening: -1 }).valid,
    ).toBe(false);
    expect(
      previewOpeningCorrection({ openingStock: 5, currentStock: 5, newOpening: 2.5 }).valid,
    ).toBe(false);
  });

  it('accepts a no-op correction', () => {
    const preview = previewOpeningCorrection({
      openingStock: 30,
      currentStock: 12,
      newOpening: 30,
    });

    expect(preview.delta).toBe(0);
    expect(preview.newCurrentStock).toBe(12);
    expect(preview.valid).toBe(true);
  });
});

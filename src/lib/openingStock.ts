export type OpeningCorrectionInput = {
  openingStock: number | null | undefined;
  currentStock: number | null | undefined;
  newOpening: number;
};

export type OpeningCorrectionPreview = {
  oldOpening: number;
  newOpening: number;
  delta: number;
  currentStock: number;
  newCurrentStock: number;
  soldOrMoved: number;
  valid: boolean;
  error: string | null;
};

export function previewOpeningCorrection({
  openingStock,
  currentStock,
  newOpening,
}: OpeningCorrectionInput): OpeningCorrectionPreview {
  const oldOpening = Math.max(0, Math.trunc(Number(openingStock) || 0));
  const current = Math.trunc(Number(currentStock) || 0);
  const next = Number(newOpening);
  const delta = Number.isFinite(next) ? next - oldOpening : 0;
  const newCurrentStock = current + delta;
  const soldOrMoved = oldOpening - current;
  const minimumOpening = Math.max(0, soldOrMoved);

  let error: string | null = null;
  if (!Number.isFinite(next) || !Number.isInteger(next) || next < 0) {
    error = 'Enter a whole number of 0 or more.';
  } else if (newCurrentStock < 0) {
    error = `Cannot set opening stock to ${next}. It must be at least ${minimumOpening} because current stock is ${current} after units already sold or moved.`;
  }

  return {
    oldOpening,
    newOpening: Number.isFinite(next) ? next : oldOpening,
    delta,
    currentStock: current,
    newCurrentStock,
    soldOrMoved,
    valid: error === null,
    error,
  };
}

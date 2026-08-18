export function clampStepperValue(value: number, min: number, max: number, step = 1): number {
  if (!Number.isFinite(value)) return min;
  const snapped = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

export function formatStepperDigits(value: number, digits = 3): { negative: boolean; digits: string[] } {
  const negative = value < 0;
  const padded = Math.abs(Math.trunc(value)).toString().padStart(Math.max(1, digits), "0");
  return { negative, digits: padded.split("") };
}

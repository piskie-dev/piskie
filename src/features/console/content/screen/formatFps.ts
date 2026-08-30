export function formatFps(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return value.toFixed(value >= 10 ? 0 : 1);
}

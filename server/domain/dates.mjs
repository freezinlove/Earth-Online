export function toDateInput(date) {
  return date ? String(date).slice(0, 10) : new Date().toISOString().slice(0, 10);
}

export function dateMs(date) {
  const value = date ? new Date(String(date).replace(/Z$/i, "")).getTime() : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

export function daysBetweenRanges(aStart, aEnd, bStart, bEnd) {
  const as = dateMs(aStart);
  const ae = dateMs(aEnd);
  const bs = dateMs(bStart);
  const be = dateMs(bEnd);
  if ([as, ae, bs, be].some((value) => value === undefined)) return Number.POSITIVE_INFINITY;
  if (ae >= bs && be >= as) return 0;
  return Math.min(Math.abs(bs - ae), Math.abs(as - be)) / 86400000;
}

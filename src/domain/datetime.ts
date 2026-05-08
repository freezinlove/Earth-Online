export function stripTimezoneSuffix(value?: string) {
  return String(value ?? "").replace(/Z$/i, "");
}

export function capturedDateLabel(value?: string) {
  const normalized = stripTimezoneSuffix(value);
  return normalized ? normalized.slice(0, 10) : "待补时间";
}

export function capturedTimeLabel(value?: string) {
  const normalized = stripTimezoneSuffix(value);
  return normalized.includes("T") ? normalized.slice(11, 16) : "";
}

export function capturedDateTimeLabel(value?: string) {
  const normalized = stripTimezoneSuffix(value);
  if (!normalized) return "时间未记录";
  const date = normalized.slice(0, 10).replace(/-/g, ".");
  const time = capturedTimeLabel(normalized);
  return time ? `${date} ${time}` : date;
}

export function toCapturedDateTimeInput(value?: string) {
  const normalized = stripTimezoneSuffix(value);
  return normalized.includes("T") ? normalized.slice(0, 16) : "";
}

export function normalizeCapturedDateTimeInput(value?: string) {
  if (!value) return "";
  const normalized = stripTimezoneSuffix(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) return `${normalized}:00`;
  return normalized;
}

export function capturedTimeValue(value?: string) {
  const normalized = stripTimezoneSuffix(value);
  const timestamp = normalized ? new Date(normalized).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

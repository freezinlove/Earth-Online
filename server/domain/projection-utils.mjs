export function centerOf(points) {
  if (!points.length) return undefined;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

export function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function dateKey(value) {
  return value ? String(value).slice(0, 10) : "待补时间";
}

export function sortByDate(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

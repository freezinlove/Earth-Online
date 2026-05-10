import { broadPresets, cityPresets } from "./geo-catalog.mjs";

export function haversineKm(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function isUsableLocation(location) {
  return (
    location &&
    Number.isFinite(location.lat) &&
    Number.isFinite(location.lng) &&
    Math.abs(location.lat) <= 90 &&
    Math.abs(location.lng) <= 180 &&
    !(Math.abs(location.lat) < 0.000001 && Math.abs(location.lng) < 0.000001)
  );
}

export function inferPreset(name, location) {
  const lower = (name ?? "").toLowerCase();
  const byName = cityPresets.find((preset) => lower.includes(preset.keyword.toLowerCase()));
  if (byName) return byName;
  if (isUsableLocation(location)) {
    const nearest = cityPresets
      .map((preset) => ({ preset, distance: haversineKm(location, preset.point) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest && nearest.distance <= 180) return nearest.preset;
    if (location.lat >= 34 && location.lat <= 72 && location.lng >= -25 && location.lng <= 45) return broadPresets.europe;
  }
  return broadPresets.unknown;
}

export function geoContextFor(preset, location) {
  if (!isUsableLocation(location)) {
    return {
      hasGps: false,
      cityHint: preset.city,
      countryHint: preset.country,
    };
  }
  return {
    hasGps: true,
    lat: Number(location.lat.toFixed(6)),
    lng: Number(location.lng.toFixed(6)),
    cityHint: preset.city,
    countryHint: preset.country,
  };
}

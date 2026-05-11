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

const englishGeoNames = {
  京都: "Kyoto",
  日本: "Japan",
  大阪: "Osaka",
  奈良: "Nara",
  成都: "Chengdu",
  中国: "China",
  理塘: "Litang",
  巴黎: "Paris",
  法国: "France",
  佛罗伦萨: "Florence",
  意大利: "Italy",
  布拉格: "Prague",
  捷克: "Czechia",
  维也纳: "Vienna",
  奥地利: "Austria",
  哈尔施塔特: "Hallstatt",
  萨尔茨堡: "Salzburg",
  布达佩斯: "Budapest",
  匈牙利: "Hungary",
  柏林: "Berlin",
  德国: "Germany",
  慕尼黑: "Munich",
  苏黎世: "Zurich",
  瑞士: "Switzerland",
  "加米施-帕滕基兴": "Garmisch-Partenkirchen",
  艾布湖: "Eibsee",
  罗马: "Rome",
  伦敦: "London",
  英国: "United Kingdom",
  欧洲待确认地点: "Unknown European place",
  待确认地点: "Unknown place",
  待确认: "Unknown",
};

export function normalizeLocale(locale) {
  return locale === "en" ? "en" : "zh";
}

export function localizedGeoHint(value, locale = "zh") {
  if (normalizeLocale(locale) !== "en") return value;
  return englishGeoNames[value] ?? value;
}

export function geoContextFor(preset, location, locale = "zh") {
  if (!isUsableLocation(location)) {
    return {
      hasGps: false,
      cityHint: localizedGeoHint(preset.city, locale),
      countryHint: localizedGeoHint(preset.country, locale),
    };
  }
  return {
    hasGps: true,
    lat: Number(location.lat.toFixed(6)),
    lng: Number(location.lng.toFixed(6)),
    cityHint: localizedGeoHint(preset.city, locale),
    countryHint: localizedGeoHint(preset.country, locale),
  };
}

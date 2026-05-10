import { inferPreset } from "./geo.mjs";

const GENERIC_PLACE_SUFFIX = /地点\s*\d+$/u;
const SCENE_WORDS = [
  "街景",
  "山景",
  "夜景",
  "风景",
  "湖景",
  "河景",
  "随拍",
  "路边",
  "附近",
  "小憩",
  "自拍",
  "合影",
  "打卡",
  "候机",
  "时光",
  "暮色",
  "晨雾",
  "山间湖泊",
  "室内自拍",
  "好友聚会",
  "酒店房间",
  "多云天气",
  "户外休闲时光",
];
const BROAD_NAMES = new Set(["欧洲", "北欧", "旅行", "城市", "未知", "待确认", "欧洲待确认地点", "待确认地点", "未标地点"]);
const COUNTRY_NAMES = new Set([
  "挪威",
  "Norway",
  "日本",
  "Japan",
  "中国",
  "China",
  "奥地利",
  "Austria",
  "德国",
  "Germany",
  "捷克",
  "Czechia",
  "匈牙利",
  "Hungary",
  "瑞士",
  "Switzerland",
  "瑞典",
  "Sweden",
  "法国",
  "France",
  "意大利",
  "Italy",
  "英国",
  "United Kingdom",
  "美国",
  "United States",
]);
const PLACE_WORDS = ["桥", "堡", "宫", "馆", "院", "街", "路", "河", "湖", "山", "机场", "酒店", "咖啡馆", "教堂", "广场", "群岛", "海岸", "峡湾", "城堡"];

export function cleanPlaceName(value) {
  return String(value ?? "")
    .replace(GENERIC_PLACE_SUFFIX, "")
    .replace(/（.*?）/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripSceneSuffix(value) {
  let result = cleanPlaceName(value);
  for (const word of SCENE_WORDS) {
    if (result.endsWith(word) && result.length > word.length + 1) result = result.slice(0, -word.length);
  }
  return result.trim();
}

export function isWeakPlaceName(value) {
  const clean = cleanPlaceName(value);
  if (!clean) return true;
  if (BROAD_NAMES.has(clean) || COUNTRY_NAMES.has(clean)) return true;
  if (clean.includes("待确认") || clean.includes("未标")) return true;
  if (SCENE_WORDS.some((word) => clean === word || clean.endsWith(word))) return true;
  return false;
}

export function isUsableFinalPlaceName(value) {
  const clean = cleanPlaceName(value);
  if (!clean || clean.length < 2) return false;
  if (isWeakPlaceName(clean)) return false;
  if (clean.includes("某地")) return false;
  return true;
}

function sourceWeight(source) {
  if (source === "geocode") return 0.22;
  if (source === "manual") return 0.2;
  if (source === "ai_vision" || source === "ai_context_inference") return 0.08;
  if (source === "geo_catalog") return 0.04;
  return 0;
}

function featureWeight(candidate) {
  const code = candidate.featureCode;
  if (code === "PPLC") return 0.12;
  if (code === "PPLA") return 0.1;
  if (code === "PPLA2") return 0.09;
  if (code === "PPLA3") return 0.07;
  if (code === "PPL") return 0.04;
  if (code === "PPLX") return -0.06;
  return 0;
}

function rankWeight(candidate) {
  if (candidate.source !== "geocode" || !Number.isFinite(candidate.geocodeRank)) return 0;
  if (candidate.geocodeRank === 1) return 0.09;
  if (candidate.geocodeRank === 2) return 0.04;
  return 0;
}

function specificityWeight(candidate, cleanName) {
  const cleanCity = cleanPlaceName(candidate.city);
  if (cleanCity && cleanName !== cleanCity && cleanName.includes(cleanCity)) return 0.07;
  if (PLACE_WORDS.some((word) => cleanName.includes(word))) return 0.05;
  return 0;
}

export function candidateLocalityKey(candidate) {
  if (!candidate) return undefined;
  const country = cleanPlaceName(candidate.country ?? candidate.countryCode);
  const admin1 = cleanPlaceName(candidate.admin1);
  const admin2 = cleanPlaceName(candidate.admin2);
  const city = cleanPlaceName(candidate.city || candidate.name);
  const parts = [country, admin1, admin2, city].filter(Boolean);
  return parts.length >= 2 ? parts.join("|") : undefined;
}

function candidateScore(candidate, center) {
  const cleanName = cleanPlaceName(candidate.name || candidate.city);
  if (!isUsableFinalPlaceName(cleanName)) return -Infinity;
  const confidence = Number(candidate.confidence ?? 0.5);
  const distancePenalty = Number.isFinite(candidate.distanceKm) ? Math.min(0.22, Number(candidate.distanceKm) / 240) : 0;
  const centerPenalty =
    center && candidate.point
      ? Math.min(0.18, Math.sqrt((candidate.point.lat - center.lat) ** 2 + (candidate.point.lng - center.lng) ** 2) / 40)
      : 0;
  return confidence + sourceWeight(candidate.source) + featureWeight(candidate) + rankWeight(candidate) + specificityWeight(candidate, cleanName) - distancePenalty - centerPenalty;
}

function cleanNames(names, fallback) {
  const result = {};
  const fallbackClean = cleanPlaceName(fallback);
  for (const key of ["zh", "en", "local"]) {
    const value = cleanPlaceName(names?.[key]);
    if (value) result[key] = value;
  }
  if (!result.zh && fallbackClean) result.zh = fallbackClean;
  if (!result.en && fallbackClean) result.en = fallbackClean;
  return Object.keys(result).length ? result : undefined;
}

function descriptionFromCandidate(candidate, name) {
  const city = cleanPlaceName(candidate?.city || name);
  return {
    name,
    names: cleanNames(candidate?.localizedNames ?? candidate?.localizedCityNames, name),
    country: candidate?.country,
    countryNames: cleanNames(candidate?.localizedCountryNames, candidate?.country),
    city,
    cityNames: cleanNames(candidate?.localizedCityNames ?? candidate?.localizedNames, city),
  };
}

export function collectLocationCandidates(photos) {
  const seen = new Set();
  const candidates = [];
  for (const photo of photos) {
    for (const candidate of [...(photo.locationResolution?.candidates ?? []), ...(photo.ai?.locationCandidates ?? [])]) {
      if (!candidate) continue;
      const key = [cleanPlaceName(candidate.name), cleanPlaceName(candidate.country), cleanPlaceName(candidate.city), candidate.source].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function selectPlaceDescription(photos, center, { fallbackName, preserveName } = {}) {
  if (preserveName && !isWeakPlaceName(preserveName)) {
    const candidate = collectLocationCandidates(photos).find((item) => cleanPlaceName(item.name) === cleanPlaceName(preserveName) || cleanPlaceName(item.city) === cleanPlaceName(preserveName));
    return descriptionFromCandidate(candidate, cleanPlaceName(preserveName));
  }

  const ranked = collectLocationCandidates(photos)
    .map((candidate) => ({
      candidate,
      score: candidateScore(candidate, center),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score);

  const best = ranked[0]?.candidate;
  if (best) {
    const name = cleanPlaceName(best.name || best.city);
    return descriptionFromCandidate(best, name);
  }

  const preset = inferPreset(photos[0]?.fileName, center);
  const presetName = cleanPlaceName(fallbackName || preset.city);
  if (isUsableFinalPlaceName(presetName)) {
    return {
      name: presetName,
      names: cleanNames(undefined, presetName),
      country: preset.country,
      countryNames: cleanNames(undefined, preset.country),
      city: presetName,
      cityNames: cleanNames(undefined, presetName),
    };
  }

  return {
    name: "未标地点",
    names: { zh: "未标地点", en: "Unmarked place" },
    country: preset.country,
    countryNames: cleanNames(undefined, preset.country),
    city: preset.city,
    cityNames: cleanNames(undefined, preset.city),
  };
}

export function bestDisplayName(photos, placeName) {
  const title = photos
    .map((photo) => cleanPlaceName(photo.title))
    .find((value) => value && value.length >= 3 && !value.includes("地点"));
  if (title) return title;

  const visible = photos
    .flatMap((photo) => photo.ai?.visiblePlaceNames ?? [])
    .map(stripSceneSuffix)
    .find((value) => value && isUsableFinalPlaceName(value));
  return visible ?? placeName;
}

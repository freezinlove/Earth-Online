import { countryAliasKeys, normalizeCountryDescription, normalizedCountryText } from "../domain/country-normalizer.mjs";
import { haversineKm, isUsableLocation } from "../domain/geo.mjs";
import { cityPresets } from "../domain/geo-catalog.mjs";
import { zhPlaceNameOverride } from "../domain/place-name-overrides.mjs";

export const SEARCH_RADIUS_KM = 80;
export const RESULT_LIMIT = 5;
export const FORWARD_RESULT_LIMIT = 3;

const CITY_LEVEL_FEATURES = new Set(["PPLC", "PPLA", "PPLA2", "PPLA3", "PPLA4"]);
const englishNameOverrides = {
  zurich: "Zurich",
  zuerich: "Zurich",
  munchen: "Munich",
};

export function longitudeDelta(radiusKm, lat) {
  const cos = Math.max(0.08, Math.cos((lat * Math.PI) / 180));
  return radiusKm / (111.32 * cos);
}

export function latitudeDelta(radiusKm) {
  return radiusKm / 110.574;
}

export function geonameBounds(point, radiusKm = SEARCH_RADIUS_KM) {
  if (!isUsableLocation(point)) return undefined;
  const latDelta = latitudeDelta(radiusKm);
  const lngDelta = longitudeDelta(radiusKm, point.lat);
  return {
    minLat: point.lat - latDelta,
    maxLat: point.lat + latDelta,
    minLng: point.lng - lngDelta,
    maxLng: point.lng + lngDelta,
  };
}

function featureWeight(code) {
  if (code === "PPLC") return 0.16;
  if (code === "PPLA") return 0.14;
  if (code === "PPLA2") return 0.12;
  if (code === "PPLA3") return 0.1;
  if (code === "PPLA4") return 0.08;
  if (code === "PPL") return 0.05;
  if (code === "PPLX") return -0.06;
  return 0;
}

export function confidenceFor(row, distanceKm) {
  const distanceScore = Math.max(0, 1 - distanceKm / SEARCH_RADIUS_KM) * 0.66;
  const populationScore = Math.min(0.14, Math.log10(Math.max(1, Number(row.population ?? 0))) / 45);
  return Math.max(0.35, Math.min(0.96, Number((0.22 + distanceScore + featureWeight(row.feature_code) + populationScore).toFixed(3))));
}

function cityLevelRank(row) {
  const population = Number(row.population ?? 0);
  if (row.feature_code === "PPLC") return 6;
  if (row.feature_code === "PPLA") return 5;
  if (row.feature_code === "PPLA2") return 4;
  if (row.feature_code === "PPLA3") return 3;
  if (row.feature_code === "PPLA4") return 2;
  if (population >= 100000) return 3;
  if (population >= 50000) return 2;
  if (population >= 20000) return 1;
  return 0;
}

export function cityLevelScore(row, distanceKm) {
  const rank = cityLevelRank(row);
  const population = Number(row.population ?? 0);
  const populationScore = Math.min(1.4, Math.log10(Math.max(1, population)) / 4);
  const distancePenalty = (distanceKm / SEARCH_RADIUS_KM) * 2;
  return rank + populationScore - distancePenalty;
}

function preferCityLevel(items) {
  const cityCandidates = items.filter((item) => CITY_LEVEL_FEATURES.has(item.row.feature_code) || Number(item.row.population ?? 0) >= 20000);
  if (!cityCandidates.length) return items;
  return cityCandidates.sort((left, right) => {
    const leftScore = cityLevelScore(left.row, left.distanceKm);
    const rightScore = cityLevelScore(right.row, right.distanceKm);
    return rightScore - leftScore || left.distanceKm - right.distanceKm;
  });
}

function countryAliases(value) {
  return countryAliasKeys(value);
}

export function countryMatches(row, country) {
  const expected = countryAliases(country);
  if (!expected.length) return true;
  return [row.country_name_zh, row.country_name_en, row.country_name, row.country_code]
    .flatMap(countryAliases)
    .filter(Boolean)
    .some((value) => expected.includes(value));
}

function localizedName(row) {
  const override = [row.name_zh, row.name, row.ascii_name, row.name_en].map(zhPlaceNameOverride).find(Boolean);
  if (override) return override;
  if (row.name_zh) return row.name_zh;
  const values = [row.name, row.ascii_name].map(normalizedCountryText);
  const preset = cityPresets.find((item) => values.some((value) => value === normalizedCountryText(item.keyword) || value.includes(normalizedCountryText(item.keyword))));
  return preset?.city || row.name_en || row.ascii_name || row.name;
}

function localizedNames(row) {
  const zh = localizedName(row);
  const normalizedValues = [row.name, row.ascii_name, row.name_en].map(normalizedCountryText);
  const en = normalizedValues.map((value) => englishNameOverrides[value]).find(Boolean) || row.name_en || row.ascii_name || row.name;
  const local = row.name;
  return {
    zh,
    en,
    local,
  };
}

function countryNames(row) {
  return normalizeCountryDescription(row.country_code || row.country_name_zh || row.country_name_en || row.country_name, {
    zh: row.country_name_zh,
    en: row.country_name_en,
    local: row.country_name,
  }).countryNames;
}

export function rowToCandidate(row, { point, confidence, reason, makeId, index = 0 } = {}) {
  const candidatePoint = point ?? { lat: Number(row.lat), lng: Number(row.lng) };
  const localized = localizedNames(row);
  const localizedCountry = countryNames(row);
  const country = localizedCountry.zh ?? localizedCountry.en;
  const name = localized.zh ?? localized.en ?? localized.local;
  return {
    id: makeId?.("candidate") ?? `candidate-geocode-${row.geoname_id}`,
    name,
    localizedNames: localized,
    country,
    localizedCountryNames: localizedCountry,
    city: name,
    localizedCityNames: localized,
    point: candidatePoint,
    confidence,
    source: "geocode",
    precision: "estimated",
    reason,
    admin1: row.admin1_name || undefined,
    admin2: row.admin2_name || undefined,
    countryCode: row.country_code,
    featureCode: row.feature_code,
    featureLabel: row.feature_label || undefined,
    geocodeRank: index + 1,
    population: Number(row.population ?? 0),
  };
}

function presetCandidateForText(text) {
  const normalized = normalizedCountryText(text);
  return cityPresets.find((item) => normalized.includes(normalizedCountryText(item.keyword)) || normalized.includes(normalizedCountryText(item.city)));
}

export function forwardGeocodePlan({ name, city, country } = {}) {
  const texts = [city, name].map((value) => String(value ?? "").trim()).filter(Boolean);
  const preset = texts.map(presetCandidateForText).find((item) => !country || countryAliases(item?.country).some((alias) => countryAliases(country).includes(alias)));
  const queries = Array.from(new Set([preset?.keyword, preset?.city, ...texts].filter(Boolean)));
  return { queries, preset, texts };
}

export function forwardGeocodeFromRows({ name, city, country } = {}, rows = [], { makeId } = {}) {
  const { queries, preset, texts } = forwardGeocodePlan({ name, city, country });
  if (!texts.length && !country) return [];

  const matchedRows = rows.filter((row) => countryMatches(row, country));
  if (matchedRows.length) {
    return matchedRows.slice(0, FORWARD_RESULT_LIMIT).map((row, index) =>
      rowToCandidate(row, {
        confidence: index === 0 ? 0.72 : 0.62,
        reason: `GeoNames locality matched by name "${queries[0]}".`,
        makeId,
        index,
      }),
    );
  }

  if (preset?.point) {
    const country = normalizeCountryDescription(preset.country);
    return [
      {
        id: makeId?.("candidate") ?? `candidate-geocode-preset-${normalizedCountryText(preset.keyword).replace(/[^a-z0-9]+/g, "-")}`,
        name: preset.city,
        localizedNames: { zh: preset.city, en: preset.keyword, local: preset.city },
        country: country.country,
        localizedCountryNames: country.countryNames,
        city: preset.city,
        localizedCityNames: { zh: preset.city, en: preset.keyword, local: preset.city },
        point: preset.point,
        confidence: 0.68,
        source: "geocode",
        precision: "estimated",
        reason: `Local city preset matched by name "${preset.keyword}".`,
        geocodeRank: 1,
      },
    ];
  }

  return [];
}

export function reverseGeocodeFromRows(point, rows = [], { makeId, preferCity = false } = {}) {
  if (!isUsableLocation(point)) return [];

  const nearby = rows
    .map((row) => {
      const candidatePoint = { lat: Number(row.lat), lng: Number(row.lng) };
      const distanceKm = haversineKm(point, candidatePoint);
      return { row, candidatePoint, distanceKm };
    })
    .filter((item) => item.distanceKm <= SEARCH_RADIUS_KM);

  const ranked = (preferCity ? preferCityLevel(nearby) : nearby).sort((left, right) => {
    if (preferCity) {
      const leftScore = cityLevelScore(left.row, left.distanceKm);
      const rightScore = cityLevelScore(right.row, right.distanceKm);
      return rightScore - leftScore || left.distanceKm - right.distanceKm;
    }
    const leftScore = confidenceFor(left.row, left.distanceKm);
    const rightScore = confidenceFor(right.row, right.distanceKm);
    return rightScore - leftScore || left.distanceKm - right.distanceKm;
  });

  return ranked.slice(0, RESULT_LIMIT).map(({ row, candidatePoint, distanceKm }, index) => {
    const confidence = confidenceFor(row, distanceKm);
    return {
      ...rowToCandidate(row, {
        point: candidatePoint,
        confidence,
        reason: `GeoNames nearest locality, ${distanceKm.toFixed(1)}km, ${row.feature_code}`,
        makeId,
        index,
      }),
      confidence,
      distanceKm: Number(distanceKm.toFixed(3)),
    };
  });
}

export function countryCapitalPointFromRows(country, rows = []) {
  const row = rows
    .filter((candidate) => countryMatches(candidate, country))
    .sort((left, right) => {
      const leftRank = left.feature_code === "PPLC" ? 0 : 1;
      const rightRank = right.feature_code === "PPLC" ? 0 : 1;
      return leftRank - rightRank || Number(right.population ?? 0) - Number(left.population ?? 0);
    })[0];

  return row ? { lat: Number(row.lat), lng: Number(row.lng) } : undefined;
}

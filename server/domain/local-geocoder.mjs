import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { geodataPath } from "../config/paths.mjs";
import { haversineKm, isUsableLocation } from "./geo.mjs";
import { cityPresets } from "./geo-catalog.mjs";
import { zhPlaceNameOverride } from "./place-name-overrides.mjs";

const SEARCH_RADIUS_KM = 80;
const RESULT_LIMIT = 5;
const FORWARD_RESULT_LIMIT = 3;
const CITY_LEVEL_FEATURES = new Set(["PPLC", "PPLA", "PPLA2", "PPLA3", "PPLA4"]);
const englishNameOverrides = {
  zurich: "Zurich",
  zuerich: "Zurich",
  munchen: "Munich",
};
let db;
let warnedMissing = false;

function database() {
  if (db) return db;
  if (!existsSync(geodataPath)) {
    if (!warnedMissing) {
      console.warn(`GeoNames database not found at ${geodataPath}. Run npm run geodata:setup for offline reverse geocoding.`);
      warnedMissing = true;
    }
    return undefined;
  }
  db = new DatabaseSync(geodataPath, { readOnly: true });
  return db;
}

function longitudeDelta(radiusKm, lat) {
  const cos = Math.max(0.08, Math.cos((lat * Math.PI) / 180));
  return radiusKm / (111.32 * cos);
}

function latitudeDelta(radiusKm) {
  return radiusKm / 110.574;
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

function confidenceFor(row, distanceKm) {
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

function cityLevelScore(row, distanceKm) {
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

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function countryAliases(value) {
  const normalized = normalizedText(value).replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  if (!normalized) return [];
  if (["us", "usa", "unitedstates", "unitedstatesofamerica"].includes(normalized)) return ["us", "usa", "unitedstates", "unitedstatesofamerica"];
  return [normalized];
}

function countryMatches(row, country) {
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
  const values = [row.name, row.ascii_name].map(normalizedText);
  const preset = cityPresets.find((item) => values.some((value) => value === normalizedText(item.keyword) || value.includes(normalizedText(item.keyword))));
  return preset?.city || row.name_en || row.ascii_name || row.name;
}

function localizedNames(row) {
  const zh = localizedName(row);
  const normalizedValues = [row.name, row.ascii_name, row.name_en].map(normalizedText);
  const en = normalizedValues.map((value) => englishNameOverrides[value]).find(Boolean) || row.name_en || row.ascii_name || row.name;
  const local = row.name;
  return {
    zh,
    en,
    local,
  };
}

function countryNames(row) {
  const zh = row.country_name_zh || row.country_name || row.country_code;
  const en = row.country_name_en || row.country_name || row.country_code;
  return {
    zh,
    en,
    local: row.country_name || en,
  };
}

function rowToCandidate(row, { point, confidence, reason, makeId, index = 0 } = {}) {
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
  const normalized = normalizedText(text);
  return cityPresets.find((item) => normalized.includes(normalizedText(item.keyword)) || normalized.includes(normalizedText(item.city)));
}

export function forwardLocalGeocode({ name, city, country } = {}, { makeId } = {}) {
  const connection = database();
  const texts = [city, name].map((value) => String(value ?? "").trim()).filter(Boolean);
  if (!texts.length && !country) return [];

  const preset = texts.map(presetCandidateForText).find((item) => !country || normalizedText(item?.country) === normalizedText(country));
  const queries = Array.from(new Set([preset?.keyword, preset?.city, ...texts].filter(Boolean)));
  const rows = [];
  if (connection) {
    const statement = connection.prepare(`
      SELECT *
      FROM geoname_places
      WHERE lower(name) = lower(?)
        OR lower(ascii_name) = lower(?)
        OR lower(name_en) = lower(?)
        OR name_zh = ?
      ORDER BY population DESC
      LIMIT ${FORWARD_RESULT_LIMIT}
    `);
    for (const query of queries) rows.push(...statement.all(query, query, query, query).filter((row) => countryMatches(row, country)));
  }

  if (rows.length) {
    return rows.slice(0, FORWARD_RESULT_LIMIT).map((row, index) =>
      rowToCandidate(row, {
        confidence: index === 0 ? 0.72 : 0.62,
        reason: `GeoNames locality matched by name "${queries[0]}".`,
        makeId,
        index,
      }),
    );
  }

  if (preset?.point) {
    return [
      {
        id: makeId?.("candidate") ?? `candidate-geocode-preset-${normalizedText(preset.keyword).replace(/[^a-z0-9]+/g, "-")}`,
        name: preset.city,
        localizedNames: { zh: preset.city, en: preset.keyword, local: preset.city },
        country: preset.country,
        localizedCountryNames: { zh: preset.country, en: preset.country, local: preset.country },
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

export function reverseLocalGeocode(point, { makeId, preferCity = false } = {}) {
  if (!isUsableLocation(point)) return [];
  const connection = database();
  if (!connection) return [];

  const latDelta = latitudeDelta(SEARCH_RADIUS_KM);
  const lngDelta = longitudeDelta(SEARCH_RADIUS_KM, point.lat);
  const rows = connection
    .prepare(
      `
        SELECT *
        FROM geoname_places
        WHERE lat BETWEEN ? AND ?
          AND lng BETWEEN ? AND ?
        LIMIT 800
      `,
    )
    .all(point.lat - latDelta, point.lat + latDelta, point.lng - lngDelta, point.lng + lngDelta);

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

  return ranked
    .slice(0, RESULT_LIMIT)
    .map(({ row, candidatePoint, distanceKm }, index) => {
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

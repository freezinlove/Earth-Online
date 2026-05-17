import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { geodataPath } from "../config/paths.mjs";
import { countryAliasKeys } from "../../shared/domain/country-normalizer.mjs";
import {
  FORWARD_RESULT_LIMIT,
  countryCapitalPointFromRows,
  countryMatches,
  forwardGeocodeFromRows,
  forwardGeocodePlan,
  geonameBounds,
  reverseGeocodeFromRows,
} from "../../shared/geodata/geocoder-core.mjs";

let db;
let warnedMissing = false;
const countryCapitalCache = new Map();

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

export function forwardLocalGeocode(input = {}, { makeId } = {}) {
  const { queries, texts } = forwardGeocodePlan(input);
  if (!texts.length && !input.country) return [];

  const connection = database();
  const rows = [];
  if (connection && queries.length) {
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
    for (const query of queries) rows.push(...statement.all(query, query, query, query).filter((row) => countryMatches(row, input.country)));
  }

  return forwardGeocodeFromRows(input, rows, { makeId });
}

export function reverseLocalGeocode(point, { makeId, preferCity = false } = {}) {
  const bounds = geonameBounds(point);
  if (!bounds) return [];

  const connection = database();
  if (!connection) return [];

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
    .all(bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng);

  return reverseGeocodeFromRows(point, rows, { makeId, preferCity });
}

export function countryCapitalPoint(country) {
  const key = countryAliasKeys(country)[0];
  if (!key) return undefined;
  if (countryCapitalCache.has(key)) return countryCapitalCache.get(key);

  const connection = database();
  if (!connection) {
    countryCapitalCache.set(key, undefined);
    return undefined;
  }

  const rows = connection
    .prepare(
      `
        SELECT *
        FROM geoname_places
        WHERE feature_code IN ('PPLC', 'PPLCD')
      `,
    )
    .all();
  const point = countryCapitalPointFromRows(country, rows);
  countryCapitalCache.set(key, point);
  return point;
}

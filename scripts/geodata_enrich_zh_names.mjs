import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const geodataDir = path.join(rootDir, "external", "geodata");
const dbPath = path.join(geodataDir, "geonames.sqlite");
const outputPath = path.join(geodataDir, "zh-name-overrides.json");
const wikidataEndpoint = "https://query.wikidata.org/sparql";
const labelPriority = ["zh-hans", "zh-cn", "zh-sg", "zh-my", "zh", "zh-hant", "zh-tw", "zh-hk", "zh-mo"];
const sourcePriority = ["label", "alias", "zhwiki"];
const userAgent = "EarthOnlineGeodataEnrichment/0.1 (local development; Wikidata labels for GeoNames IDs)";

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasHan(value) {
  return /[\u4e00-\u9fff]/u.test(value ?? "");
}

function cleanWikipediaTitle(value) {
  return String(value ?? "")
    .replace(/_/g, " ")
    .trim();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function postSparql(query, { attempts = 4 } = {}) {
  let latestError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(wikidataEndpoint, {
        method: "POST",
        headers: {
          accept: "application/sparql-results+json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": userAgent,
        },
        body: new URLSearchParams({ query, format: "json" }),
      });
      if (!response.ok) throw new Error(`Wikidata query failed: ${response.status} ${response.statusText}`);
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`Wikidata query returned invalid JSON: ${error instanceof Error ? error.message : String(error)}; ${text.slice(0, 160)}`);
      }
    } catch (error) {
      latestError = error;
      if (attempt >= attempts) break;
      await sleep(500 * attempt);
    }
  }
  throw latestError;
}

function selectBestLabel(bindings) {
  const bySourceAndLang = new Map();
  for (const binding of bindings) {
    const source = binding.source?.value ?? "label";
    const lang = binding.lang?.value?.toLowerCase() || "zh";
    const rawLabel = binding.label?.value;
    const label = source === "zhwiki" ? cleanWikipediaTitle(rawLabel) : String(rawLabel ?? "").trim();
    if (!sourcePriority.includes(source) || !lang || !label || !hasHan(label)) continue;
    const key = `${source}:${lang}`;
    if (!bySourceAndLang.has(key)) bySourceAndLang.set(key, label);
  }
  for (const source of sourcePriority) {
    const found = labelPriority.map((lang) => bySourceAndLang.get(`${source}:${lang}`)).find(Boolean);
    if (found) return { label: found, source };
  }
  return undefined;
}

function wikidataId(binding) {
  return binding.item?.value?.split("/").pop();
}

async function fetchChineseLabelsByGeoId(geoIds) {
  if (!geoIds.length) return new Map();
  const values = geoIds.map((id) => `"${id}"`).join(" ");
  const languages = labelPriority.map((lang) => `"${lang}"`).join(", ");
  const query = `
SELECT ?geo ?item ?source ?lang ?label WHERE {
  VALUES ?geo { ${values} }
  ?item wdt:P1566 ?geo.
  {
    ?item rdfs:label ?label.
    BIND("label" AS ?source)
    BIND(LANG(?label) AS ?lang)
    FILTER(?lang IN (${languages}))
  }
  UNION
  {
    ?item skos:altLabel ?label.
    BIND("alias" AS ?source)
    BIND(LANG(?label) AS ?lang)
    FILTER(?lang IN (${languages}))
  }
  UNION
  {
    ?article schema:about ?item;
      schema:isPartOf <https://zh.wikipedia.org/>;
      schema:name ?label.
    BIND("zhwiki" AS ?source)
    BIND("zh" AS ?lang)
  }
}
`;
  const json = await postSparql(query);
  const grouped = new Map();
  for (const binding of json?.results?.bindings ?? []) {
    const geo = binding.geo?.value;
    if (!geo) continue;
    const current = grouped.get(geo) ?? [];
    current.push(binding);
    grouped.set(geo, current);
  }
  return new Map(
    [...grouped.entries()]
      .map(([geo, bindings]) => [geo, { ...selectBestLabel(bindings), wikidataId: wikidataId(bindings[0]) }])
      .filter(([, value]) => value.label),
  );
}

function rowSearchValues(row) {
  return Array.from(
    new Set(
      [row.name, row.ascii_name, row.name_en]
        .flatMap((value) => {
          const clean = String(value ?? "").trim();
          if (!clean) return [];
          const withoutSuffix = clean
            .replace(/\b(City|District|Municipality|Prefecture|County|Metropolitan City|Special City)\b/gi, "")
            .trim()
            .replace(/\s+/g, " ");
          return [clean, withoutSuffix].filter(Boolean);
        })
        .filter(Boolean),
    ),
  );
}

function sparqlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sparqlLangLiteral(value, lang) {
  return `${sparqlString(value)}@${lang}`;
}

async function fetchChineseLabelsByNameCountry(rows) {
  const values = rows
    .flatMap((row) => rowSearchValues(row).flatMap((name) => ["en", "mul"].map((lang) => [String(row.geoname_id), row.country_code, name, lang])))
    .map(([geo, countryCode, name, lang]) => `(${sparqlString(geo)} ${sparqlString(countryCode)} ${sparqlLangLiteral(name, lang)})`)
    .join("\n  ");
  if (!values) return new Map();
  const languages = labelPriority.map((lang) => `"${lang}"`).join(", ");
  const query = `
SELECT ?geo ?item ?source ?lang ?label WHERE {
  VALUES (?geo ?countryCode ?searchName) {
    ${values}
  }
  ?country wdt:P297 ?countryCode.
  ?item wdt:P17 ?country.
  {
    ?item rdfs:label ?searchName.
  }
  UNION
  {
    ?item skos:altLabel ?searchName.
  }
  {
    ?item rdfs:label ?label.
    BIND("label" AS ?source)
    BIND(LANG(?label) AS ?lang)
    FILTER(?lang IN (${languages}))
  }
  UNION
  {
    ?item skos:altLabel ?label.
    BIND("alias" AS ?source)
    BIND(LANG(?label) AS ?lang)
    FILTER(?lang IN (${languages}))
  }
  UNION
  {
    ?article schema:about ?item;
      schema:isPartOf <https://zh.wikipedia.org/>;
      schema:name ?label.
    BIND("zhwiki" AS ?source)
    BIND("zh" AS ?lang)
  }
}
`;
  const json = await postSparql(query);
  const grouped = new Map();
  for (const binding of json?.results?.bindings ?? []) {
    const geo = binding.geo?.value;
    if (!geo) continue;
    const current = grouped.get(geo) ?? [];
    current.push(binding);
    grouped.set(geo, current);
  }
  return new Map(
    [...grouped.entries()]
      .map(([geo, bindings]) => [geo, { ...selectBestLabel(bindings), wikidataId: wikidataId(bindings[0]), source: `name-country-${selectBestLabel(bindings)?.source ?? "unknown"}` }])
      .filter(([, value]) => value.label),
  );
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

const minPopulation = Number(argValue("min-population", "50000"));
const batchSize = Number(argValue("batch-size", "50"));
const nameCountryBatchSize = Number(argValue("name-country-batch-size", "0"));
if (!Number.isFinite(minPopulation) || minPopulation <= 0) throw new Error("--min-population must be a positive number");
if (!Number.isFinite(batchSize) || batchSize <= 0) throw new Error("--batch-size must be a positive number");
if (!Number.isFinite(nameCountryBatchSize) || nameCountryBatchSize < 0) throw new Error("--name-country-batch-size must be zero or a positive number");

const existing = await readJson(outputPath, {});
const existingNames = existing.namesByGeonameId && typeof existing.namesByGeonameId === "object" ? existing.namesByGeonameId : {};
const existingEntities = existing.wikidataEntityByGeonameId && typeof existing.wikidataEntityByGeonameId === "object" ? existing.wikidataEntityByGeonameId : {};
const existingSources = existing.sourceByGeonameId && typeof existing.sourceByGeonameId === "object" ? existing.sourceByGeonameId : {};

const db = new DatabaseSync(dbPath, { readOnly: true });
const targetRows = db
  .prepare(
    `
      SELECT geoname_id, name, ascii_name, name_en, country_code, country_name_en, population
      FROM geoname_places
      WHERE population >= ?
        AND (name_zh IS NULL OR trim(name_zh) = '')
      ORDER BY population DESC, geoname_id
    `,
  )
  .all(minPopulation);
db.close();

const pending = targetRows.map((row) => String(row.geoname_id)).filter((id) => !existingNames[id]);
const rowsById = new Map(targetRows.map((row) => [String(row.geoname_id), row]));
const labels = {};
const entities = {};
const sources = {};

async function writeOutput() {
  const namesByGeonameId = Object.fromEntries(Object.entries({ ...existingNames, ...labels }).sort(([left], [right]) => Number(left) - Number(right)));
  const wikidataEntityByGeonameId = Object.fromEntries(Object.entries({ ...existingEntities, ...entities }).sort(([left], [right]) => Number(left) - Number(right)));
  const sourceByGeonameId = Object.fromEntries(Object.entries({ ...existingSources, ...sources }).sort(([left], [right]) => Number(left) - Number(right)));
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(
      {
        source: "Wikidata Chinese rdfs:label, skos:altLabel, and zh.wikipedia.org article titles matched through P1566 GeoNames ID. Values are used only when GeoNames has no Chinese alternate name.",
        minPopulation,
        namesByGeonameId,
        wikidataEntityByGeonameId,
        sourceByGeonameId,
      },
      null,
      2,
    )}\n`,
  );
  return Object.keys(namesByGeonameId).length;
}

let completed = 0;
for (const group of chunks(pending, batchSize)) {
  const found = await fetchChineseLabelsByGeoId(group);
  for (const [geo, value] of found.entries()) {
    labels[geo] = value.label;
    if (value.wikidataId) entities[geo] = value.wikidataId;
    if (value.source) sources[geo] = value.source;
  }
  const unresolvedRows = group.filter((geo) => !labels[geo]).map((geo) => rowsById.get(geo)).filter(Boolean);
  if (nameCountryBatchSize > 0) {
    for (const rows of chunks(unresolvedRows, nameCountryBatchSize)) {
      try {
        const foundByNameCountry = await fetchChineseLabelsByNameCountry(rows);
        for (const [geo, value] of foundByNameCountry.entries()) {
          labels[geo] = value.label;
          if (value.wikidataId) entities[geo] = value.wikidataId;
          if (value.source) sources[geo] = value.source;
        }
      } catch (error) {
        console.warn(`Wikidata name/country lookup skipped ${rows.length} rows: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(100);
    }
  }
  completed += group.length;
  const totalWritten = await writeOutput();
  console.log(`Wikidata labels: ${completed}/${pending.length}, matched ${Object.keys(labels).length} new, ${totalWritten} total`);
  await sleep(150);
}

const totalWritten = await writeOutput();

console.log(
  `Wrote ${outputPath}: ${Object.keys(labels).length} new labels, ${totalWritten} total overrides for population >= ${minPopulation}.`,
);

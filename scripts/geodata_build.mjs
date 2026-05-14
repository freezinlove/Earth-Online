import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const geodataDir = path.join(rootDir, "external", "geodata");
const downloadDir = path.join(geodataDir, "downloads");
const dbPath = path.join(geodataDir, "geonames.sqlite");
const alternateLanguagePriority = {
  zh: ["zh-CN", "zh-Hans", "zh"],
  en: ["en"],
};
const zhRegionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });

function countryNameZh(countryCode, fallback) {
  if (countryCode === "HK" || countryCode === "MO") return "中国";
  try {
    return zhRegionNames.of(countryCode) || fallback || countryCode;
  } catch {
    return fallback || countryCode;
  }
}

function parseTsv(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("\t"));
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error("Invalid zip: missing end of central directory");
}

function fileEntryFromZip(buffer, targetFileName) {
  const eocd = findEndOfCentralDirectory(buffer);
  const centralDirOffset = buffer.readUInt32LE(eocd + 16);
  const centralDirSize = buffer.readUInt32LE(eocd + 12);
  let offset = centralDirOffset;
  const end = centralDirOffset + centralDirSize;

  while (offset < end) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x02014b50) throw new Error("Invalid zip: missing central directory file header");

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);

    if (!targetFileName || fileName === targetFileName) {
      const localSignature = buffer.readUInt32LE(localHeaderOffset);
      if (localSignature !== 0x04034b50) throw new Error(`Invalid zip: missing local header for ${fileName}`);
      const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      return { fileName, method, data, uncompressedSize };
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`Invalid zip: missing ${targetFileName}`);
}

function extractFileFromZip(buffer, targetFileName) {
  const { fileName, method, data, uncompressedSize } = fileEntryFromZip(buffer, targetFileName);
  let bytes;
  if (method === 0) bytes = data;
  else if (method === 8) bytes = zlib.inflateRawSync(data);
  else throw new Error(`Unsupported zip compression method ${method} for ${fileName}`);

  if (bytes.byteLength !== uncompressedSize) {
    throw new Error(`Unexpected zip size for ${fileName}: ${bytes.byteLength} !== ${uncompressedSize}`);
  }

  return bytes.toString("utf8");
}

async function forEachZipLine(name, targetFileName, onLine) {
  const buffer = await fs.readFile(path.join(downloadDir, name));
  const { fileName, method, data } = fileEntryFromZip(buffer, targetFileName);
  let stream = Readable.from(data);
  if (method === 8) stream = stream.pipe(zlib.createInflateRaw());
  else if (method !== 0) throw new Error(`Unsupported zip compression method ${method} for ${fileName}`);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() && !line.startsWith("#")) onLine(line);
  }
}

async function readTextFile(name) {
  return fs.readFile(path.join(downloadDir, name), "utf8");
}

async function readZipText(name) {
  const buffer = await fs.readFile(path.join(downloadDir, name));
  return extractFileFromZip(buffer);
}

function loadCountries(text) {
  const countries = new Map();
  for (const fields of parseTsv(text)) {
    const [iso, , , , name] = fields;
    if (iso && name) countries.set(iso, name);
  }
  return countries;
}

function chooseAlternateName(record, language) {
  const priority = alternateLanguagePriority[language];
  if (!priority) return undefined;
  for (const code of priority) {
    if (record?.[code]) return record[code];
  }
  return undefined;
}

async function loadAlternateNames(geonameIds) {
  const names = new Map();
  await forEachZipLine("alternateNamesV2.zip", "alternateNamesV2.txt", (line) => {
    const [, geonameId, language, name] = line.split("\t");
    if (!geonameIds.has(geonameId) || !name) return;
    if (!alternateLanguagePriority.zh.includes(language) && !alternateLanguagePriority.en.includes(language)) return;
    const record = names.get(geonameId) ?? {};
    if (!record[language]) record[language] = name;
    names.set(geonameId, record);
  });
  return names;
}

function loadAdmin1(text) {
  const admin = new Map();
  for (const fields of parseTsv(text)) {
    const [key, name, asciiName] = fields;
    if (key) admin.set(key, asciiName || name);
  }
  return admin;
}

function loadAdmin2(text) {
  const admin = new Map();
  for (const fields of parseTsv(text)) {
    const [key, name, asciiName] = fields;
    if (key) admin.set(key, asciiName || name);
  }
  return admin;
}

function loadFeatures(text) {
  const features = new Map();
  for (const fields of parseTsv(text)) {
    const [code, label] = fields;
    if (code) features.set(code, label);
  }
  return features;
}

await fs.mkdir(geodataDir, { recursive: true });

const [citiesText, countryText, admin1Text, admin2Text, featureText] = await Promise.all([
  readZipText("cities500.zip"),
  readTextFile("countryInfo.txt"),
  readTextFile("admin1CodesASCII.txt"),
  readTextFile("admin2Codes.txt"),
  readTextFile("featureCodes_en.txt"),
]);
const cityRows = parseTsv(citiesText);
const geonameIds = new Set(cityRows.map((fields) => fields[0]).filter(Boolean));
const alternateNames = await loadAlternateNames(geonameIds);

await fs.rm(dbPath, { force: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE geoname_places (
    geoname_id TEXT PRIMARY KEY,
    name TEXT,
    ascii_name TEXT,
    lat REAL,
    lng REAL,
    country_code TEXT,
    country_name TEXT,
    country_name_zh TEXT,
    country_name_en TEXT,
    admin1_code TEXT,
    admin1_name TEXT,
    admin2_code TEXT,
    admin2_name TEXT,
    feature_class TEXT,
    feature_code TEXT,
    feature_label TEXT,
    name_zh TEXT,
    name_en TEXT,
    population INTEGER,
    timezone TEXT
  );
`);

const countries = loadCountries(countryText);
const admin1 = loadAdmin1(admin1Text);
const admin2 = loadAdmin2(admin2Text);
const features = loadFeatures(featureText);
const insert = db.prepare(`
  INSERT INTO geoname_places (
    geoname_id, name, ascii_name, lat, lng, country_code, country_name, country_name_zh, country_name_en,
    admin1_code, admin1_name, admin2_code, admin2_name,
    feature_class, feature_code, feature_label, name_zh, name_en, population, timezone
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let inserted = 0;
db.exec("BEGIN IMMEDIATE");
try {
  for (const fields of cityRows) {
    const [
      geonameId,
      name,
      asciiName,
      ,
      lat,
      lng,
      featureClass,
      featureCode,
      countryCode,
      ,
      admin1Code,
      admin2Code,
      ,
      ,
      population,
      ,
      ,
      timezone,
    ] = fields;
    const admin1Key = `${countryCode}.${admin1Code}`;
    const admin2Key = `${countryCode}.${admin1Code}.${admin2Code}`;
    const featureKey = `${featureClass}.${featureCode}`;
    const alt = alternateNames.get(geonameId);
    const countryNameEn = countries.get(countryCode) ?? countryCode;
    const nameEn = chooseAlternateName(alt, "en") ?? asciiName ?? name;
    const nameZh = chooseAlternateName(alt, "zh") ?? "";
    insert.run(
      geonameId,
      name,
      asciiName,
      Number(lat),
      Number(lng),
      countryCode,
      countryNameEn,
      countryNameZh(countryCode, countryNameEn),
      countryNameEn,
      admin1Code,
      admin1.get(admin1Key) ?? "",
      admin2Code,
      admin2.get(admin2Key) ?? "",
      featureClass,
      featureCode,
      features.get(featureKey) ?? "",
      nameZh,
      nameEn,
      Number(population) || 0,
      timezone,
    );
    inserted += 1;
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

db.exec(`
  CREATE INDEX idx_geoname_lat_lng ON geoname_places(lat, lng);
  CREATE INDEX idx_geoname_country_admin ON geoname_places(country_code, admin1_code, admin2_code);
`);
db.close();

console.log(`Built ${dbPath} with ${inserted.toLocaleString()} GeoNames places.`);

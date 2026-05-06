import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTravelImage, embedSearchQuery } from "./ai-provider.mjs";
import { EarthRepository } from "./repository.mjs";
import { seedState } from "./seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "output", "earth-online-data");
const photoDir = path.join(dataDir, "photos");
const thumbDir = path.join(dataDir, "thumbnails");
const dbPath = path.join(dataDir, "db.json");
const vectorPath = path.join(dataDir, "vector-index.json");
const port = Number(process.env.EARTH_ONLINE_PORT ?? 8787);
const repository = new EarthRepository({ dataDir, dbJsonPath: dbPath });
const importJobs = new Map();
let repairedPersistedState = false;

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const cityPresets = [
  { keyword: "kyoto", city: "京都", country: "日本", point: { lat: 35.0116, lng: 135.7681 }, tags: ["京都", "街道", "寺庙"] },
  { keyword: "京都", city: "京都", country: "日本", point: { lat: 35.0116, lng: 135.7681 }, tags: ["京都", "街道", "寺庙"] },
  { keyword: "osaka", city: "大阪", country: "日本", point: { lat: 34.6937, lng: 135.5023 }, tags: ["大阪", "城市", "城堡"] },
  { keyword: "nara", city: "奈良", country: "日本", point: { lat: 34.6851, lng: 135.843 }, tags: ["奈良", "公园", "寺庙"] },
  { keyword: "chengdu", city: "成都", country: "中国", point: { lat: 30.5728, lng: 104.0668 }, tags: ["成都", "城市", "夜晚"] },
  { keyword: "litang", city: "理塘", country: "中国", point: { lat: 30.0006, lng: 100.2698 }, tags: ["理塘", "高原", "草原"] },
  { keyword: "paris", city: "巴黎", country: "法国", point: { lat: 48.8566, lng: 2.3522 }, tags: ["巴黎街景", "塞纳河", "法式建筑"] },
  { keyword: "florence", city: "佛罗伦萨", country: "意大利", point: { lat: 43.7696, lng: 11.2558 }, tags: ["佛罗伦萨", "黄昏", "建筑"] },
  { keyword: "prague", city: "布拉格", country: "捷克", point: { lat: 50.0755, lng: 14.4378 }, tags: ["布拉格", "查理大桥", "老城建筑"] },
  { keyword: "praha", city: "布拉格", country: "捷克", point: { lat: 50.0755, lng: 14.4378 }, tags: ["布拉格", "查理大桥", "老城建筑"] },
  { keyword: "vienna", city: "维也纳", country: "奥地利", point: { lat: 48.2082, lng: 16.3738 }, tags: ["维也纳", "环城大道", "奥地利建筑"] },
  { keyword: "wien", city: "维也纳", country: "奥地利", point: { lat: 48.2082, lng: 16.3738 }, tags: ["维也纳", "奥地利", "城市街景"] },
  { keyword: "hallstatt", city: "哈尔施塔特", country: "奥地利", point: { lat: 47.5622, lng: 13.6493 }, tags: ["哈尔施塔特", "奥地利湖区", "湖畔小镇"] },
  { keyword: "salzburg", city: "萨尔茨堡", country: "奥地利", point: { lat: 47.8095, lng: 13.055 }, tags: ["萨尔茨堡", "奥地利", "老城"] },
  { keyword: "budapest", city: "布达佩斯", country: "匈牙利", point: { lat: 47.4979, lng: 19.0402 }, tags: ["布达佩斯", "多瑙河", "城市建筑"] },
  { keyword: "garmisch", city: "加米施-帕滕基兴", country: "德国", point: { lat: 47.4917, lng: 11.0955 }, tags: ["加米施", "巴伐利亚", "阿尔卑斯山"] },
  { keyword: "eibsee", city: "艾布湖", country: "德国", point: { lat: 47.4568, lng: 10.989 }, tags: ["艾布湖", "阿尔卑斯山", "湖景"] },
  { keyword: "rome", city: "罗马", country: "意大利", point: { lat: 41.9028, lng: 12.4964 }, tags: ["罗马", "古城遗迹", "意大利街景"] },
  { keyword: "london", city: "伦敦", country: "英国", point: { lat: 51.5072, lng: -0.1276 }, tags: ["伦敦", "泰晤士河", "英伦街景"] },
];

const broadPresets = {
  europe: { keyword: "gps-europe", city: "欧洲待确认地点", country: "待确认", point: { lat: 48.5, lng: 10.5 }, tags: ["欧洲待确认地点", "待确认街景"] },
  unknown: { keyword: "unknown", city: "待确认地点", country: "待确认", point: { lat: 0, lng: 0 }, tags: ["旅行", "待确认"] },
};

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function toDateInput(date) {
  return date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function makePhotoTitle(photo) {
  const tag = safeArray(photo.tags).find((item) => !["旅行", "待确认", "城市", "建筑", "欧洲"].includes(item));
  if (tag) return String(tag).slice(0, 18);
  const caption = String(photo.aiCaption ?? "").match(/([\u4e00-\u9fa5A-Za-z0-9-]{2,18})/)?.[1];
  if (caption && !caption.includes("待确认")) return caption.slice(0, 18);
  return path.basename(photo.fileName ?? "未命名照片", path.extname(photo.fileName ?? "")).slice(0, 18);
}

async function ensureStorage() {
  await fs.mkdir(photoDir, { recursive: true });
  await fs.mkdir(thumbDir, { recursive: true });
  await repository.ensureInitialized();
  if (!existsSync(vectorPath)) {
    await fs.writeFile(vectorPath, JSON.stringify(seedState.vectorIndex ?? {}, null, 2), "utf8");
  }
  if (!repairedPersistedState) {
    repairedPersistedState = true;
    await repairPersistedState();
  }
}

async function readState() {
  await ensureStorage();
  return normalizeState(repository.readState());
}

async function writeState(state) {
  const normalized = normalizeState(state);
  repository.saveState(normalized);
  return normalized;
}

async function readVectorIndex() {
  await ensureStorage();
  return JSON.parse(await fs.readFile(vectorPath, "utf8"));
}

async function writeVectorIndex(index) {
  const tempPath = `${vectorPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(index, null, 2), "utf8");
  await fs.rename(tempPath, vectorPath);
}

async function repairPersistedState() {
  const state = normalizeState(repository.readState());
  const vectorIndex = JSON.parse(await fs.readFile(vectorPath, "utf8"));
  let changed = false;
  const tripIdsToRebuild = new Set();
  const photos = state.photos.map((photo) => {
    let next = { ...photo };
    if (!next.title) {
      next.title = makePhotoTitle(next);
      changed = true;
    }
    if (next.location && !isUsableLocation(next.location)) {
      next.location = undefined;
      next.placeNodeId = undefined;
      next.pendingReason = next.pendingReason ?? "missing_gps";
      next.exifStatus = { ...(next.exifStatus ?? {}), gps: "missing" };
      changed = true;
    }
    if (vectorIndex[next.id]) {
      const dimension = vectorIndex[next.id].length;
      if (next.embeddingDimension !== dimension || !next.embeddingProvider) {
        next.embeddingDimension = dimension;
        next.embeddingProvider = dimension > 64 ? "qwen" : "deterministic";
        changed = true;
      }
    }
    const preset = inferPreset(next.fileName, next.location);
    const hasGenericFallback =
      next.aiProvider === "qwen-mock" &&
      !preset.city.includes("待确认") &&
      ((next.tags ?? []).some((tag) => ["欧洲", "旅行", "城市", "建筑"].includes(tag)) ||
        (next.aiCaption ?? "").includes("欧洲附近") ||
        (next.tags ?? []).some((tag) => !(preset.tags ?? []).includes(tag)));
    const looksLikeWrongKyoto =
      next.aiProvider === "qwen-mock" &&
      preset.city !== "京都" &&
      ((next.tags ?? []).includes("京都") || (next.aiCaption ?? "").includes("京都"));
    if (looksLikeWrongKyoto || hasGenericFallback) {
      const tags = Array.from(new Set(preset.tags ?? [])).slice(0, 8);
      next.tags = tags;
      next.aiCaption = `${preset.city}附近的旅行照片，系统已根据 GPS 生成「${tags.slice(0, 3).join(" / ")}」等搜索标签，画面细节需要云端 AI 进一步确认。`;
      vectorIndex[next.id] = deterministicVector([next.fileName, next.aiCaption, ...tags].join(" "));
      next.embeddingProvider = "deterministic";
      next.embeddingDimension = 64;
      if (next.tripId) tripIdsToRebuild.add(next.tripId);
      changed = true;
    }
    return next;
  });

  let trips = state.trips.map((trip) => {
    const tripPhotos = photos.filter((photo) => photo.tripId === trip.id);
    const specificPresets = tripPhotos
      .filter((photo) => photo.location)
      .map((photo) => inferPreset(photo.fileName, photo.location))
      .filter((preset) => !preset.city.includes("待确认"));
    const cityCounts = new Map();
    for (const preset of specificPresets) cityCounts.set(preset.city, (cityCounts.get(preset.city) ?? 0) + 1);
    const rankedCities = Array.from(cityCounts.entries()).sort((a, b) => b[1] - a[1]);
    const preset = specificPresets.find((item) => item.city === rankedCities[0]?.[0]) ?? inferPreset(tripPhotos[0]?.fileName ?? trip.title, tripPhotos.find((photo) => photo.location)?.location);
    const hasWrongKyoto = trip.source === "import" && preset.city !== "京都" && (trip.title.includes("京都") || trip.cities?.includes("京都"));
    const shouldAggregateCities = trip.source === "import" && specificPresets.length > 0;
    if (!hasWrongKyoto && !shouldAggregateCities) return trip;
    tripIdsToRebuild.add(trip.id);
    changed = true;
    const cities = rankedCities.slice(0, 5).map(([city]) => city);
    const countries = Array.from(new Set(specificPresets.map((item) => item.country)));
    return {
      ...trip,
      title: hasWrongKyoto ? `${trip.dateRange.start.slice(0, 7)} ${cities.length > 1 ? "欧洲多城" : preset.city}旅行` : trip.title,
      countries: countries.length ? countries : [preset.country],
      cities: cities.length ? cities : [preset.city],
    };
  });

  const tripPresetMap = new Map(
    trips.map((trip) => {
      const tripPhotos = photos.filter((photo) => photo.tripId === trip.id);
      const locatedPresets = tripPhotos.filter((photo) => photo.location).map((photo) => inferPreset(photo.fileName, photo.location));
      const specific = locatedPresets.filter((preset) => !preset.city.includes("待确认"));
      const cityCounts = new Map();
      for (const preset of specific) cityCounts.set(preset.city, (cityCounts.get(preset.city) ?? 0) + 1);
      const dominantCity = Array.from(cityCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
      return [trip.id, specific.find((preset) => preset.city === dominantCity) ?? inferPreset(tripPhotos[0]?.fileName ?? trip.title, tripPhotos.find((photo) => photo.location)?.location)];
    }),
  );
  for (const photo of photos) {
    const preset = isUsableLocation(photo.location) ? inferPreset(photo.fileName, photo.location) : photo.tripId ? tripPresetMap.get(photo.tripId) : undefined;
    const hasGenericFallback =
      photo.aiProvider === "qwen-mock" &&
      preset &&
      !preset.city.includes("待确认") &&
      ((photo.tags ?? []).some((tag) => ["欧洲", "旅行", "城市", "建筑"].includes(tag)) ||
        (photo.aiCaption ?? "").includes("欧洲附近") ||
        (photo.aiCaption ?? "").includes("待确认地点") ||
        (photo.tags ?? []).some((tag) => !(preset.tags ?? []).includes(tag)));
    const looksLikeWrongKyoto =
      photo.aiProvider === "qwen-mock" &&
      preset &&
      preset.city !== "京都" &&
      ((photo.tags ?? []).includes("京都") || (photo.aiCaption ?? "").includes("京都") || (photo.aiCaption ?? "").includes("待确认地点"));
    if (looksLikeWrongKyoto || hasGenericFallback) {
      const tags = Array.from(new Set(preset.tags ?? [])).slice(0, 8);
      photo.tags = tags;
      photo.aiCaption = `${preset.city}附近的旅行照片，系统已根据 GPS 生成「${tags.slice(0, 3).join(" / ")}」等搜索标签，画面细节需要云端 AI 进一步确认。`;
      vectorIndex[photo.id] = deterministicVector([photo.fileName, photo.aiCaption, ...tags].join(" "));
      photo.embeddingProvider = "deterministic";
      photo.embeddingDimension = 64;
      if (photo.tripId) tripIdsToRebuild.add(photo.tripId);
      changed = true;
    }
  }

  let mergedAdjacentTrip = true;
  while (mergedAdjacentTrip) {
    mergedAdjacentTrip = false;
    const importTrips = trips.filter((trip) => trip.source === "import").sort((a, b) => a.dateRange.start.localeCompare(b.dateRange.start));
    for (let index = 1; index < importTrips.length; index += 1) {
      const previous = importTrips[index - 1];
      const current = importTrips[index];
      if (daysBetweenRanges(previous.dateRange.start, previous.dateRange.end, current.dateRange.start, current.dateRange.end) > 14) continue;
      const targetId = previous.id;
      const removeId = current.id;
    for (const photo of photos) {
      if (photo.tripId === removeId) photo.tripId = targetId;
    }
    const targetPhotos = photos.filter((photo) => photo.tripId === targetId);
    const targetDates = targetPhotos.map((photo) => photo.capturedAt).filter(Boolean).sort();
    const geoSummary = dominantPresetsForPhotos(targetPhotos);
    trips = trips
      .filter((trip) => trip.id !== removeId)
      .map((trip) =>
        trip.id === targetId
          ? {
              ...trip,
              title: `${toDateInput(targetDates[0]).slice(0, 7)} ${geoSummary.cities.length > 1 ? "欧洲多城" : geoSummary.cities[0]}旅行`,
              dateRange: { start: toDateInput(targetDates[0] ?? trip.dateRange.start), end: toDateInput(targetDates.at(-1) ?? trip.dateRange.end) },
              countries: geoSummary.countries.length ? geoSummary.countries : trip.countries,
              cities: geoSummary.cities,
            }
          : trip,
      );
    tripIdsToRebuild.add(targetId);
    changed = true;
      mergedAdjacentTrip = true;
      break;
    }
  }

  let placeNodes = state.placeNodes;
  let routes = state.routes;
  for (const tripId of tripIdsToRebuild) {
    const tripPhotos = photos.filter((photo) => photo.tripId === tripId);
    const located = tripPhotos.filter((photo) => photo.location);
    if (!located.length) continue;
    placeNodes = placeNodes.filter((place) => place.tripId !== tripId);
    routes = routes.filter((route) => route.tripId !== tripId);
    const places = buildPlacesForGroup(tripPhotos, tripId);
    placeNodes.push(...places);
    for (const photo of photos) {
      if (photo.tripId !== tripId) continue;
      const place = places.find((item) => item.photoIds.includes(photo.id));
      photo.placeNodeId = place?.id;
    }
    routes.push(buildPhotoRoute(tripId, located));
    changed = true;
  }

  if (changed) {
    await fs.writeFile(vectorPath, JSON.stringify(vectorIndex, null, 2), "utf8");
    repository.saveState(normalizeState({ ...state, photos, trips, placeNodes, routes }));
  }
}

function normalizeState(state) {
  const photos = safeArray(state.photos);
  const placeNodes = safeArray(state.placeNodes);
  const trips = safeArray(state.trips).map((trip) => ({
    ...trip,
    photoCount: photos.filter((photo) => photo.tripId === trip.id).length,
    placeNodeCount: placeNodes.filter((place) => place.tripId === trip.id).length,
  }));
  return {
    trips,
    photos,
    placeNodes,
    routes: safeArray(state.routes),
    importBatches: safeArray(state.importBatches),
    pendingItems: safeArray(state.pendingItems),
  };
}

function buildTimelineSegments(trips) {
  return trips
    .slice()
    .sort((a, b) => a.dateRange.start.localeCompare(b.dateRange.start))
    .map((trip) => ({
      id: `segment-${trip.id}`,
      label: trip.title.replace(/^20\d{2}\s*/, ""),
      start: trip.dateRange.start,
      end: trip.dateRange.end,
      granularity: "day",
      relatedType: "trip",
      relatedId: trip.id,
      photoCount: trip.photoCount,
    }));
}

async function responseState() {
  const state = await readState();
  return { ...state, timelineSegments: buildTimelineSegments(state.trips) };
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { ...corsHeaders, ...jsonHeaders, ...headers });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function dataUrlToBuffer(dataUrl = "") {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
  if (!match) return { mime: "application/octet-stream", buffer: Buffer.alloc(0) };
  const mime = match[1] || "application/octet-stream";
  const body = match[2] || "";
  return { mime, buffer: Buffer.from(body, dataUrl.includes(";base64,") ? "base64" : "utf8") };
}

function extFromName(name, mime) {
  const ext = path.extname(name || "").toLowerCase();
  if (ext) return ext;
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/heic") return ".heic";
  return ".jpg";
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function deterministicVector(text) {
  const hash = createHash("sha256").update(text).digest();
  return Array.from({ length: 64 }, (_, index) => (hash[index % hash.length] / 255) * 2 - 1);
}

function cosine(a, b) {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  return an && bn ? dot / (Math.sqrt(an) * Math.sqrt(bn)) : 0;
}

function haversineKm(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function isUsableLocation(location) {
  return (
    location &&
    Number.isFinite(location.lat) &&
    Number.isFinite(location.lng) &&
    Math.abs(location.lat) <= 90 &&
    Math.abs(location.lng) <= 180 &&
    !(Math.abs(location.lat) < 0.000001 && Math.abs(location.lng) < 0.000001)
  );
}

function inferPreset(name, location) {
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

function geoContextFor(preset, location) {
  if (!isUsableLocation(location)) {
    return {
      hasGps: false,
      cityHint: preset.city,
      countryHint: preset.country,
      instruction: "这张照片没有可用 GPS，只能根据画面内容和文件名判断，不要编造具体城市。",
    };
  }
  const distanceKm = haversineKm(location, preset.point);
  return {
    hasGps: true,
    lat: Number(location.lat.toFixed(6)),
    lng: Number(location.lng.toFixed(6)),
    cityHint: preset.city,
    countryHint: preset.country,
    distanceKm: Number(distanceKm.toFixed(1)),
    instruction:
      preset.city.includes("待确认")
        ? "GPS 位于欧洲范围但本地地名表无法精确到城市/小镇，请不要只输出欧洲/旅行/城市这类泛标签。"
        : `GPS 反查候选为 ${preset.country}${preset.city} 附近，距离候选中心约 ${distanceKm.toFixed(1)}km。`,
  };
}

function readAscii(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString("ascii").replace(/\0/g, "").trim();
}

function parseExif(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return {};
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1 && readAscii(buffer, offset + 4, 6).startsWith("Exif")) {
      return parseTiff(buffer.subarray(offset + 10, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return {};
}

function parseTiff(tiff) {
  if (tiff.length < 8) return {};
  const little = readAscii(tiff, 0, 2) === "II";
  const u16 = (o) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const rational = (o) => {
    const denominator = u32(o + 4);
    return denominator ? u32(o) / denominator : 0;
  };
  const parseIfd = (start) => {
    const entries = new Map();
    const count = u16(start);
    for (let i = 0; i < count; i += 1) {
      const entry = start + 2 + i * 12;
      entries.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), value: u32(entry + 8), raw: entry + 8 });
    }
    return entries;
  };
  const root = parseIfd(u32(4));
  const exifIfd = root.get(0x8769)?.value;
  const gpsIfd = root.get(0x8825)?.value;
  let capturedAt;
  if (exifIfd) {
    const exif = parseIfd(exifIfd);
    const date = exif.get(0x9003) ?? exif.get(0x0132);
    if (date) {
      const text = readAscii(tiff, date.count > 4 ? date.value : date.raw, date.count);
      const match = text.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (match) capturedAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
    }
  }
  let location;
  if (gpsIfd) {
    const gps = parseIfd(gpsIfd);
    const latRef = readAscii(tiff, gps.get(1)?.raw ?? 0, 2);
    const lat = gps.get(2);
    const lngRef = readAscii(tiff, gps.get(3)?.raw ?? 0, 2);
    const lng = gps.get(4);
    if (lat && lng) {
      const toDeg = (entry) => rational(entry.value) + rational(entry.value + 8) / 60 + rational(entry.value + 16) / 3600;
      location = {
        lat: toDeg(lat) * (latRef === "S" ? -1 : 1),
        lng: toDeg(lng) * (lngRef === "W" ? -1 : 1),
      };
    }
  }
  return { capturedAt, location };
}

function groupImportedPhotos(photos) {
  const sorted = photos.slice().sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  const groups = [];
  for (const photo of sorted) {
    const previous = groups.at(-1)?.at(-1);
    if (!previous || !photo.capturedAt || !previous.capturedAt) {
      groups.push([photo]);
      continue;
    }
    const gapDays = (new Date(photo.capturedAt).getTime() - new Date(previous.capturedAt).getTime()) / 86400000;
    if (gapDays > 14) groups.push([photo]);
    else groups.at(-1).push(photo);
  }
  return groups.length ? groups : [photos];
}

function dateMs(date) {
  const value = date ? new Date(date).getTime() : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function daysBetweenRanges(aStart, aEnd, bStart, bEnd) {
  const as = dateMs(aStart);
  const ae = dateMs(aEnd);
  const bs = dateMs(bStart);
  const be = dateMs(bEnd);
  if ([as, ae, bs, be].some((value) => value === undefined)) return Number.POSITIVE_INFINITY;
  if (ae >= bs && be >= as) return 0;
  return Math.min(Math.abs(bs - ae), Math.abs(as - be)) / 86400000;
}

function dominantPresetsForPhotos(photos) {
  const presets = photos
    .filter((photo) => isUsableLocation(photo.location))
    .map((photo) => inferPreset(photo.fileName, photo.location))
    .filter((preset) => !preset.city.includes("待确认"));
  const cityCounts = new Map();
  for (const preset of presets) cityCounts.set(preset.city, (cityCounts.get(preset.city) ?? 0) + 1);
  const rankedCities = Array.from(cityCounts.entries()).sort((a, b) => b[1] - a[1]).map(([city]) => city);
  return {
    cities: rankedCities.length ? rankedCities.slice(0, 6) : ["待确认地点"],
    countries: Array.from(new Set(presets.map((preset) => preset.country))).slice(0, 6),
  };
}

function findAdjacentTrip(state, group) {
  const dates = group.map((photo) => photo.capturedAt).filter(Boolean).sort();
  const groupStart = toDateInput(dates[0]);
  const groupEnd = toDateInput(dates.at(-1));
  return state.trips
    .filter((trip) => trip.source === "import")
    .map((trip) => ({ trip, gap: daysBetweenRanges(groupStart, groupEnd, trip.dateRange.start, trip.dateRange.end) }))
    .filter((item) => item.gap <= 14)
    .sort((a, b) => a.gap - b.gap)[0]?.trip;
}

function buildRoute(tripId, places) {
  return {
    id: `route-${tripId}`,
    tripId,
    points: places.map((place) => place.center),
    status: places.length > 1 ? "auto_generated" : "incomplete",
  };
}

function buildPhotoRoute(tripId, photos) {
  const points = photos
    .filter((photo) => photo.location)
    .sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""))
    .map((photo) => photo.location);
  const deduped = [];
  for (const point of points) {
    const previous = deduped.at(-1);
    if (!previous || haversineKm(previous, point) > 0.08) deduped.push(point);
  }
  return {
    id: `route-${tripId}`,
    tripId,
    points: deduped,
    status: deduped.length > 1 ? "auto_generated" : "incomplete",
  };
}

function buildPlacesForGroup(group, tripId) {
  const located = group
    .filter((photo) => photo.location)
    .sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  const clusters = [];
  for (const photo of located) {
    const last = clusters.at(-1);
    const previous = last?.photos.at(-1);
    const distance = previous?.location && photo.location ? haversineKm(previous.location, photo.location) : 0;
    if (!last || distance > 2.5 || last.photos.length >= 24) clusters.push({ photos: [photo] });
    else last.photos.push(photo);
  }
  return clusters.map((cluster, index) => {
    const center = cluster.photos.reduce((sum, photo) => ({ lat: sum.lat + photo.location.lat, lng: sum.lng + photo.location.lng }), { lat: 0, lng: 0 });
    center.lat /= cluster.photos.length;
    center.lng /= cluster.photos.length;
    const preset = inferPreset(cluster.photos[0]?.fileName, center);
    return {
      id: makeId("place"),
      tripId,
      name: `${preset.city}地点 ${index + 1}`,
      center,
      photoIds: cluster.photos.map((photo) => photo.id),
      timeRange: { start: cluster.photos[0]?.capturedAt, end: cluster.photos.at(-1)?.capturedAt },
      pending: cluster.photos.some((photo) => photo.pendingReason),
    };
  });
}

async function makeImportFilePayloadFromLocalFile(fullPath) {
  const buffer = await fs.readFile(fullPath);
  return {
    name: path.basename(fullPath),
    type: "image/jpeg",
    size: buffer.length,
    lastModified: (await fs.stat(fullPath)).mtimeMs,
    buffer,
  };
}

async function importPhotos(payload) {
  const state = await readState();
  const vectorIndex = await readVectorIndex();
  const now = new Date();
  const files = safeArray(payload.files).slice(0, 1000);
  if (files.length === 0) throw new Error("没有收到可导入图片。");

  const batchId = makeId("batch");
  const imported = [];
  const duplicateNames = [];
  const aiStats = {
    qwenCount: 0,
    fallbackCount: 0,
    embeddingCount: 0,
    qwenEmbeddingCount: 0,
    deterministicEmbeddingCount: 0,
  };
  const knownHashToPhoto = new Map(state.photos.filter((photo) => photo.originalHash).map((photo) => [photo.originalHash, photo]));
  const knownHashes = new Set(knownHashToPhoto.keys());
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const parsed = file.buffer ? { mime: file.type || "image/jpeg", buffer: file.buffer } : dataUrlToBuffer(file.dataUrl);
    const { mime, buffer } = parsed;
    const ext = extFromName(file.name, mime);
    const originalHash = hashBuffer(buffer);
    if (knownHashes.has(originalHash)) {
      duplicateNames.push(file.name || `duplicate-${index + 1}`);
      if (payload.reanalyzeDuplicates) {
        const existingPhoto = knownHashToPhoto.get(originalHash);
        if (existingPhoto) {
          const exif = parseExif(buffer);
          const parsedLocation = isUsableLocation(exif.location) ? exif.location : existingPhoto.location;
          const preset = inferPreset(file.name, parsedLocation);
          const dataUrl = file.dataUrl ?? `data:${mime};base64,${buffer.toString("base64")}`;
          const ai = await analyzeTravelImage({
            rootDir,
            fileName: file.name,
            mime,
            dataUrl,
            preset,
            geoContext: geoContextFor(preset, parsedLocation),
            allowCloud: payload.allowCloudAi !== false,
          });
          if (ai.provider === "qwen") aiStats.qwenCount += 1;
          else aiStats.fallbackCount += 1;
          if (Array.isArray(ai.embedding) && ai.embedding.length > 0) aiStats.embeddingCount += 1;
          if (ai.embeddingProvider === "qwen") aiStats.qwenEmbeddingCount += 1;
          else aiStats.deterministicEmbeddingCount += 1;
          existingPhoto.tags = ai.tags;
          existingPhoto.title = ai.title || makePhotoTitle(existingPhoto);
          existingPhoto.aiCaption = ai.caption;
          existingPhoto.aiProvider = ai.provider;
          existingPhoto.embeddingProvider = ai.embeddingProvider;
          existingPhoto.embeddingDimension = ai.embeddingDimension ?? ai.embedding?.length;
          existingPhoto.aiFallbackReason = ai.fallbackReason;
          if (parsedLocation && !existingPhoto.location) existingPhoto.location = parsedLocation;
          vectorIndex[existingPhoto.id] = ai.embedding;
        }
      }
      continue;
    }
    knownHashes.add(originalHash);
    const photoId = makeId("photo");
    const storageName = `${photoId}${ext}`;
    const thumbName = `${photoId}.jpg`;
    const storagePath = path.join(photoDir, storageName);
    const thumbPath = path.join(thumbDir, thumbName);
    await fs.writeFile(storagePath, buffer);
    const thumbnailSource = file.thumbnailDataUrl ? dataUrlToBuffer(file.thumbnailDataUrl).buffer : buffer;
    await fs.writeFile(thumbPath, thumbnailSource);
    const exif = parseExif(buffer);
    const parsedLocation = isUsableLocation(exif.location) ? exif.location : undefined;
    const preset = inferPreset(file.name, parsedLocation);
    const capturedAt =
      exif.capturedAt ??
      (file.lastModified ? new Date(file.lastModified).toISOString() : new Date(now.getTime() - (files.length - index) * 86400000).toISOString());
    const hasExifLocation = Boolean(parsedLocation);
    const location = parsedLocation;
    const dataUrl = file.dataUrl ?? `data:${mime};base64,${buffer.toString("base64")}`;
    const ai = await analyzeTravelImage({
      rootDir,
      fileName: file.name,
      mime,
      dataUrl,
      preset,
      geoContext: geoContextFor(preset, location),
      allowCloud: payload.allowCloudAi !== false,
    });
    if (ai.provider === "qwen") aiStats.qwenCount += 1;
    else aiStats.fallbackCount += 1;
    if (Array.isArray(ai.embedding) && ai.embedding.length > 0) aiStats.embeddingCount += 1;
    if (ai.embeddingProvider === "qwen") aiStats.qwenEmbeddingCount += 1;
    else aiStats.deterministicEmbeddingCount += 1;
    const photo = {
      id: photoId,
      fileName: file.name || storageName,
      title: ai.title || makePhotoTitle({ fileName: file.name || storageName, tags: ai.tags, aiCaption: ai.caption }),
      originalHash,
      mime,
      thumbnailUrl: `/data/thumbs/${thumbName}`,
      storageUrl: `/data/photos/${storageName}`,
      capturedAt,
      location,
      tags: ai.tags,
      aiCaption: ai.caption,
      aiProvider: ai.provider,
      embeddingProvider: ai.embeddingProvider,
      embeddingDimension: ai.embeddingDimension ?? ai.embedding?.length,
      aiFallbackReason: ai.fallbackReason,
      importedBatchId: batchId,
      pendingReason: !location ? "missing_gps" : !capturedAt ? "missing_time" : undefined,
      exifStatus: {
        time: exif.capturedAt ? "read" : "fallback",
        gps: hasExifLocation ? "read" : "missing",
      },
    };
    vectorIndex[photo.id] = ai.embedding;
    imported.push(photo);
  }

  const groups = imported.length ? groupImportedPhotos(imported) : [];
  const createdTrips = [];
  const updatedTripIds = new Set();
  const createdPlaces = [];
  const createdRoutes = [];
  const pendingItems = [];
  let workingTrips = state.trips.slice();
  let workingPhotos = [...state.photos, ...imported];
  let workingPlaceNodes = state.placeNodes.slice();
  let workingRoutes = state.routes.slice();

  for (const [groupIndex, group] of groups.entries()) {
    const first = group[0];
    const firstLocated = group.find((photo) => photo.location);
    const preset = inferPreset(first.fileName, firstLocated?.location);
    const start = toDateInput(group[0]?.capturedAt);
    const end = toDateInput(group.at(-1)?.capturedAt);
    const adjacentTrip = findAdjacentTrip({ ...state, trips: workingTrips }, group);
    const tripId = adjacentTrip?.id ?? makeId("trip");
    const title = `${start.slice(0, 7)} ${preset.city}旅行${groups.length > 1 ? ` ${groupIndex + 1}` : ""}`;
    let trip = adjacentTrip;
    if (!trip) {
      trip = {
        id: tripId,
        title,
        dateRange: { start, end },
        countries: [preset.country],
        cities: [preset.city],
        coverUrl: first.thumbnailUrl,
        photoCount: group.length,
        placeNodeCount: 0,
        status: "pending",
        source: "import",
      };
      createdTrips.push(trip);
      workingTrips.push(trip);
    } else {
      updatedTripIds.add(tripId);
    }
    for (const photo of group) photo.tripId = tripId;
    const tripPhotosAfter = workingPhotos.filter((photo) => photo.tripId === tripId);
    const tripLocatedAfter = tripPhotosAfter.filter((photo) => photo.location);
    if (tripLocatedAfter.length) {
      const places = buildPlacesForGroup(tripPhotosAfter, tripId);
      workingPlaceNodes = workingPlaceNodes.filter((place) => place.tripId !== tripId).concat(places);
      workingRoutes = workingRoutes.filter((route) => route.tripId !== tripId).concat(buildPhotoRoute(tripId, tripLocatedAfter));
      createdPlaces.push(...places.filter((place) => place.photoIds.some((id) => group.some((photo) => photo.id === id))));
      createdRoutes.push(buildPhotoRoute(tripId, tripLocatedAfter));
      for (const photo of tripPhotosAfter) photo.placeNodeId = undefined;
      for (const place of places) {
        for (const photoId of place.photoIds) {
          const photo = tripPhotosAfter.find((item) => item.id === photoId);
          if (photo) photo.placeNodeId = place.id;
        }
      }
    }
    const tripDates = tripPhotosAfter.map((photo) => photo.capturedAt).filter(Boolean).sort();
    const geoSummary = dominantPresetsForPhotos(tripPhotosAfter);
    workingTrips = workingTrips.map((item) =>
      item.id === tripId
        ? {
            ...item,
            title: adjacentTrip ? `${toDateInput(tripDates[0]).slice(0, 7)} ${geoSummary.cities.length > 1 ? "欧洲多城" : geoSummary.cities[0]}旅行` : item.title,
            dateRange: { start: toDateInput(tripDates[0] ?? start), end: toDateInput(tripDates.at(-1) ?? end) },
            countries: geoSummary.countries.length ? geoSummary.countries : item.countries,
            cities: geoSummary.cities,
            coverUrl: item.coverUrl || first.thumbnailUrl,
          }
        : item,
    );
    pendingItems.push({
      id: makeId("pending"),
      type: "needs_trip_confirmation",
      relatedPhotoIds: group.map((photo) => photo.id),
      relatedTripId: tripId,
      suggestion: adjacentTrip ? `建议把这次导入追加到已有旅行档案「${adjacentTrip.title}」。` : `建议创建新的旅行档案「${title}」。`,
      reason: "系统基于拍摄时间、GPS/文件名地点线索和 Qwen 标签给出建议，需要用户确认。",
      status: "open",
    });
  }

  const missing = imported.filter((photo) => photo.pendingReason);
  if (missing.length) {
    pendingItems.push({
      id: makeId("pending"),
      type: "missing_gps",
      relatedPhotoIds: missing.map((photo) => photo.id),
      relatedTripId: missing[0].tripId,
      suggestion: `${missing.length} 张照片缺少 GPS，需要手动标点或绑定到地点节点。`,
      reason: "EXIF 未读取到可靠坐标，系统不会静默推断确定地点。",
      status: "open",
    });
  }
  if (groups.length > 1 || imported.length >= 6) {
    pendingItems.push({
      id: makeId("pending"),
      type: "split_suggestion",
      relatedPhotoIds: imported.map((photo) => photo.id),
      suggestion: groups.length > 1 ? `这批照片可能包含 ${groups.length} 段旅行，已按明显时间断层拆成多个待确认 Trip。` : "这批照片数量较多，可能包含多段旅行，请确认是否仍保留为当前归档建议。",
      reason: "MVP 使用明显时间断层作为拆分建议依据，不做强制静默拆分。",
      status: "open",
    });
  }
  const recent = imported.some((photo) => Math.abs(now.getTime() - new Date(photo.capturedAt).getTime()) <= 24 * 60 * 60 * 1000);
  if (recent) {
    pendingItems.push({
      id: makeId("pending"),
      type: "recent_import",
      relatedPhotoIds: imported.map((photo) => photo.id),
      relatedTripId: createdTrips[0]?.id,
      suggestion: "这批照片拍摄于最近 24 小时内，可加入当前旅行、新建正在进行的旅行，或暂不归档。",
      reason: "近期照片归属必须由用户确认。",
      status: "open",
    });
  }

  const batch = {
    id: batchId,
    importedAt: now.toISOString(),
    totalCount: files.length,
    successCount: imported.length - missing.length,
    failedCount: missing.length,
    duplicateCount: duplicateNames.length,
    status: imported.length > 0 ? "pending_confirmation" : "confirmed",
    createdTripIds: createdTrips.map((trip) => trip.id),
    updatedTripIds: Array.from(updatedTripIds),
    addedPhotoIds: imported.map((photo) => photo.id),
    pendingItemIds: pendingItems.map((item) => item.id),
    storedFileNames: imported.map((photo) => path.basename(photo.storageUrl)),
    storedThumbnailNames: imported.map((photo) => path.basename(photo.thumbnailUrl)),
    aiStats,
    summary:
      imported.length > 0
        ? `新增 ${imported.length} 张照片，跳过 ${duplicateNames.length} 张重复照片，创建 ${createdTrips.length} 个待确认旅行档案，${missing.length} 张需要补充时间或地点。`
        : `没有新增照片，已跳过 ${duplicateNames.length} 张重复照片；其中 ${aiStats.qwenCount + aiStats.fallbackCount} 张完成了 AI 重新分析。`,
  };

  await writeVectorIndex(vectorIndex);
  await writeState({
    ...state,
    trips: workingTrips,
    photos: workingPhotos,
    placeNodes: workingPlaceNodes,
    routes: workingRoutes,
    importBatches: [...state.importBatches, batch],
    pendingItems: [...state.pendingItems, ...pendingItems],
  });
  return responseState();
}

function startImportJob(payload) {
  const id = makeId("job");
  const job = {
    id,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: undefined,
    error: undefined,
  };
  importJobs.set(id, job);
  repository.saveImportJob(job);
  setTimeout(async () => {
    const current = importJobs.get(id);
    if (!current) return;
    current.status = "processing";
    current.updatedAt = new Date().toISOString();
    try {
      current.result = await importPhotos(payload);
      current.status = "completed";
    } catch (error) {
      current.status = "failed";
      current.error = error instanceof Error ? error.message : "import job failed";
    }
    current.updatedAt = new Date().toISOString();
    repository.saveImportJob(current);
  }, 0);
  return job;
}

function getImportJob(id) {
  const job = importJobs.get(id);
  return job ?? repository.getImportJob(id);
}

async function importAppleTestPhotos(options = {}) {
  const appleDir = path.join(rootDir, "DESIGN_SPECS", "photo test", "apple");
  const entries = await fs.readdir(appleDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && /\.(jpe?g|png|heic)$/i.test(entry.name)) {
      files.push(await makeImportFilePayloadFromLocalFile(path.join(appleDir, entry.name)));
    }
  }
  const limitedFiles = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? files.slice(0, Number(options.limit)) : files;
  return importPhotos({
    files: limitedFiles,
    source: "apple-test",
    allowCloudAi: Boolean(options.allowCloudAi) || process.env.EARTH_ONLINE_TEST_CLOUD_AI === "1",
    reanalyzeDuplicates: Boolean(options.allowCloudAi),
  });
}

async function confirmImport(id) {
  const state = await readState();
  const batch = state.importBatches.find((item) => item.id === id);
  if (!batch || batch.status !== "pending_confirmation") return responseState();
  await writeState({
    ...state,
    trips: state.trips.map((trip) => (batch.createdTripIds.includes(trip.id) ? { ...trip, status: "confirmed" } : trip)),
    importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "confirmed" } : item)),
  });
  return responseState();
}

async function rollbackImport(id) {
  const state = await readState();
  const batch = state.importBatches.find((item) => item.id === id);
  const latestPending = state.importBatches.filter((item) => item.status === "pending_confirmation").at(-1);
  if (!batch || batch.id !== latestPending?.id) throw new Error("MVP 只支持回撤最近一次待确认导入。");
  const photoIds = new Set(batch.addedPhotoIds);
  const tripIds = new Set(batch.createdTripIds);
  const pendingIds = new Set(batch.pendingItemIds);
  for (const name of safeArray(batch.storedFileNames)) {
    await fs.rm(path.join(photoDir, path.basename(name)), { force: true });
  }
  for (const name of safeArray(batch.storedThumbnailNames)) {
    await fs.rm(path.join(thumbDir, path.basename(name)), { force: true });
  }
  const vectorIndex = await readVectorIndex();
  for (const id of photoIds) delete vectorIndex[id];
  await writeVectorIndex(vectorIndex);
  await writeState({
    ...state,
    photos: state.photos.filter((photo) => !photoIds.has(photo.id)),
    trips: state.trips.filter((trip) => !tripIds.has(trip.id)),
    placeNodes: state.placeNodes.filter((place) => !tripIds.has(place.tripId)),
    routes: state.routes.filter((route) => !tripIds.has(route.tripId)),
    pendingItems: state.pendingItems.filter((item) => !pendingIds.has(item.id)),
    importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "rolled_back" } : item)),
  });
  return responseState();
}

async function createTrip(body) {
  const state = await readState();
  const trip = {
    id: makeId("manual-trip"),
    title: body.title?.trim() || "未命名旅行档案",
    dateRange: { start: body.start, end: body.end },
    countries: ["待确认"],
    cities: ["手动标记"],
    coverUrl: "https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=1200&q=82",
    photoCount: 0,
    placeNodeCount: 0,
    status: "draft",
    source: "manual",
  };
  await writeState({ ...state, trips: [...state.trips, trip] });
  return responseState();
}

async function patchTrip(id, body) {
  const state = await readState();
  await writeState({
    ...state,
    trips: state.trips.map((trip) =>
      trip.id === id
        ? {
            ...trip,
            title: body.title?.trim() || trip.title,
            dateRange: body.dateRange ?? trip.dateRange,
          }
        : trip,
    ),
  });
  return responseState();
}

async function createPlace(body) {
  const state = await readState();
  const now = new Date().toISOString();
  const place = {
    id: makeId("manual-place"),
    tripId: body.tripId,
    name: body.name?.trim() || "手动地点",
    center: { lat: Number(body.lat), lng: Number(body.lng) },
    photoIds: [],
    timeRange: { start: now, end: now },
    pending: false,
  };
  const placeNodes = [...state.placeNodes, place];
  const tripPlaces = placeNodes.filter((item) => item.tripId === body.tripId);
  const routes = state.routes.filter((route) => route.tripId !== body.tripId).concat(buildRoute(body.tripId, tripPlaces));
  await writeState({ ...state, placeNodes, routes });
  return responseState();
}

async function deletePlace(placeId) {
  const state = await readState();
  const place = state.placeNodes.find((item) => item.id === placeId);
  if (!place) return responseState();
  const placeNodes = state.placeNodes.filter((item) => item.id !== placeId);
  const tripPlaces = placeNodes.filter((item) => item.tripId === place.tripId);
  const routes = state.routes.filter((route) => route.tripId !== place.tripId).concat(buildRoute(place.tripId, tripPlaces));
  await writeState({
    ...state,
    photos: state.photos.map((photo) => (photo.placeNodeId === placeId ? { ...photo, placeNodeId: undefined } : photo)),
    placeNodes,
    routes,
  });
  return responseState();
}

async function reorderPlaces(tripId, body) {
  const state = await readState();
  const order = safeArray(body.placeIds);
  const owned = state.placeNodes.filter((place) => place.tripId === tripId);
  const byId = new Map(owned.map((place) => [place.id, place]));
  const orderedOwned = order.map((id) => byId.get(id)).filter(Boolean);
  for (const place of owned) {
    if (!orderedOwned.some((item) => item.id === place.id)) orderedOwned.push(place);
  }
  const other = state.placeNodes.filter((place) => place.tripId !== tripId);
  const placeNodes = [...other, ...orderedOwned];
  const routes = state.routes.filter((route) => route.tripId !== tripId).concat(buildRoute(tripId, orderedOwned));
  await writeState({ ...state, placeNodes, routes });
  return responseState();
}

async function movePhoto(photoId, body) {
  const state = await readState();
  await writeState({
    ...state,
    photos: state.photos.map((photo) => (photo.id === photoId ? { ...photo, tripId: body.tripId, placeNodeId: undefined } : photo)),
    placeNodes: state.placeNodes.map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => id !== photoId) })),
  });
  return responseState();
}

async function patchPhoto(photoId, body) {
  const state = await readState();
  const lat = body.location?.lat === "" || body.location?.lat === undefined ? undefined : Number(body.location.lat);
  const lng = body.location?.lng === "" || body.location?.lng === undefined ? undefined : Number(body.location.lng);
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
  await writeState({
    ...state,
    photos: state.photos.map((photo) =>
      photo.id === photoId
        ? {
            ...photo,
            capturedAt: body.capturedAt === "" ? undefined : body.capturedAt ?? photo.capturedAt,
            location: body.location === undefined ? photo.location : hasLocation ? { lat, lng } : undefined,
            tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : photo.tags,
            pendingReason: hasLocation && (body.capturedAt ?? photo.capturedAt) ? undefined : photo.pendingReason,
          }
        : photo,
    ),
  });
  return responseState();
}

async function bindPhoto(photoId, body) {
  const state = await readState();
  const place = state.placeNodes.find((item) => item.id === body.placeId);
  await writeState({
    ...state,
    photos: state.photos.map((photo) =>
      photo.id === photoId
        ? { ...photo, tripId: place?.tripId ?? photo.tripId, placeNodeId: place?.id, location: place?.center ?? photo.location, pendingReason: undefined }
        : photo,
    ),
    placeNodes: state.placeNodes.map((item) => ({
      ...item,
      photoIds: item.id === body.placeId ? Array.from(new Set([...item.photoIds, photoId])) : item.photoIds.filter((id) => id !== photoId),
      pending: item.id === body.placeId ? false : item.pending,
    })),
  });
  return responseState();
}

async function updatePending(id, body) {
  const state = await readState();
  await writeState({
    ...state,
    pendingItems: state.pendingItems.map((item) => (item.id === id ? { ...item, status: body.accepted ? "accepted" : "ignored" } : item)),
  });
  return responseState();
}

async function mergeImportTrips(batchId) {
  const state = await readState();
  const batch = state.importBatches.find((item) => item.id === batchId);
  if (!batch || batch.createdTripIds.length <= 1) return responseState();
  const [targetTripId, ...removeTripIds] = batch.createdTripIds;
  const removeSet = new Set(removeTripIds);
  const batchPhotos = state.photos.filter((photo) => batch.addedPhotoIds.includes(photo.id));
  const dates = batchPhotos.map((photo) => photo.capturedAt).filter(Boolean).sort();
  const placeNodes = state.placeNodes.map((place) => (removeSet.has(place.tripId) ? { ...place, tripId: targetTripId } : place));
  const targetPlaces = placeNodes.filter((place) => place.tripId === targetTripId);
  const routes = state.routes.filter((route) => !batch.createdTripIds.includes(route.tripId)).concat(buildRoute(targetTripId, targetPlaces));
  await writeState({
    ...state,
    photos: state.photos.map((photo) => (batch.addedPhotoIds.includes(photo.id) ? { ...photo, tripId: targetTripId } : photo)),
    trips: state.trips
      .filter((trip) => !removeSet.has(trip.id))
      .map((trip) =>
        trip.id === targetTripId
          ? {
              ...trip,
              title: trip.title.replace(/\s+\d+$/, ""),
              dateRange: { start: toDateInput(dates[0]), end: toDateInput(dates.at(-1)) },
              cities: Array.from(new Set(state.trips.filter((item) => batch.createdTripIds.includes(item.id)).flatMap((item) => item.cities))),
              countries: Array.from(new Set(state.trips.filter((item) => batch.createdTripIds.includes(item.id)).flatMap((item) => item.countries))),
            }
          : trip,
      ),
    placeNodes,
    routes,
    importBatches: state.importBatches.map((item) => (item.id === batchId ? { ...item, createdTripIds: [targetTripId], summary: `${item.summary} 已按用户选择合并为一个旅行档案。` } : item)),
    pendingItems: state.pendingItems.map((item) => (item.type === "split_suggestion" && batch.pendingItemIds.includes(item.id) ? { ...item, status: "accepted" } : item)),
  });
  return responseState();
}

async function search(params) {
  const q = params.get("q") ?? "";
  const state = await readState();
  const vectorIndex = await readVectorIndex();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const queryVector = await embedSearchQuery(q, { rootDir, allowCloud: true });
  const tripId = params.get("tripId") || undefined;
  const placeId = params.get("placeId") || undefined;
  const date = params.get("date") || undefined;
  const tag = params.get("tag")?.toLowerCase() || undefined;
  const fileName = params.get("fileName")?.toLowerCase() || undefined;
  const results = state.photos
    .filter((photo) => !tripId || photo.tripId === tripId)
    .filter((photo) => !placeId || photo.placeNodeId === placeId)
    .filter((photo) => !date || photo.capturedAt?.slice(0, 10) === date)
    .filter((photo) => !tag || photo.tags?.some((item) => item.toLowerCase().includes(tag)))
    .filter((photo) => !fileName || photo.fileName.toLowerCase().includes(fileName))
    .map((photo) => {
      const trip = state.trips.find((item) => item.id === photo.tripId);
      const place = state.placeNodes.find((item) => item.id === photo.placeNodeId);
      const text = [photo.title, photo.fileName, photo.aiCaption, photo.tags?.join(" "), trip?.title, trip?.cities?.join(" "), place?.name, photo.capturedAt]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const termScore = terms.length ? terms.filter((term) => text.includes(term)).length / terms.length : 1;
      const vectorScore = vectorIndex[photo.id] ? (cosine(queryVector, vectorIndex[photo.id]) + 1) / 2 : 0;
      const score = 0.6 * vectorScore + 0.4 * termScore;
      return {
        id: `result-${photo.id}`,
        photoId: photo.id,
        tripId: photo.tripId,
        reason: termScore > 0 ? `命中 ${photo.tags.slice(0, 3).join(" / ")}，可跳转到地球和时间轴。` : `Qwen 向量索引返回相近旅行记忆。`,
        score,
      };
    })
    .filter((item) => item.score > 0.25 || !q.trim())
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);
  return { results };
}

async function servePhoto(res, pathname) {
  const isThumb = pathname.startsWith("/data/thumbs/");
  const baseDir = isThumb ? thumbDir : photoDir;
  const file = path.basename(decodeURIComponent(pathname.replace(isThumb ? "/data/thumbs/" : "/data/photos/", "")));
  const fullPath = path.join(baseDir, file);
  if (!fullPath.startsWith(baseDir) || !existsSync(fullPath)) {
    res.writeHead(404, corsHeaders);
    res.end("not found");
    return;
  }
  const ext = path.extname(fullPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  res.writeHead(200, { ...corsHeaders, "content-type": mime, "cache-control": "public, max-age=31536000" });
  res.end(await fs.readFile(fullPath));
}

async function serveStatic(req, res, pathname) {
  const dist = path.join(rootDir, "dist");
  const target = pathname === "/" ? "index.html" : pathname.slice(1);
  const fullPath = path.resolve(dist, target);
  if (!fullPath.startsWith(dist) || !existsSync(fullPath)) return false;
  const ext = path.extname(fullPath);
  const mime = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".html" ? "text/html" : "application/octet-stream";
  res.writeHead(200, { "content-type": `${mime}; charset=utf-8` });
  res.end(await fs.readFile(fullPath));
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;
    if (pathname.startsWith("/data/photos/") || pathname.startsWith("/data/thumbs/")) return servePhoto(res, pathname);
    if (req.method === "GET" && pathname === "/api/state") return send(res, 200, await responseState());
    if (req.method === "GET" && pathname === "/api/search") return send(res, 200, await search(url.searchParams));
    if (req.method === "POST" && pathname === "/api/import") return send(res, 200, await importPhotos(await readBody(req)));
    if (req.method === "POST" && pathname === "/api/import/jobs") return send(res, 202, startImportJob(await readBody(req)));
    const importJob = pathname.match(/^\/api\/import\/jobs\/([^/]+)$/);
    if (req.method === "GET" && importJob) {
      const job = getImportJob(importJob[1]);
      return job ? send(res, 200, job) : sendError(res, 404, "Import job not found");
    }
    if (req.method === "POST" && pathname === "/api/import/apple-test") return send(res, 200, await importAppleTestPhotos(await readBody(req)));
    const importConfirm = pathname.match(/^\/api\/import\/([^/]+)\/confirm$/);
    if (req.method === "POST" && importConfirm) return send(res, 200, await confirmImport(importConfirm[1]));
    const importRollback = pathname.match(/^\/api\/import\/([^/]+)\/rollback$/);
    if (req.method === "POST" && importRollback) return send(res, 200, await rollbackImport(importRollback[1]));
    const importMerge = pathname.match(/^\/api\/import\/([^/]+)\/merge$/);
    if (req.method === "POST" && importMerge) return send(res, 200, await mergeImportTrips(importMerge[1]));
    if (req.method === "POST" && pathname === "/api/trips") return send(res, 200, await createTrip(await readBody(req)));
    const tripPatch = pathname.match(/^\/api\/trips\/([^/]+)$/);
    if (req.method === "PATCH" && tripPatch) return send(res, 200, await patchTrip(tripPatch[1], await readBody(req)));
    if (req.method === "POST" && pathname === "/api/places") return send(res, 200, await createPlace(await readBody(req)));
    const placeDelete = pathname.match(/^\/api\/places\/([^/]+)\/delete$/);
    if (req.method === "POST" && placeDelete) return send(res, 200, await deletePlace(placeDelete[1]));
    const placeReorder = pathname.match(/^\/api\/trips\/([^/]+)\/reorder-places$/);
    if (req.method === "POST" && placeReorder) return send(res, 200, await reorderPlaces(placeReorder[1], await readBody(req)));
    const photoMove = pathname.match(/^\/api\/photos\/([^/]+)\/move$/);
    if (req.method === "POST" && photoMove) return send(res, 200, await movePhoto(photoMove[1], await readBody(req)));
    const photoPatch = pathname.match(/^\/api\/photos\/([^/]+)$/);
    if (req.method === "PATCH" && photoPatch) return send(res, 200, await patchPhoto(photoPatch[1], await readBody(req)));
    const photoBind = pathname.match(/^\/api\/photos\/([^/]+)\/bind-place$/);
    if (req.method === "POST" && photoBind) return send(res, 200, await bindPhoto(photoBind[1], await readBody(req)));
    const pendingPatch = pathname.match(/^\/api\/pending\/([^/]+)$/);
    if (req.method === "POST" && pendingPatch) return send(res, 200, await updatePending(pendingPatch[1], await readBody(req)));
    if (req.method === "GET" && (await serveStatic(req, res, pathname))) return;
    sendError(res, 404, "Not found");
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : "Server error");
  }
});

await ensureStorage();
server.listen(port, "127.0.0.1", () => {
  console.log(`Earth_Online API listening on http://127.0.0.1:${port}`);
});

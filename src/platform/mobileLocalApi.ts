import type {
  AiConfig,
  AiSettings,
  AppSnapshot,
  EmbeddingRebuildReport,
  ImportJobProgress,
  LocalAiSettings,
  ProviderCredentialKey,
  StorageSettings,
} from "@/services/apiClient";
import type { NativePhotoAsset } from "@/platform/nativePhotoLibrary";
import { releaseNativePhotoPermissions } from "@/platform/nativePhotoLibrary";
import desktopAiCatalog from "../../server/ai/model-catalog.json";
import type {
  DossierTripGroup,
  GeoPoint,
  GlobeMarker,
  ImportBatch,
  LocationCandidate,
  PendingItem,
  Photo,
  PlaceNode,
  Route,
  SearchDocument,
  SearchResult,
  TimelineSegment,
  Trip,
} from "@/domain/models";

type MobilePersistedState = {
  trips: Trip[];
  photos: Photo[];
  placeNodes: PlaceNode[];
  routes: Route[];
  importBatches: ImportBatch[];
  pendingItems: PendingItem[];
};

type ExifResult = {
  capturedAt?: string;
  location?: GeoPoint;
};

type AiSettingsUpdateBody = {
  credentials?: Partial<Record<ProviderCredentialKey, string>>;
  profileCredentials?: Partial<Record<"imageUnderstanding" | "crossModalEmbedding", Partial<Record<ProviderCredentialKey, string>>>>;
  aiConfig?: Partial<AiConfig> | AiConfig;
};

type ProfileKey = keyof AiConfig["profiles"];

const stateKey = "earth-online-mobile-state-v1";
const aiSettingsKey = "earth-online-mobile-ai-settings-v1";
const mobileDbName = "earth-online-mobile-db";
const mobileDbVersion = 1;
const mobileKvStore = "kv";
const photoThumbKeyPrefix = "earth-online-mobile-photo-thumb:";
const maxThumbSize = 720;

const providerKeys: ProviderCredentialKey[] = ["aliyunApiKey", "openaiApiKey", "openrouterApiKey", "siliconflowApiKey", "voyageApiKey"];
const mobileAiCatalog = desktopAiCatalog as AiConfig["catalog"];

function hasOwn(object: object | undefined, key: string) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyPersistedState(): MobilePersistedState {
  return {
    trips: [],
    photos: [],
    placeNodes: [],
    routes: [],
    importBatches: [],
    pendingItems: [],
  };
}

let cachedState: MobilePersistedState | undefined;
let stateHydration: Promise<MobilePersistedState> | undefined;

function openMobileDb() {
  if (typeof window === "undefined" || !window.indexedDB) return Promise.resolve(undefined);
  return new Promise<IDBDatabase | undefined>((resolve) => {
    const request = window.indexedDB.open(mobileDbName, mobileDbVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(mobileKvStore)) db.createObjectStore(mobileKvStore);
    };
    request.onerror = () => resolve(undefined);
    request.onsuccess = () => resolve(request.result);
  });
}

async function readKv<T>(key: string): Promise<T | undefined> {
  const db = await openMobileDb();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve) => {
    const transaction = db.transaction(mobileKvStore, "readonly");
    const request = transaction.objectStore(mobileKvStore).get(key);
    request.onerror = () => resolve(undefined);
    request.onsuccess = () => resolve(request.result as T | undefined);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
  });
}

async function writeManyKv(entries: Array<[string, unknown]>) {
  const db = await openMobileDb();
  if (!db || !entries.length) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(mobileKvStore, "readwrite");
    const store = transaction.objectStore(mobileKvStore);
    for (const [key, value] of entries) store.put(value, key);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
  });
}

async function readManyKv<T>(keys: string[]) {
  const db = await openMobileDb();
  const values = new Map<string, T>();
  if (!db || !keys.length) return values;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(mobileKvStore, "readonly");
    const store = transaction.objectStore(mobileKvStore);
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result !== undefined) values.set(key, request.result as T);
      };
    }
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
  });
  return values;
}

async function deleteManyKv(keys: string[]) {
  const db = await openMobileDb();
  if (!db || !keys.length) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(mobileKvStore, "readwrite");
    const store = transaction.objectStore(mobileKvStore);
    for (const key of keys) store.delete(key);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
  });
}

function readPersistedState(): MobilePersistedState {
  if (cachedState) return cachedState;
  if (typeof window === "undefined") return emptyPersistedState();
  const raw = window.localStorage.getItem(stateKey);
  if (!raw) return emptyPersistedState();
  try {
    const parsed = JSON.parse(raw) as Partial<MobilePersistedState>;
    const next = {
      trips: Array.isArray(parsed.trips) ? parsed.trips : [],
      photos: Array.isArray(parsed.photos) ? parsed.photos : [],
      placeNodes: Array.isArray(parsed.placeNodes) ? parsed.placeNodes : [],
      routes: Array.isArray(parsed.routes) ? parsed.routes : [],
      importBatches: Array.isArray(parsed.importBatches) ? parsed.importBatches : [],
      pendingItems: Array.isArray(parsed.pendingItems) ? parsed.pendingItems : [],
    };
    cachedState = next;
    return next;
  } catch {
    return emptyPersistedState();
  }
}

async function getPersistedState(): Promise<MobilePersistedState> {
  if (cachedState) return cachedState;
  stateHydration ??= (async () => {
    const indexedState = await readKv<MobilePersistedState>(stateKey);
    if (indexedState) {
      cachedState = await hydratePhotoThumbnails({
        ...emptyPersistedState(),
        ...indexedState,
        trips: Array.isArray(indexedState.trips) ? indexedState.trips : [],
        photos: Array.isArray(indexedState.photos) ? indexedState.photos : [],
        placeNodes: Array.isArray(indexedState.placeNodes) ? indexedState.placeNodes : [],
        routes: Array.isArray(indexedState.routes) ? indexedState.routes : [],
        importBatches: Array.isArray(indexedState.importBatches) ? indexedState.importBatches : [],
        pendingItems: Array.isArray(indexedState.pendingItems) ? indexedState.pendingItems : [],
      });
      return cachedState;
    }
    return readPersistedState();
  })();
  return stateHydration;
}

async function hydratePhotoThumbnails(state: MobilePersistedState): Promise<MobilePersistedState> {
  const keys = state.photos.filter((photo) => !photo.thumbnailUrl).map((photo) => `${photoThumbKeyPrefix}${photo.id}`);
  if (!keys.length) return state;
  const thumbnails = await readManyKv<string>(keys);
  return {
    ...state,
    photos: state.photos.map((photo) => ({
      ...photo,
      thumbnailUrl: photo.thumbnailUrl || thumbnails.get(`${photoThumbKeyPrefix}${photo.id}`) || photo.sourceWebPath || photo.storageUrl || "",
    })),
  };
}

function stripPhotoThumbnail(photo: Photo): Photo {
  if (!photo.thumbnailUrl.startsWith("data:")) return photo;
  return { ...photo, thumbnailUrl: "" };
}

async function writePersistedState(state: MobilePersistedState) {
  cachedState = state;
  const storedState = { ...state, photos: state.photos.map(stripPhotoThumbnail) };
  const thumbnailEntries = state.photos
    .filter((photo) => photo.thumbnailUrl.startsWith("data:"))
    .map<[string, string]>((photo) => [`${photoThumbKeyPrefix}${photo.id}`, photo.thumbnailUrl]);
  await writeManyKv([[stateKey, storedState], ...thumbnailEntries]);
  try {
    window.localStorage.setItem(stateKey, JSON.stringify(storedState));
  } catch {
    window.localStorage.removeItem(stateKey);
  }
}

function deleteThumbnailsForPhotos(photos: Photo[]) {
  void deleteManyKv(photos.map((photo) => `${photoThumbKeyPrefix}${photo.id}`));
}

function toDateInput(value?: string) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function midpoint(points: GeoPoint[]): GeoPoint {
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

function buildTimelineSegments(state: MobilePersistedState): TimelineSegment[] {
  const tripSegments = state.trips.map<TimelineSegment>((trip) => ({
    id: `timeline-${trip.id}`,
    label: trip.title,
    start: trip.dateRange.start,
    end: trip.dateRange.end,
    granularity: "month",
    relatedType: "trip",
    relatedId: trip.id,
    photoCount: trip.photoCount,
    status: trip.status === "confirmed" || trip.status === "archived" ? "confirmed" : "suggested",
  }));

  const placeSegments = state.placeNodes.map<TimelineSegment>((place) => ({
    id: `timeline-${place.id}`,
    label: place.displayName ?? place.name,
    start: place.timeRange.start,
    end: place.timeRange.end,
    granularity: "day",
    relatedType: "place",
    relatedId: place.id,
    photoCount: place.photoIds.length,
    status: place.pending ? "suggested" : "confirmed",
  }));

  return [...tripSegments, ...placeSegments].sort((left, right) => left.start.localeCompare(right.start));
}

function buildGlobeMarkers(state: MobilePersistedState): GlobeMarker[] {
  return state.placeNodes
    .filter((place) => Number.isFinite(place.center.lat) && Number.isFinite(place.center.lng))
    .map((place) => ({
      id: `marker-${place.id}`,
      kind: "place",
      label: place.displayName ?? place.name,
      center: place.center,
      count: place.photoIds.length,
      photoIds: place.photoIds,
      placeIds: [place.id],
      tripId: place.tripId,
      countryName: place.country,
      countryNames: place.countryNames,
      startTime: place.timeRange.start,
      endTime: place.timeRange.end,
      status: place.pending ? "suggested" : "confirmed",
    }));
}

function buildDossierGroups(state: MobilePersistedState): DossierTripGroup[] {
  return state.trips.map((trip) => {
    const tripPhotos = state.photos.filter((photo) => photo.tripId === trip.id);
    const days = new Map<string, { country: string; photoIds: string[]; placeIds: Set<string>; status: "confirmed" | "suggested" | "missing" }>();
    for (const photo of tripPhotos) {
      const day = toDateInput(photo.capturedAt);
      const country = trip.countries[0] ?? "待确认";
      const current = days.get(day) ?? { country, photoIds: [], placeIds: new Set<string>(), status: photo.location ? "confirmed" : "missing" };
      current.photoIds.push(photo.id);
      if (photo.placeNodeId) current.placeIds.add(photo.placeNodeId);
      if (!photo.location) current.status = "missing";
      days.set(day, current);
    }
    return {
      tripId: trip.id,
      countries: [
        {
          country: trip.countries[0] ?? "待确认",
          days: [...days.entries()].map(([day, group]) => ({
            day,
            country: group.country,
            photoIds: group.photoIds,
            placeIds: [...group.placeIds],
            status: group.status,
          })),
        },
      ],
    };
  });
}

function buildSearchDocuments(state: MobilePersistedState): SearchDocument[] {
  return state.photos.map((photo) => {
    const place = photo.placeNodeId ? state.placeNodes.find((item) => item.id === photo.placeNodeId) : undefined;
    return {
      id: `search-${photo.id}`,
      photoId: photo.id,
      tripId: photo.tripId,
      placeNodeId: photo.placeNodeId,
      capturedAt: photo.capturedAt,
      tags: photo.tags,
      locationNames: [place?.displayName ?? place?.name, ...(place?.country ? [place.country] : [])].filter((item): item is string => Boolean(item)),
      titleText: photo.userEdits?.title ?? photo.title ?? photo.fileName,
      tagText: photo.tags.join(" "),
      captionText: photo.userEdits?.caption ?? photo.aiCaption,
    };
  });
}

function projectState(state: MobilePersistedState): AppSnapshot {
  return {
    ...state,
    timelineSegments: buildTimelineSegments(state),
    globeMarkers: buildGlobeMarkers(state),
    dossierGroups: buildDossierGroups(state),
    searchDocuments: buildSearchDocuments(state),
  };
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  return Array.from(bytes.slice(offset, offset + length))
    .map((byte) => String.fromCharCode(byte))
    .join("")
    .replace(/\0/g, "")
    .trim();
}

function parseTiff(bytes: Uint8Array): ExifResult {
  if (bytes.length < 8) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = readAscii(bytes, 0, 2) === "II";
  const u16 = (offset: number) => (little ? view.getUint16(offset, true) : view.getUint16(offset, false));
  const u32 = (offset: number) => (little ? view.getUint32(offset, true) : view.getUint32(offset, false));
  const rational = (offset: number) => {
    if (offset + 8 > bytes.length) return 0;
    const denominator = u32(offset + 4);
    return denominator ? u32(offset) / denominator : 0;
  };
  const parseIfd = (start: number) => {
    const entries = new Map<number, { count: number; raw: number; type: number; value: number }>();
    if (start + 2 > bytes.length) return entries;
    const count = u16(start);
    for (let index = 0; index < count; index += 1) {
      const entry = start + 2 + index * 12;
      if (entry + 12 > bytes.length) break;
      entries.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), value: u32(entry + 8), raw: entry + 8 });
    }
    return entries;
  };

  const root = parseIfd(u32(4));
  const exifIfd = root.get(0x8769)?.value;
  const gpsIfd = root.get(0x8825)?.value;
  let capturedAt: string | undefined;
  if (exifIfd) {
    const exif = parseIfd(exifIfd);
    const date = exif.get(0x9003) ?? exif.get(0x0132);
    if (date) {
      const offset = date.count > 4 ? date.value : date.raw;
      const text = readAscii(bytes, offset, date.count);
      const match = text.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (match) capturedAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
    }
  }

  let location: GeoPoint | undefined;
  if (gpsIfd) {
    const gps = parseIfd(gpsIfd);
    const latRef = readAscii(bytes, gps.get(1)?.raw ?? 0, 2);
    const lat = gps.get(2);
    const lngRef = readAscii(bytes, gps.get(3)?.raw ?? 0, 2);
    const lng = gps.get(4);
    if (lat && lng) {
      const toDeg = (entry: { value: number }) => rational(entry.value) + rational(entry.value + 8) / 60 + rational(entry.value + 16) / 3600;
      location = {
        lat: toDeg(lat) * (latRef === "S" ? -1 : 1),
        lng: toDeg(lng) * (lngRef === "W" ? -1 : 1),
      };
    }
  }
  return { capturedAt, location };
}

function parseExif(buffer: ArrayBuffer): ExifResult {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return {};
  const view = new DataView(buffer);
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const length = view.getUint16(offset + 2, false);
    if (marker === 0xe1 && readAscii(bytes, offset + 4, 6).startsWith("Exif")) {
      return parseTiff(bytes.slice(offset + 10, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return {};
}

async function hashBuffer(buffer: ArrayBuffer) {
  if (!window.crypto?.subtle) return undefined;
  const digest = await window.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createThumbnail(file: File) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = objectUrl;
    });
    const scale = Math.min(1, maxThumbSize / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function pendingItemForPhoto(photo: Photo, type: PendingItem["type"], reason: string): PendingItem {
  return {
    id: makeId("pending"),
    type,
    relatedPhotoIds: [photo.id],
    relatedTripId: photo.tripId,
    suggestion: "需要手动确认",
    reason,
    status: "open",
  };
}

function buildImportState(
  current: MobilePersistedState,
  totalCount: number,
  photos: Photo[],
  pendingItems: PendingItem[],
  summary: string,
  duplicateCount = 0,
  duplicatePhotoIds: string[] = [],
) {
  const batchId = makeId("batch");
  const importedAt = nowIso();
  const datedPhotos = photos.slice().sort((left, right) => (left.capturedAt ?? "").localeCompare(right.capturedAt ?? ""));
  const start = toDateInput(datedPhotos[0]?.capturedAt);
  const end = toDateInput(datedPhotos[datedPhotos.length - 1]?.capturedAt ?? datedPhotos[0]?.capturedAt);
  const tripId = makeId("trip");
  const located = photos.filter((photo) => photo.location);
  const title = `Mobile Import ${start}`;
  const trip: Trip = {
    id: tripId,
    title,
    dateRange: { start, end },
    countries: ["待确认"],
    cities: [],
    coverUrl: photos[0]?.thumbnailUrl ?? "",
    photoCount: photos.length,
    placeNodeCount: located.length ? 1 : 0,
    status: "pending",
    source: "import",
  };

  for (const photo of photos) photo.tripId = tripId;
  let placeNodes: PlaceNode[] = [];
  let routes: Route[] = [];
  if (located.length) {
    const placeId = makeId("place");
    const center = midpoint(located.map((photo) => photo.location).filter((point): point is GeoPoint => Boolean(point)));
    for (const photo of located) photo.placeNodeId = placeId;
    placeNodes = [
      {
        id: placeId,
        tripId,
        name: "定位照片",
        displayName: "定位照片",
        country: "待确认",
        center,
        photoIds: located.map((photo) => photo.id),
        timeRange: {
          start: located[0]?.capturedAt ?? importedAt,
          end: located[located.length - 1]?.capturedAt ?? located[0]?.capturedAt ?? importedAt,
        },
        pending: false,
      },
    ];
    routes = [
      {
        id: makeId("route"),
        tripId,
        points: located.map((photo) => photo.location).filter((point): point is GeoPoint => Boolean(point)),
        status: "auto_generated",
      },
    ];
  }
  for (const pending of pendingItems) pending.relatedTripId = tripId;

  const batch: ImportBatch = {
    id: batchId,
    importedAt,
    totalCount,
    successCount: photos.length,
    failedCount: Math.max(0, totalCount - photos.length - duplicateCount),
    duplicateCount,
    duplicatePhotoIds,
    status: "pending_confirmation",
    createdTripIds: [tripId],
    updatedTripIds: [],
    addedPhotoIds: photos.map((photo) => photo.id),
    pendingItemIds: pendingItems.map((item) => item.id),
    storedFileNames: [],
    storedThumbnailNames: [],
    aiStats: {
      qwenCount: 0,
      fallbackCount: photos.length,
      embeddingCount: 0,
      qwenEmbeddingCount: 0,
      deterministicEmbeddingCount: 0,
    },
    summary,
  };

  return {
    trips: [...current.trips, trip],
    photos: [...current.photos, ...photos],
    placeNodes: [...current.placeNodes, ...placeNodes],
    routes: [...current.routes, ...routes],
    importBatches: [...current.importBatches, batch],
    pendingItems: [...current.pendingItems, ...pendingItems],
  };
}

function firstRecommendedModel(profile: ProfileKey, providerId: string) {
  return mobileAiCatalog.models[profile]?.[providerId]?.find((model) => model.recommended)?.id ?? mobileAiCatalog.models[profile]?.[providerId]?.[0]?.id ?? "";
}

function providerSupports(profile: ProfileKey, providerId: string | null | undefined) {
  return Boolean(providerId && mobileAiCatalog.providers.find((provider) => provider.id === providerId)?.capabilities[profile]);
}

function recommendedModelExists(profile: ProfileKey, providerId: string | null | undefined, modelId: string | null | undefined) {
  if (!providerId || !modelId) return false;
  return Boolean(mobileAiCatalog.models[profile]?.[providerId]?.some((model) => model.id === modelId));
}

function normalizeModelSource(value: unknown): "recommended" | "custom" {
  return value === "custom" ? "custom" : "recommended";
}

function defaultAiConfig(): AiConfig {
  return {
    catalog: mobileAiCatalog,
    profiles: {
      imageUnderstanding: { providerId: "aliyun", modelId: firstRecommendedModel("imageUnderstanding", "aliyun") || "qwen3.5-flash", modelSource: "recommended" },
      crossModalEmbedding: { enabled: false, providerId: null, modelId: null, modelSource: null },
    },
  };
}

function normalizeImageProfile(profile: Partial<AiConfig["profiles"]["imageUnderstanding"]> | undefined) {
  const fallback = defaultAiConfig().profiles.imageUnderstanding;
  const providerId = providerSupports("imageUnderstanding", profile?.providerId) ? profile?.providerId ?? fallback.providerId : fallback.providerId;
  const modelSource = normalizeModelSource(profile?.modelSource);
  const modelId =
    modelSource === "custom"
      ? profile?.modelId || fallback.modelId
      : recommendedModelExists("imageUnderstanding", providerId, profile?.modelId)
        ? profile?.modelId ?? fallback.modelId
        : firstRecommendedModel("imageUnderstanding", providerId) || fallback.modelId;

  return {
    providerId,
    modelId,
    modelSource,
  };
}

function normalizeEmbeddingProfile(profile: Partial<AiConfig["profiles"]["crossModalEmbedding"]> | undefined) {
  const fallback = defaultAiConfig().profiles.crossModalEmbedding;
  const enabled = Boolean(profile?.enabled ?? fallback.enabled);

  if (!enabled) {
    return {
      enabled: false,
      providerId: null,
      modelId: null,
      modelSource: null,
    };
  }

  const providerId = providerSupports("crossModalEmbedding", profile?.providerId) ? profile?.providerId ?? "aliyun" : "aliyun";
  const modelSource = normalizeModelSource(profile?.modelSource);
  const modelId =
    modelSource === "custom"
      ? profile?.modelId || firstRecommendedModel("crossModalEmbedding", providerId)
      : recommendedModelExists("crossModalEmbedding", providerId, profile?.modelId)
        ? profile?.modelId ?? firstRecommendedModel("crossModalEmbedding", providerId)
        : firstRecommendedModel("crossModalEmbedding", providerId);

  return {
    enabled,
    providerId,
    modelId,
    modelSource,
  };
}

function normalizeMobileAiConfig(config?: Partial<AiConfig> | AiConfig): AiConfig {
  return {
    catalog: mobileAiCatalog,
    profiles: {
      imageUnderstanding: normalizeImageProfile(config?.profiles?.imageUnderstanding),
      crossModalEmbedding: normalizeEmbeddingProfile(config?.profiles?.crossModalEmbedding),
    },
  };
}

function emptyCredential(source: "local" | "env" | "none" = "none") {
  return { isSet: source !== "none", preview: source === "none" ? "" : "已设置", source };
}

function readAiSettings(): AiSettings {
  const fallback: AiSettings = {
    credentials: Object.fromEntries(providerKeys.map((key) => [key, emptyCredential()])) as AiSettings["credentials"],
    profileCredentials: {
      imageUnderstanding: Object.fromEntries(providerKeys.map((key) => [key, emptyCredential()])) as AiSettings["profileCredentials"]["imageUnderstanding"],
      crossModalEmbedding: Object.fromEntries(providerKeys.map((key) => [key, emptyCredential()])) as AiSettings["profileCredentials"]["crossModalEmbedding"],
    },
    aiConfig: normalizeMobileAiConfig(),
  };
  const raw = window.localStorage.getItem(aiSettingsKey);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      ...fallback,
      ...parsed,
      aiConfig: normalizeMobileAiConfig(parsed.aiConfig),
    };
  } catch {
    return fallback;
  }
}

function writeAiSettings(settings: AiSettings) {
  window.localStorage.setItem(aiSettingsKey, JSON.stringify(settings));
}

function photoFromNativeAsset(asset: NativePhotoAsset): Photo {
  const location = typeof asset.latitude === "number" && typeof asset.longitude === "number" ? { lat: asset.latitude, lng: asset.longitude } : undefined;
  const capturedAt = asset.capturedAt ?? (asset.lastModified ? new Date(asset.lastModified).toISOString() : nowIso());
  const title = asset.fileName.replace(/\.[^.]+$/, "");
  const canReuseOriginal = asset.persisted !== false;
  return {
    id: makeId("photo"),
    fileName: asset.fileName,
    title,
    originalHash: asset.sha256 ?? asset.uri,
    mime: asset.mimeType,
    thumbnailUrl: asset.thumbnailDataUrl ?? asset.webPath ?? "",
    storageUrl: canReuseOriginal ? asset.webPath ?? asset.uri : undefined,
    sourceUri: canReuseOriginal ? asset.uri : undefined,
    sourceWebPath: canReuseOriginal ? asset.webPath : undefined,
    sourceProvider: "android_photo_picker",
    capturedAt,
    location,
    tags: canReuseOriginal ? ["手机相册"] : ["手机相册", "原图授权未持久化"],
    aiCaption: "",
    locationResolution: {
      status: location ? "confirmed" : "missing",
      effectivePoint: location,
      confidence: location ? 1 : undefined,
      source: location ? "exif" : undefined,
      precision: location ? "confirmed" : undefined,
      candidates: [],
      requiresUserAction: !location,
      updatedAt: nowIso(),
    },
    exifStatus: {
      time: asset.capturedAt ? "read" : "fallback",
      gps: location ? "read" : "missing",
    },
    pendingReason: location ? undefined : "missing_gps",
  };
}

function duplicateNativeAssetIds(state: MobilePersistedState, assets: NativePhotoAsset[]) {
  const existingHashes = new Set(state.photos.map((photo) => photo.originalHash).filter((value): value is string => Boolean(value)));
  const existingUris = new Set(state.photos.map((photo) => photo.sourceUri).filter((value): value is string => Boolean(value)));
  return new Set(
    assets
      .filter((asset) => (asset.sha256 && existingHashes.has(asset.sha256)) || existingUris.has(asset.uri))
      .map((asset) => asset.sha256 ?? asset.uri),
  );
}

function sourceUrisForPhotos(photos: Photo[]) {
  return photos.map((photo) => photo.sourceUri).filter((uri): uri is string => Boolean(uri));
}

export const mobileLocalApi = {
  async getState() {
    return projectState(await getPersistedState());
  },
  async reverseGeocode(point: GeoPoint) {
    const candidate: LocationCandidate = {
      id: makeId("candidate"),
      name: `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`,
      point,
      confidence: 0.5,
      source: "manual",
      precision: "estimated",
      reason: "Android local MVP does not include the offline gazetteer yet.",
    };
    return { candidates: [candidate] };
  },
  async getLocalAiSettings(): Promise<LocalAiSettings> {
    return {
      qwenChatApiKey: emptyCredential(),
      qwenEmbeddingApiKey: emptyCredential(),
    };
  },
  async updateLocalAiSettings(): Promise<LocalAiSettings> {
    return this.getLocalAiSettings();
  },
  async getAiSettings() {
    return readAiSettings();
  },
  async getStorageSettings(): Promise<StorageSettings> {
    return {
      dataDir: "Android app storage",
      dbPath: "Android IndexedDB",
      importJobDir: "Android app storage",
      photoDir: "Gallery content URIs are referenced, not copied",
      rootDir: "Android app sandbox",
      source: "project",
      thumbDir: "Android IndexedDB thumbnails",
      vectorPath: "Android IndexedDB",
    };
  },
  async updateAiSettings(body: AiSettingsUpdateBody) {
    const current = readAiSettings();
    const nextCredentials = { ...current.credentials };
    for (const key of providerKeys) {
      if (!hasOwn(body.credentials, key)) continue;
      nextCredentials[key] = body.credentials?.[key] ? emptyCredential("local") : emptyCredential();
    }
    const nextProfileCredentials = {
      imageUnderstanding: { ...current.profileCredentials.imageUnderstanding },
      crossModalEmbedding: { ...current.profileCredentials.crossModalEmbedding },
    };
    for (const profile of ["imageUnderstanding", "crossModalEmbedding"] as const) {
      for (const key of providerKeys) {
        if (!hasOwn(body.profileCredentials?.[profile], key)) continue;
        nextProfileCredentials[profile][key] = body.profileCredentials?.[profile]?.[key] ? emptyCredential("local") : emptyCredential();
      }
    }
    const next: AiSettings = {
      ...current,
      credentials: nextCredentials,
      profileCredentials: nextProfileCredentials,
      aiConfig: body.aiConfig ? normalizeMobileAiConfig(body.aiConfig) : normalizeMobileAiConfig(current.aiConfig),
    };
    writeAiSettings(next);
    return next;
  },
  async rebuildPhotoEmbeddings(onJobProgress?: (progress: ImportJobProgress) => void, photoIds?: string[]) {
    const state = await getPersistedState();
    const total = photoIds?.length ?? state.photos.length;
    onJobProgress?.({ phase: "completed", done: total, total, steps: { embedding: { done: total, total } } });
    return {
      ...projectState(state),
      embeddingRebuild: {
        total,
        successCount: 0,
        failedCount: 0,
        failedPhotoIds: [],
        failures: [],
        mode: photoIds?.length ? "retry_failed" : "all",
      } satisfies EmbeddingRebuildReport,
    };
  },
  async importFiles(
    filesLike: FileList | File[],
    _allowCloudAi: boolean,
    _locale: "zh" | "en" = "zh",
    onProgress?: (done: number, total: number) => void,
    onJobProgress?: (progress: ImportJobProgress) => void,
  ) {
    void _locale;
    const files = Array.from(filesLike).filter((file) => file.type.startsWith("image/"));
    const total = files.length;
    const photos: Photo[] = [];
    const pendingItems: PendingItem[] = [];
    onProgress?.(0, total);
    onJobProgress?.({ phase: "reading", done: 0, total, steps: { reading: { done: 0, total } } });
    let done = 0;
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const exif = parseExif(buffer);
      const thumbnailUrl = await createThumbnail(file).catch(() => "");
      const photo: Photo = {
        id: makeId("photo"),
        fileName: file.name,
        title: file.name.replace(/\.[^.]+$/, ""),
        originalHash: await hashBuffer(buffer),
        mime: file.type,
        thumbnailUrl,
        sourceProvider: "file_input",
        capturedAt: exif.capturedAt ?? (file.lastModified ? new Date(file.lastModified).toISOString() : nowIso()),
        location: exif.location,
        tags: ["移动端导入"],
        aiCaption: "",
        locationResolution: {
          status: exif.location ? "confirmed" : "missing",
          effectivePoint: exif.location,
          confidence: exif.location ? 1 : undefined,
          source: exif.location ? "exif" : undefined,
          precision: exif.location ? "confirmed" : undefined,
          candidates: [],
          requiresUserAction: !exif.location,
          updatedAt: nowIso(),
        },
        exifStatus: {
          time: exif.capturedAt ? "read" : "fallback",
          gps: exif.location ? "read" : "missing",
        },
        pendingReason: exif.location ? undefined : "missing_gps",
      };
      photos.push(photo);
      if (!exif.location) pendingItems.push(pendingItemForPhoto(photo, "missing_gps", "移动端本地导入未读取到 EXIF GPS。"));
      done += 1;
      onProgress?.(done, total);
      onJobProgress?.({ phase: "exif", done, total, currentFileName: file.name, steps: { reading: { done, total }, exif: { done, total } } });
    }
    const next = buildImportState(await getPersistedState(), files.length, photos, pendingItems, `Imported ${photos.length} files on Android WebView`);
    await writePersistedState(next);
    onJobProgress?.({ phase: "completed", done: total, total });
    return projectState(next);
  },
  async importMobilePhotoAssets(
    assetsLike: NativePhotoAsset[],
    _allowCloudAi: boolean,
    _locale: "zh" | "en" = "zh",
    onProgress?: (done: number, total: number) => void,
    onJobProgress?: (progress: ImportJobProgress) => void,
  ) {
    void _allowCloudAi;
    void _locale;
    const assets = assetsLike.filter((asset) => !asset.error && asset.uri && asset.mimeType?.startsWith("image/"));
    const total = assets.length;
    if (!total) return projectState(await getPersistedState());

    const state = await getPersistedState();
    const duplicateIds = duplicateNativeAssetIds(state, assets);
    const photos: Photo[] = [];
    const pendingItems: PendingItem[] = [];
    onProgress?.(0, total);
    onJobProgress?.({ phase: "reading", done: 0, total, steps: { reading: { done: 0, total } } });
    let done = 0;
    for (const asset of assets) {
      const duplicateId = asset.sha256 ?? asset.uri;
      if (!duplicateIds.has(duplicateId)) {
        const photo = photoFromNativeAsset(asset);
        photos.push(photo);
        if (!photo.location) pendingItems.push(pendingItemForPhoto(photo, "missing_gps", "系统相册照片未读取到 EXIF GPS。"));
      }
      done += 1;
      onProgress?.(done, total);
      onJobProgress?.({
        phase: done < total ? "thumbnails" : "grouping",
        done,
        total,
        currentFileName: asset.fileName,
        steps: {
          reading: { done, total },
          exif: { done, total },
          thumbnails: { done, total },
        },
      });
    }

    if (!photos.length) {
      onJobProgress?.({ phase: "completed", done: total, total });
      return projectState(state);
    }

    const duplicatePhotoIds = assets.filter((asset) => duplicateIds.has(asset.sha256 ?? asset.uri)).map((asset) => asset.sha256 ?? asset.uri);
    const next = buildImportState(
      state,
      total,
      photos,
      pendingItems,
      `Imported ${photos.length} gallery photos on Android without copying originals`,
      duplicatePhotoIds.length,
      duplicatePhotoIds,
    );
    await writePersistedState(next);
    onJobProgress?.({ phase: "completed", done: total, total });
    return projectState(next);
  },
  async importAppleTestPhotos() {
    return projectState(await getPersistedState());
  },
  async confirmImport(batchId: string) {
    const state = await getPersistedState();
    const batches = state.importBatches.map((batch) => (batch.id === batchId ? { ...batch, status: "confirmed" as const } : batch));
    const batch = batches.find((item) => item.id === batchId);
    const created = new Set(batch?.createdTripIds ?? []);
    const trips = state.trips.map((trip) => (created.has(trip.id) ? { ...trip, status: "confirmed" as const } : trip));
    const pendingIds = new Set(batch?.pendingItemIds ?? []);
    const pendingItems = state.pendingItems.map((item) => (pendingIds.has(item.id) ? { ...item, status: "accepted" as const } : item));
    const next = { ...state, importBatches: batches, trips, pendingItems };
    await writePersistedState(next);
    return projectState(next);
  },
  async rollbackImport(batchId: string) {
    const state = await getPersistedState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch) return projectState(state);
    const addedPhotoIds = new Set(batch.addedPhotoIds);
    const createdTripIds = new Set(batch.createdTripIds);
    const pendingIds = new Set(batch.pendingItemIds);
    const removedPhotos = state.photos.filter((photo) => addedPhotoIds.has(photo.id));
    const next = {
      ...state,
      photos: state.photos.filter((photo) => !addedPhotoIds.has(photo.id)),
      trips: state.trips.filter((trip) => !createdTripIds.has(trip.id)),
      placeNodes: state.placeNodes.filter((place) => !createdTripIds.has(place.tripId)),
      routes: state.routes.filter((route) => !createdTripIds.has(route.tripId)),
      pendingItems: state.pendingItems.filter((item) => !pendingIds.has(item.id)),
      importBatches: state.importBatches.map((item) => (item.id === batchId ? { ...item, status: "rolled_back" as const } : item)),
    };
    await writePersistedState(next);
    deleteThumbnailsForPhotos(removedPhotos);
    void releaseNativePhotoPermissions(sourceUrisForPhotos(removedPhotos));
    return projectState(next);
  },
  async cancelImportPhotos(batchId: string, photoIds: string[]) {
    const state = await getPersistedState();
    const removed = new Set(photoIds);
    const removedPhotos = state.photos.filter((photo) => removed.has(photo.id));
    const next = {
      ...state,
      photos: state.photos.filter((photo) => !removed.has(photo.id)),
      pendingItems: state.pendingItems.filter((item) => !item.relatedPhotoIds.some((id) => removed.has(id))),
      importBatches: state.importBatches.map((batch) =>
        batch.id === batchId ? { ...batch, addedPhotoIds: batch.addedPhotoIds.filter((id) => !removed.has(id)), successCount: Math.max(0, batch.successCount - removed.size) } : batch,
      ),
    };
    await writePersistedState(next);
    deleteThumbnailsForPhotos(removedPhotos);
    void releaseNativePhotoPermissions(sourceUrisForPhotos(removedPhotos));
    return projectState(next);
  },
  async inferPendingLocation() {
    return projectState(await getPersistedState());
  },
  async inferPendingLocations() {
    return projectState(await getPersistedState());
  },
  async resolveImportAiFailure() {
    return projectState(await getPersistedState());
  },
  async resolveImportAiFailures() {
    return projectState(await getPersistedState());
  },
  async mergeImportTrips() {
    return projectState(await getPersistedState());
  },
  async createTrip(title: string, start: string, end: string) {
    const state = await getPersistedState();
    const trip: Trip = { id: makeId("trip"), title, dateRange: { start, end }, countries: [], cities: [], coverUrl: "", photoCount: 0, placeNodeCount: 0, status: "confirmed", source: "manual" };
    const next = { ...state, trips: [...state.trips, trip] };
    await writePersistedState(next);
    return projectState(next);
  },
  async updateTrip(tripId: string, body: { title?: string; dateRange?: { start: string; end: string } }) {
    const state = await getPersistedState();
    const next = { ...state, trips: state.trips.map((trip) => (trip.id === tripId ? { ...trip, title: body.title ?? trip.title, dateRange: body.dateRange ?? trip.dateRange } : trip)) };
    await writePersistedState(next);
    return projectState(next);
  },
  async deleteTrip(tripId: string) {
    const state = await getPersistedState();
    const removedPhotos = state.photos.filter((photo) => photo.tripId === tripId);
    const next = {
      ...state,
      trips: state.trips.filter((trip) => trip.id !== tripId),
      photos: state.photos.filter((photo) => photo.tripId !== tripId),
      placeNodes: state.placeNodes.filter((place) => place.tripId !== tripId),
      routes: state.routes.filter((route) => route.tripId !== tripId),
    };
    await writePersistedState(next);
    deleteThumbnailsForPhotos(removedPhotos);
    void releaseNativePhotoPermissions(sourceUrisForPhotos(removedPhotos));
    return projectState(next);
  },
  async createPlace() {
    return projectState(await getPersistedState());
  },
  async updatePlace(placeId: string, body: { name?: string }) {
    const state = await getPersistedState();
    const next = { ...state, placeNodes: state.placeNodes.map((place) => (place.id === placeId ? { ...place, name: body.name ?? place.name, displayName: body.name ?? place.displayName } : place)) };
    await writePersistedState(next);
    return projectState(next);
  },
  async deletePlace() {
    return projectState(await getPersistedState());
  },
  async reorderPlaces() {
    return projectState(await getPersistedState());
  },
  async movePhoto(photoId: string, body: { tripId?: string }) {
    const state = await getPersistedState();
    const next = { ...state, photos: state.photos.map((photo) => (photo.id === photoId ? { ...photo, tripId: body.tripId } : photo)) };
    await writePersistedState(next);
    return projectState(next);
  },
  async deletePhoto(photoId: string) {
    const state = await getPersistedState();
    const removedPhotos = state.photos.filter((photo) => photo.id === photoId);
    const next = { ...state, photos: state.photos.filter((photo) => photo.id !== photoId), placeNodes: state.placeNodes.map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => id !== photoId) })) };
    await writePersistedState(next);
    deleteThumbnailsForPhotos(removedPhotos);
    void releaseNativePhotoPermissions(sourceUrisForPhotos(removedPhotos));
    return projectState(next);
  },
  async updatePhoto(photoId: string, body: { userEdits?: { title?: string; caption?: string; tags?: string[] } }) {
    const state = await getPersistedState();
    const next = { ...state, photos: state.photos.map((photo) => (photo.id === photoId ? { ...photo, userEdits: body.userEdits ? { ...body.userEdits, updatedAt: nowIso() } : photo.userEdits } : photo)) };
    await writePersistedState(next);
    return projectState(next);
  },
  async bindPhoto(photoId: string, placeId?: string) {
    const state = await getPersistedState();
    const next = { ...state, photos: state.photos.map((photo) => (photo.id === photoId ? { ...photo, placeNodeId: placeId } : photo)) };
    await writePersistedState(next);
    return projectState(next);
  },
  async createPlaceForPhoto(photoId: string, body: { name: string; lat: number; lng: number }) {
    const state = await getPersistedState();
    const photo = state.photos.find((item) => item.id === photoId);
    if (!photo?.tripId) return projectState(state);
    const place: PlaceNode = {
      id: makeId("place"),
      tripId: photo.tripId,
      name: body.name,
      displayName: body.name,
      center: { lat: Number(body.lat), lng: Number(body.lng) },
      photoIds: [photoId],
      timeRange: { start: photo.capturedAt ?? nowIso(), end: photo.capturedAt ?? nowIso() },
      pending: false,
    };
    const next = { ...state, placeNodes: [...state.placeNodes, place], photos: state.photos.map((item) => (item.id === photoId ? { ...item, placeNodeId: place.id, location: place.center } : item)) };
    await writePersistedState(next);
    return projectState(next);
  },
  async updatePending(pendingId: string, accepted: boolean) {
    const state = await getPersistedState();
    const next = { ...state, pendingItems: state.pendingItems.map((item) => (item.id === pendingId ? { ...item, status: accepted ? "accepted" as const : "ignored" as const } : item)) };
    await writePersistedState(next);
    return projectState(next);
  },
  async resolvePendingManually() {
    return projectState(await getPersistedState());
  },
  async search(query: string, filters?: { tripId?: string; placeId?: string; date?: string; tag?: string; fileName?: string }) {
    const normalizedQuery = query.trim().toLowerCase();
    const state = projectState(await getPersistedState());
    const results = (state.searchDocuments ?? [])
      .filter((doc) => {
        if (filters?.tripId && doc.tripId !== filters.tripId) return false;
        if (filters?.placeId && doc.placeNodeId !== filters.placeId) return false;
        if (filters?.date && doc.capturedAt?.slice(0, 10) !== filters.date) return false;
        if (filters?.tag && !doc.tags.includes(filters.tag)) return false;
        if (filters?.fileName && !state.photos.find((photo) => photo.id === doc.photoId)?.fileName.includes(filters.fileName)) return false;
        if (!normalizedQuery) return true;
        return [doc.titleText, doc.captionText, doc.tagText, ...doc.locationNames].filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);
      })
      .map<SearchResult>((doc, index) => ({ id: `result-${doc.photoId}`, photoId: doc.photoId, tripId: doc.tripId, reason: "Local mobile search", score: 1 - index * 0.01 }));
    return { results };
  },
};

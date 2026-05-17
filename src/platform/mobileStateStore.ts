import type { ImportBatch, Photo, PlaceNode, Route, Trip, PendingItem } from "@/domain/models";
import { readNativeState, writeNativeState } from "@/platform/nativeRepository";
import { normalizeState as normalizeSharedState } from "../../shared/domain/state-normalizer.mjs";

export type MobilePersistedState = {
  trips: Trip[];
  photos: Photo[];
  placeNodes: PlaceNode[];
  routes: Route[];
  importBatches: ImportBatch[];
  pendingItems: PendingItem[];
};

const stateKey = "earth-online-mobile-state-v1";
const mobileDbName = "earth-online-mobile-db";
const mobileDbVersion = 1;
const mobileKvStore = "kv";
const photoThumbKeyPrefix = "earth-online-mobile-photo-thumb:";

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

export function normalizeMobilePersistedState(parsed: Partial<MobilePersistedState> | undefined): MobilePersistedState {
  const base = {
    ...emptyPersistedState(),
    ...parsed,
    trips: Array.isArray(parsed?.trips) ? parsed.trips : [],
    photos: Array.isArray(parsed?.photos) ? parsed.photos : [],
    placeNodes: Array.isArray(parsed?.placeNodes) ? parsed.placeNodes : [],
    routes: Array.isArray(parsed?.routes) ? parsed.routes : [],
    importBatches: Array.isArray(parsed?.importBatches) ? parsed.importBatches : [],
    pendingItems: Array.isArray(parsed?.pendingItems) ? parsed.pendingItems : [],
  };
  return normalizeSharedState(base) as MobilePersistedState;
}

function stateHasContent(state: MobilePersistedState) {
  return state.trips.length > 0 || state.photos.length > 0 || state.placeNodes.length > 0 || state.routes.length > 0 || state.importBatches.length > 0 || state.pendingItems.length > 0;
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

function readLocalStorageState(): MobilePersistedState {
  if (cachedState) return cachedState;
  if (typeof window === "undefined") return emptyPersistedState();
  const raw = window.localStorage.getItem(stateKey);
  if (!raw) return emptyPersistedState();
  try {
    const next = normalizeMobilePersistedState(JSON.parse(raw) as Partial<MobilePersistedState>);
    cachedState = next;
    return next;
  } catch {
    return emptyPersistedState();
  }
}

export async function getMobilePersistedState(): Promise<MobilePersistedState> {
  if (cachedState) return cachedState;
  stateHydration ??= (async () => {
    const nativeState = await readNativeState<Partial<MobilePersistedState>>().catch(() => undefined);
    if (nativeState) {
      const normalizedNativeState = normalizeMobilePersistedState(nativeState);
      if (stateHasContent(normalizedNativeState)) {
        cachedState = await hydratePhotoThumbnails(normalizedNativeState);
        return cachedState;
      }
    }
    const indexedState = await readKv<MobilePersistedState>(stateKey);
    if (indexedState) {
      cachedState = await hydratePhotoThumbnails(normalizeMobilePersistedState(indexedState));
      void writeNativeState({ ...cachedState, photos: cachedState.photos.map(stripPhotoThumbnail) }).catch(() => undefined);
      return cachedState;
    }
    cachedState = readLocalStorageState();
    void writeNativeState({ ...cachedState, photos: cachedState.photos.map(stripPhotoThumbnail) }).catch(() => undefined);
    return cachedState;
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

export async function writeMobilePersistedState(state: MobilePersistedState) {
  const normalized = normalizeMobilePersistedState(state);
  cachedState = normalized;
  const storedState = { ...normalized, photos: normalized.photos.map(stripPhotoThumbnail) };
  const thumbnailEntries = normalized.photos
    .filter((photo) => photo.thumbnailUrl.startsWith("data:"))
    .map<[string, string]>((photo) => [`${photoThumbKeyPrefix}${photo.id}`, photo.thumbnailUrl]);
  await writeManyKv([[stateKey, storedState], ...thumbnailEntries]);
  try {
    window.localStorage.setItem(stateKey, JSON.stringify(storedState));
  } catch {
    window.localStorage.removeItem(stateKey);
  }
  await writeNativeState(storedState).catch(() => false);
}

export function deleteMobileThumbnailsForPhotos(photos: Photo[]) {
  void deleteManyKv(photos.map((photo) => `${photoThumbKeyPrefix}${photo.id}`));
}

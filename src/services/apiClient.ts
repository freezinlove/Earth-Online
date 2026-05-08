import type { DossierTripGroup, GlobeMarker, ImportBatch, PendingItem, Photo, PlaceNode, Route, SearchDocument, SearchResult, TimelineSegment, Trip } from "@/domain/models";

export interface AppSnapshot {
  trips: Trip[];
  photos: Photo[];
  placeNodes: PlaceNode[];
  routes: Route[];
  importBatches: ImportBatch[];
  pendingItems: PendingItem[];
  timelineSegments: TimelineSegment[];
  globeMarkers?: GlobeMarker[];
  dossierGroups?: DossierTripGroup[];
  searchDocuments?: SearchDocument[];
}

export interface LocalAiCredential {
  isSet: boolean;
  preview: string;
  source: "local" | "env" | "none";
}

export interface LocalAiSettings {
  qwenChatApiKey: LocalAiCredential;
  qwenEmbeddingApiKey: LocalAiCredential;
}

interface ImportFilePayload {
  name: string;
  type: string;
  size: number;
  lastModified: number;
  dataUrl: string;
  thumbnailDataUrl?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error ?? "Earth_Online API request failed");
  }
  return response.json() as Promise<T>;
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

async function fileToThumbnailDataUrl(file: File) {
  const source = await fileToDataUrl(file);
  return new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const maxSize = 720;
      const ratio = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * ratio));
      canvas.height = Math.max(1, Math.round(image.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(source);
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.78));
    };
    image.onerror = () => resolve(source);
    image.src = source;
  });
}

async function toImportPayload(filesLike: FileList | File[], onProgress?: (done: number, total: number) => void): Promise<ImportFilePayload[]> {
  const files = Array.from(filesLike);
  const payload: ImportFilePayload[] = [];
  for (const file of files) {
    payload.push({
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      dataUrl: await fileToDataUrl(file),
      thumbnailDataUrl: await fileToThumbnailDataUrl(file),
    });
    onProgress?.(payload.length, files.length);
  }
  return payload;
}

export const apiClient = {
  getState: () => request<AppSnapshot>("/api/state"),
  getLocalAiSettings: () => request<LocalAiSettings>("/api/settings/local-ai"),
  updateLocalAiSettings: (body: Partial<Record<keyof LocalAiSettings, string>>) =>
    request<LocalAiSettings>("/api/settings/local-ai", { method: "PATCH", body: JSON.stringify(body) }),
  importFiles: async (files: FileList | File[], allowCloudAi: boolean, onProgress?: (done: number, total: number) => void) =>
    request<AppSnapshot>("/api/import", { method: "POST", body: JSON.stringify({ files: await toImportPayload(files, onProgress), allowCloudAi }) }),
  importAppleTestPhotos: (allowCloudAi: boolean, limit?: number) =>
    request<AppSnapshot>("/api/import/apple-test", { method: "POST", body: JSON.stringify({ allowCloudAi, limit }) }),
  confirmImport: (batchId: string) => request<AppSnapshot>(`/api/import/${batchId}/confirm`, { method: "POST", body: "{}" }),
  rollbackImport: (batchId: string) => request<AppSnapshot>(`/api/import/${batchId}/rollback`, { method: "POST", body: "{}" }),
  mergeImportTrips: (batchId: string) => request<AppSnapshot>(`/api/import/${batchId}/merge`, { method: "POST", body: "{}" }),
  createTrip: (title: string, start: string, end: string) => request<AppSnapshot>("/api/trips", { method: "POST", body: JSON.stringify({ title, start, end }) }),
  updateTrip: (tripId: string, body: { title?: string; dateRange?: { start: string; end: string } }) =>
    request<AppSnapshot>(`/api/trips/${tripId}`, { method: "PATCH", body: JSON.stringify(body) }),
  createPlace: (tripId: string, name: string, lat: number, lng: number) =>
    request<AppSnapshot>("/api/places", { method: "POST", body: JSON.stringify({ tripId, name, lat, lng }) }),
  deletePlace: (placeId: string) => request<AppSnapshot>(`/api/places/${placeId}/delete`, { method: "POST", body: "{}" }),
  reorderPlaces: (tripId: string, placeIds: string[]) =>
    request<AppSnapshot>(`/api/trips/${tripId}/reorder-places`, { method: "POST", body: JSON.stringify({ placeIds }) }),
  movePhoto: (photoId: string, tripId?: string) => request<AppSnapshot>(`/api/photos/${photoId}/move`, { method: "POST", body: JSON.stringify({ tripId }) }),
  updatePhoto: (photoId: string, body: { capturedAt?: string; location?: { lat?: number | string; lng?: number | string }; tags?: string[] }) =>
    request<AppSnapshot>(`/api/photos/${photoId}`, { method: "PATCH", body: JSON.stringify(body) }),
  bindPhoto: (photoId: string, placeId?: string) => request<AppSnapshot>(`/api/photos/${photoId}/bind-place`, { method: "POST", body: JSON.stringify({ placeId }) }),
  updatePending: (pendingId: string, accepted: boolean) => request<AppSnapshot>(`/api/pending/${pendingId}`, { method: "POST", body: JSON.stringify({ accepted }) }),
  search: (query: string, filters?: { tripId?: string; placeId?: string; date?: string; tag?: string; fileName?: string }) => {
    const params = new URLSearchParams({ q: query });
    Object.entries(filters ?? {}).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return request<{ results: SearchResult[] }>(`/api/search?${params.toString()}`);
  },
};

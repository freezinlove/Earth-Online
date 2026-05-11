import type { DossierTripGroup, GeoPoint, GlobeMarker, ImportBatch, LocationCandidate, PendingItem, Photo, PlaceNode, Route, SearchDocument, SearchResult, TimelineSegment, Trip } from "@/domain/models";

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

export type ImportJobPhase = "queued" | "reading" | "uploading" | "exif" | "thumbnails" | "ai" | "embedding" | "grouping" | "completed" | "failed";

export interface ImportJobStepProgress {
  done: number;
  total: number;
  currentFileName?: string;
}

export interface ImportJobProgress {
  phase: ImportJobPhase;
  done: number;
  total: number;
  currentFileName?: string;
  steps?: Partial<Record<"reading" | "upload" | "exif" | "thumbnails" | "ai" | "embedding", ImportJobStepProgress>>;
}

export interface ImportJobProgressEvent extends ImportJobProgress {
  sequence: number;
  createdAt: string;
}

export interface ImportJob {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  progress?: ImportJobProgress;
  progressEvents?: ImportJobProgressEvent[];
  result?: AppSnapshot;
  error?: string;
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

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function replayDelay(eventCount: number) {
  if (eventCount <= 12) return 130;
  if (eventCount <= 40) return 70;
  return 24;
}

async function replayProgressEvents(events: ImportJobProgressEvent[], seenSequences: Set<number>, onProgress?: (progress: ImportJobProgress) => void) {
  const unseen = events.filter((event) => !seenSequences.has(event.sequence)).sort((left, right) => left.sequence - right.sequence);
  const delay = replayDelay(unseen.length);
  for (const event of unseen) {
    seenSequences.add(event.sequence);
    onProgress?.(event);
    if (unseen.length > 1) await wait(delay);
  }
}

function watchImportJobProgress(jobId: string, seenSequences: Set<number>, onProgress?: (progress: ImportJobProgress) => void) {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource(`/api/import/jobs/${jobId}/events`);
  source.addEventListener("progress", (message) => {
    const event = JSON.parse((message as MessageEvent).data) as ImportJobProgressEvent;
    if (seenSequences.has(event.sequence)) return;
    seenSequences.add(event.sequence);
    onProgress?.(event);
  });
  source.addEventListener("done", () => source.close());
  return () => source.close();
}

async function pollImportJob(jobId: string, onProgress?: (progress: ImportJobProgress) => void) {
  const seenSequences = new Set<number>();
  const closeProgressStream = watchImportJobProgress(jobId, seenSequences, onProgress);
  try {
    for (;;) {
      const job = await request<ImportJob>(`/api/import/jobs/${jobId}`);
      if (job.progressEvents?.length) await replayProgressEvents(job.progressEvents, seenSequences, onProgress);
      else if (job.progress) onProgress?.(job.progress);
      if (job.status === "completed") {
        if (!job.result) throw new Error("导入任务已完成但没有返回结果");
        return job.result;
      }
      if (job.status === "failed") throw new Error(job.error ?? "导入任务失败");
      await wait(900);
    }
  } finally {
    closeProgressStream();
  }
}

export const apiClient = {
  getState: () => request<AppSnapshot>("/api/state"),
  reverseGeocode: (point: GeoPoint) => {
    const params = new URLSearchParams({ lat: String(point.lat), lng: String(point.lng) });
    return request<{ candidates: LocationCandidate[] }>(`/api/geocode/reverse?${params.toString()}`);
  },
  getLocalAiSettings: () => request<LocalAiSettings>("/api/settings/local-ai"),
  updateLocalAiSettings: (body: Partial<Record<keyof LocalAiSettings, string>>) =>
    request<LocalAiSettings>("/api/settings/local-ai", { method: "PATCH", body: JSON.stringify(body) }),
  importFiles: async (
    files: FileList | File[],
    allowCloudAi: boolean,
    locale: "zh" | "en" = "zh",
    onProgress?: (done: number, total: number) => void,
    onJobProgress?: (progress: ImportJobProgress) => void,
  ) => {
    const uploadFiles = Array.from(files);
    const form = new FormData();
    for (const file of uploadFiles) form.append("files", file, file.name);
    form.append("allowCloudAi", String(allowCloudAi));
    form.append("locale", locale);
    form.append(
      "fileMeta",
      JSON.stringify(uploadFiles.map((file) => ({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified }))),
    );
    onProgress?.(0, uploadFiles.length);
    const response = await fetch("/api/import/jobs", { method: "POST", body: form });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error ?? "Earth_Online API request failed");
    }
    onProgress?.(uploadFiles.length, uploadFiles.length);
    const job = (await response.json()) as ImportJob;
    if (job.progress) onJobProgress?.(job.progress);
    return pollImportJob(job.id, onJobProgress);
  },
  importAppleTestPhotos: (allowCloudAi: boolean, limit?: number) =>
    request<AppSnapshot>("/api/import/apple-test", { method: "POST", body: JSON.stringify({ allowCloudAi, limit }) }),
  confirmImport: (batchId: string) => request<AppSnapshot>(`/api/import/${batchId}/confirm`, { method: "POST", body: "{}" }),
  rollbackImport: (batchId: string) => request<AppSnapshot>(`/api/import/${batchId}/rollback`, { method: "POST", body: "{}" }),
  cancelImportPhotos: (batchId: string, photoIds: string[]) =>
    request<AppSnapshot>(`/api/import/${batchId}/cancel-photos`, { method: "POST", body: JSON.stringify({ photoIds }) }),
  inferPendingLocation: (batchId: string, pendingId: string, locale: "zh" | "en" = "zh") =>
    request<AppSnapshot>(`/api/import/${batchId}/pending/${pendingId}/infer-location`, { method: "POST", body: JSON.stringify({ locale }) }),
  inferPendingLocations: async (batchId: string, pendingIds: string[], locale: "zh" | "en" = "zh", onJobProgress?: (progress: ImportJobProgress) => void) => {
    const job = await request<ImportJob>(`/api/import/${batchId}/pending/infer-locations/jobs`, { method: "POST", body: JSON.stringify({ pendingIds, locale }) });
    if (job.progress) onJobProgress?.(job.progress);
    return pollImportJob(job.id, onJobProgress);
  },
  resolveImportAiFailure: (batchId: string, pendingId: string, action: "retry_vision" | "retry_embedding" | "retry_both" | "archive_exif", locale: "zh" | "en" = "zh") =>
    request<AppSnapshot>(`/api/import/${batchId}/ai-failures/${pendingId}/resolve`, { method: "POST", body: JSON.stringify({ action, locale }) }),
  mergeImportTrips: (batchId: string) => request<AppSnapshot>(`/api/import/${batchId}/merge`, { method: "POST", body: "{}" }),
  createTrip: (title: string, start: string, end: string) => request<AppSnapshot>("/api/trips", { method: "POST", body: JSON.stringify({ title, start, end }) }),
  updateTrip: (tripId: string, body: { title?: string; dateRange?: { start: string; end: string } }) =>
    request<AppSnapshot>(`/api/trips/${tripId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTrip: (tripId: string) => request<AppSnapshot>(`/api/trips/${tripId}/delete`, { method: "POST", body: "{}" }),
  createPlace: (tripId: string, name: string, lat: number, lng: number) =>
    request<AppSnapshot>("/api/places", { method: "POST", body: JSON.stringify({ tripId, name, lat, lng }) }),
  deletePlace: (placeId: string) => request<AppSnapshot>(`/api/places/${placeId}/delete`, { method: "POST", body: "{}" }),
  reorderPlaces: (tripId: string, placeIds: string[]) =>
    request<AppSnapshot>(`/api/trips/${tripId}/reorder-places`, { method: "POST", body: JSON.stringify({ placeIds }) }),
  movePhoto: (photoId: string, tripId?: string) => request<AppSnapshot>(`/api/photos/${photoId}/move`, { method: "POST", body: JSON.stringify({ tripId }) }),
  deletePhoto: (photoId: string) => request<AppSnapshot>(`/api/photos/${photoId}/delete`, { method: "POST", body: "{}" }),
  updatePhoto: (
    photoId: string,
    body: {
      capturedAt?: string;
      location?: { lat?: number | string; lng?: number | string };
      tags?: string[];
      userEdits?: { title?: string; caption?: string; tags?: string[] };
    },
  ) =>
    request<AppSnapshot>(`/api/photos/${photoId}`, { method: "PATCH", body: JSON.stringify(body) }),
  bindPhoto: (photoId: string, placeId?: string) => request<AppSnapshot>(`/api/photos/${photoId}/bind-place`, { method: "POST", body: JSON.stringify({ placeId }) }),
  updatePending: (pendingId: string, accepted: boolean) => request<AppSnapshot>(`/api/pending/${pendingId}`, { method: "POST", body: JSON.stringify({ accepted }) }),
  resolvePendingManually: (
    pendingId: string,
    body: { action: "bind_existing_place"; placeId: string } | { action: "create_manual_place"; name: string; lat: number; lng: number } | { action: "archive_unlocated" },
  ) => request<AppSnapshot>(`/api/pending/${pendingId}/manual`, { method: "POST", body: JSON.stringify(body) }),
  search: (query: string, filters?: { tripId?: string; placeId?: string; date?: string; tag?: string; fileName?: string }) => {
    const params = new URLSearchParams({ q: query });
    Object.entries(filters ?? {}).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return request<{ results: SearchResult[] }>(`/api/search?${params.toString()}`);
  },
};

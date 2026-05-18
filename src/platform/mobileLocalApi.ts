import type {
  EmbeddingRebuildReport,
  ImportJob,
  ImportJobProgress,
  LocalAiSettings,
  StorageSettings,
} from "@/services/apiClient";
import type { NativePhotoAsset } from "@/platform/nativePhotoLibrary";
import { prepareNativePhotoAsset, releaseNativePhotoPermissions } from "@/platform/nativePhotoLibrary";
import { deleteNativeVectors, readNativeImportJob, readNativeVectorIndex, writeNativeImportJob, writeNativeVectorIndex } from "@/platform/nativeRepository";
import { deleteMobileThumbnailsForPhotos, getMobilePersistedState, type MobilePersistedState, writeMobilePersistedState } from "@/platform/mobileStateStore";
import { createImageDataUrl, hashBuffer, parseExif, photoFromNativeAsset, sourceUrisForPhotos } from "@/platform/mobileMedia";
import { emptyCredential, readMobileAiSettings, updateMobileAiSettings, type MobileAiSettingsUpdateBody } from "@/platform/mobileAiSettings";
import { analyzeMobilePhoto, embedMobileImage, embedMobileTextQuery, inferMobileMissingInfoWithImage, recordMobileEmbeddingStats, vectorStatsDefaults, type MobileEmbeddingResult, type MobilePhotoAnalysis } from "@/platform/mobileAiRuntime";
import { geocodeMobileAiCandidate, manualMobileGeoDescription, projectMobileState as projectState, reverseMobileCandidates } from "@/platform/mobileGeodata";
import { searchMobilePhotos } from "@/platform/mobileSearch";
import { createLimiter, importPipelineConfig, mapConcurrent } from "../../shared/application/import-pipeline.mjs";
import { createJobProgressRecorder as createSharedJobProgressRecorder } from "../../shared/application/job-core.mjs";
import { inferPreset, isUsableLocation } from "../../shared/domain/geo.mjs";
import { mergeLocationCandidates, resolveImportedLocation, toAiEvidence } from "../../shared/domain/location-resolver.mjs";
import { applyPendingDecision } from "../../shared/domain/pending-workflow.mjs";
import { buildRoute } from "../../shared/domain/route-projector.mjs";
import { rebuildTrips, rebuildTripsForPhotos } from "../../shared/domain/trip-rebuilder.mjs";
import { buildImportStateFromPhotos } from "../../shared/import/import-state-core.mjs";
import { allowedInferencePlaces, buildInferenceContextPhotos, buildMissingInfoInferenceInput, keepPending, missingInferenceText, normalizeMissingInfoAiProposal } from "../../shared/import/missing-info-inference-core.mjs";
import type {
  GeoPoint,
  ImportBatch,
  LocationCandidate,
  PendingItem,
  Photo,
  PlaceNode,
  Route,
  Trip,
} from "@/domain/models";

type MobileImportJob = ImportJob;

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeArray<T = unknown>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function lastItem<T>(items: T[]) {
  return items.length ? items[items.length - 1] : undefined;
}

function mobileJobProgressRecorder(onJobProgress: ((progress: ImportJobProgress) => void) | undefined, total: number, phase: ImportJobProgress["phase"]) {
  return createSharedJobProgressRecorder({
    id: makeId("mobile-job"),
    total,
    phase,
    now: nowIso,
    onProgress: onJobProgress,
    save: (job: MobileImportJob) => {
      void writeNativeImportJob(job).catch(() => false);
    },
  });
}

async function enrichMobilePhotoWithAi(photo: Photo, { dataUrl, allowCloud, locale }: { dataUrl?: string; allowCloud: boolean; locale: "zh" | "en" }) {
  const preset = inferPreset(photo.fileName, photo.location);
  const ai: MobilePhotoAnalysis = await analyzeMobilePhoto({ fileName: photo.fileName, mime: photo.mime ?? "image/jpeg", dataUrl, preset, location: photo.location, allowCloud, locale });
  const aiEvidenceBase = toAiEvidence(ai, { makeId });
  const aiCandidates = await Promise.all((aiEvidenceBase.locationCandidates ?? []).map((candidate: LocationCandidate) => geocodeMobileAiCandidate(candidate, { makeId, locale })));
  const backendCandidates = photo.location ? await reverseMobileCandidates(photo.location, { makeId }) : [];
  const aiEvidence = {
    ...aiEvidenceBase,
    locationCandidates: mergeLocationCandidates(backendCandidates, aiCandidates),
  };
  return {
    ...photo,
    title: ai.title || photo.title,
    tags: ai.tags,
    aiCaption: ai.caption,
    ai: aiEvidence,
    locationResolution: resolveImportedLocation({ location: photo.location, aiEvidence, pendingReason: photo.pendingReason }),
    aiProvider: ai.provider,
    aiModel: ai.model,
    aiFallbackReason: ai.fallbackReason,
  };
}

function withMobileExifStatus(photo: Photo, hasExifTime: boolean, hasExifLocation: boolean): Photo {
  const pendingReason = hasExifLocation ? (hasExifTime ? undefined : "missing_time") : "missing_gps";
  return {
    ...photo,
    exifStatus: {
      time: hasExifTime ? "read" : "fallback",
      gps: hasExifLocation ? "read" : "missing",
    },
    pendingReason,
  } satisfies Photo;
}

async function mobileAiImageDataUrlFromSource(source: File | string | undefined, mime = "image/jpeg") {
  if (!source) return undefined;
  const pipelineConfig = importPipelineConfig();
  return createImageDataUrl(source, pipelineConfig.images.aiImageMaxDimension, pipelineConfig.images.aiImageJpegQuality, mime).catch(() => undefined);
}

async function mobileThumbnailDataUrlFromSource(source: File | string | undefined, mime = "image/jpeg") {
  if (!source) return "";
  const pipelineConfig = importPipelineConfig();
  return createImageDataUrl(source, pipelineConfig.images.thumbnailMaxDimension, pipelineConfig.images.thumbnailJpegQuality, mime).catch(() => "");
}

async function mobileAiImageDataUrlForPhoto(photo: Photo) {
  return mobileAiImageDataUrlFromSource(photo.sourceWebPath || photo.storageUrl || photo.thumbnailUrl, photo.mime ?? "image/jpeg");
}

function manualPlaceNames(name: string) {
  return { zh: name, en: name, local: name };
}

function visiblePlaceName(place: PlaceNode) {
  return place.userEdits?.name ?? place.displayName ?? place.name;
}

function clearManualExifStatus(photo: Photo, overrides: { gps?: "read" | "missing" | "fallback" } = {}) {
  return {
    ...(photo.exifStatus ?? {}),
    time: photo.exifStatus?.time ?? (photo.capturedAt ? "read" : "missing"),
    gps: overrides.gps ?? photo.exifStatus?.gps ?? (photo.location ? "fallback" : "missing"),
  };
}

function manualLocationCandidate({ name, point, geo }: { name: string; point: GeoPoint; geo: Awaited<ReturnType<typeof manualMobileGeoDescription>> }): LocationCandidate {
  return {
    id: makeId("candidate-manual"),
    name,
    localizedNames: { zh: name, en: name, local: name },
    country: geo.country,
    localizedCountryNames: geo.countryNames,
    city: geo.city ?? name,
    localizedCityNames: geo.cityNames,
    point,
    confidence: 1,
    source: "manual",
    precision: "confirmed",
    reason: "用户手动在地球上标记地点，并由本地地名库反查国家/城市。",
  };
}

function applyManualPlaceAssignment(
  photo: Photo,
  place: PlaceNode,
  {
    now,
    source,
    reason: _reason,
    precision,
    candidate,
  }: { now: string; source: LocationCandidate["source"]; reason: string; precision?: LocationCandidate["precision"]; candidate?: LocationCandidate },
): Photo {
  void _reason;
  const previous = photo.manualPlaceAssignment;
  const originalPlaceNodeId = previous?.originalPlaceNodeId ?? photo.placeNodeId;
  const originalLocation = previous?.originalLocation ?? photo.location;
  const originalLocationResolution = previous?.originalLocationResolution ?? photo.locationResolution;
  const originalExifStatus = previous?.originalExifStatus ?? photo.exifStatus;
  const restoredLocation = previous?.originalLocation;
  const returningToOriginalGpsPlace = Boolean(previous?.originalPlaceNodeId && previous.originalPlaceNodeId === place.id && restoredLocation);
  const alreadyInPlaceWithoutOverride = !previous && photo.placeNodeId === place.id;

  if (returningToOriginalGpsPlace) {
    return {
      ...photo,
      tripId: place.tripId,
      placeNodeId: place.id,
      location: restoredLocation,
      aiFailure: undefined,
      pendingReason: undefined,
      exifStatus: previous?.originalExifStatus ?? clearManualExifStatus({ ...photo, location: restoredLocation }),
      locationResolution: previous?.originalLocationResolution ?? photo.locationResolution,
      manualPlaceAssignment: undefined,
    };
  }

  if (alreadyInPlaceWithoutOverride) {
    return {
      ...photo,
      tripId: place.tripId,
      placeNodeId: place.id,
      aiFailure: undefined,
      pendingReason: undefined,
      locationResolution: photo.locationResolution
        ? {
            ...photo.locationResolution,
            status: "confirmed",
            requiresUserAction: false,
            updatedAt: now,
          }
        : photo.locationResolution,
    };
  }

  const candidates = candidate ? [candidate, ...(photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])] : (photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? []);

  return {
    ...photo,
    tripId: place.tripId,
    placeNodeId: place.id,
    location: place.center,
    aiFailure: undefined,
    pendingReason: undefined,
    exifStatus: clearManualExifStatus(photo, { gps: "fallback" }),
    manualPlaceAssignment: {
      placeId: place.id,
      originalPlaceNodeId,
      originalLocation,
      originalLocationResolution,
      originalExifStatus,
      updatedAt: now,
    },
    locationResolution: {
      ...(photo.locationResolution ?? {}),
      status: "confirmed",
      effectiveName: visiblePlaceName(place),
      effectivePoint: place.center,
      confidence: 1,
      source,
      precision,
      candidates,
      requiresUserAction: false,
      updatedAt: now,
    },
  };
}

function hasAiProcessingFailure(photo: Photo | undefined) {
  return Boolean(photo?.aiFailure?.vision || photo?.aiFailure?.embedding || photo?.pendingReason === "ai_processing_failed");
}

function pendingReasonFromExif(photo: Photo) {
  if (photo.exifStatus?.gps === "missing" || !isUsableLocation(photo.location)) return "missing_gps";
  if (photo.exifStatus?.time !== "read") return "missing_time";
  return undefined;
}

function hasMissingImportInfo(photo: Photo) {
  return photo.pendingReason === "missing_gps" || photo.pendingReason === "missing_time" || photo.exifStatus?.gps === "missing" || photo.exifStatus?.time !== "read";
}

function mobileAiFailurePatch(photo: Photo, embedding?: MobileEmbeddingResult): Photo {
  const visionFailure = photo.aiFallbackReason;
  const embeddingFailure = embedding?.embeddingMode === "failed" ? embedding.embeddingFallbackReason : photo.embeddingMode === "failed" ? photo.embeddingFallbackReason : undefined;
  const failed = Boolean(visionFailure || embeddingFailure);
  return {
    ...photo,
    aiFailure: failed
      ? {
          vision: visionFailure,
          embedding: embeddingFailure,
          hasRealExifGps: photo.exifStatus?.gps === "read" && isUsableLocation(photo.location),
          hasRealExifTime: photo.exifStatus?.time === "read",
          updatedAt: nowIso(),
        }
      : undefined,
    pendingReason: failed ? "ai_processing_failed" : photo.pendingReason,
    locationResolution: resolveImportedLocation({ location: photo.location, aiEvidence: photo.ai, pendingReason: failed ? "ai_processing_failed" : photo.pendingReason }),
  };
}

function clearAiFailureForPhoto(photo: Photo): Photo {
  const pendingReason = pendingReasonFromExif(photo);
  return {
    ...photo,
    aiFailure: undefined,
    pendingReason,
    locationResolution: resolveImportedLocation({ location: photo.location, aiEvidence: photo.ai, pendingReason }),
  };
}

function addMobileLocationPendingItems(photos: Photo[], pendingItems: PendingItem[]) {
  const suggested = photos.filter((photo) => !hasAiProcessingFailure(photo) && photo.locationResolution?.status === "suggested" && photo.locationResolution.candidateId);
  for (const photo of suggested) {
    const candidate = photo.locationResolution?.candidates?.find((item) => item.id === photo.locationResolution?.candidateId);
    if (!candidate?.point || !photo.tripId) continue;
    pendingItems.push({
      id: makeId("pending"),
      type: "confirm_location_candidate",
      relatedPhotoIds: [photo.id],
      relatedTripId: photo.tripId,
      suggestion: `AI 建议将「${photo.title ?? photo.fileName}」定位到「${photo.locationResolution?.effectiveName}」。`,
      reason: "照片缺少可靠 EXIF GPS，但 AI 给出了可解释的地点候选，需要用户确认后才写入确定坐标。",
      status: "open",
      proposal: {
        action: "create_place_from_candidate",
        tripId: photo.tripId,
        photoIds: [photo.id],
        candidate,
      },
    });
  }
}

function addMobileMissingInfoPendingItems(photos: Photo[], pendingItems: PendingItem[]) {
  for (const photo of photos.filter((item) => hasMissingImportInfo(item) && !hasAiProcessingFailure(item))) {
    const missingGps = photo.exifStatus?.gps === "missing" || photo.pendingReason === "missing_gps";
    const missingTime = photo.exifStatus?.time !== "read";
    pendingItems.push({
      id: makeId("pending"),
      type: missingGps ? "missing_gps" : "missing_time",
      relatedPhotoIds: [photo.id],
      relatedTripId: photo.tripId,
      suggestion: `${photo.title ?? photo.fileName} 缺少${missingGps && missingTime ? " GPS 和 EXIF 时间" : missingGps ? " GPS" : " EXIF 时间"}，可手动触发基于上下文推断。`,
      reason: "初次导入只完成单张照片理解；需要用户在待补信息中手动触发上下文推断后再确认。",
      status: "open",
    });
  }
}

function appendMissingInfoPendingIfNeeded(state: MobilePersistedState, batch: ImportBatch, photo: Photo): MobilePersistedState {
  if (hasAiProcessingFailure(photo) || !hasMissingImportInfo(photo)) return state;
  const alreadyOpen = state.pendingItems.some(
    (item) => item.status === "open" && batch.pendingItemIds.includes(item.id) && ["missing_gps", "missing_time", "confirm_location_candidate"].includes(item.type) && item.relatedPhotoIds?.includes(photo.id),
  );
  if (alreadyOpen) return state;
  const nextItems: PendingItem[] = [];
  addMobileLocationPendingItems([photo], nextItems);
  addMobileMissingInfoPendingItems([photo], nextItems);
  if (!nextItems.length) return state;
  return {
    ...state,
    pendingItems: [...state.pendingItems, ...nextItems],
    importBatches: state.importBatches.map((item) => (item.id === batch.id ? { ...item, pendingItemIds: [...item.pendingItemIds, ...nextItems.map((pendingItem) => pendingItem.id)] } : item)),
  };
}

function rebuildTripsForImportedPhoto(state: MobilePersistedState, photo: Photo, batch: ImportBatch, options = {}) {
  const affectedTripIds = new Set([photo.tripId, ...batch.createdTripIds, ...(batch.updatedTripIds ?? [])].filter(Boolean));
  return rebuildTrips(state, affectedTripIds, { makeId, ...options }) as MobilePersistedState;
}

function failureReasonText(photo: Photo) {
  return [
    photo.aiFailure?.hasRealExifGps ? "真实GPS" : "无GPS",
    photo.aiFailure?.vision ? `AI Vision：${photo.aiFailure.vision}` : undefined,
    photo.aiFailure?.embedding ? `Embedding：${photo.aiFailure.embedding}` : undefined,
  ]
    .filter(Boolean)
    .join("。");
}

export const mobileLocalApi = {
  async getState() {
    return projectState(await getMobilePersistedState());
  },
  async getImportJob(id: string) {
    return readNativeImportJob<MobileImportJob>(id);
  },
  async reverseGeocode(point: GeoPoint) {
    const nativeCandidates = await reverseMobileCandidates(point, { makeId, preferCity: true });
    if (nativeCandidates.length) return { candidates: nativeCandidates };
    const candidate: LocationCandidate = {
      id: makeId("candidate"),
      name: `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`,
      point,
      confidence: 0.5,
      source: "manual",
      precision: "estimated",
      reason: "Android GeoNames lookup returned no local candidate.",
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
    return readMobileAiSettings();
  },
  async getStorageSettings(): Promise<StorageSettings> {
    return {
      dataDir: "Android private app storage",
      dbPath: "Android private SQLite: earth-online.sqlite",
      importJobDir: "Android private SQLite: import_jobs",
      photoDir: "Gallery content URIs are referenced, not copied",
      rootDir: "Android app sandbox",
      source: "project",
      thumbDir: "Android IndexedDB thumbnails; originals stay in the gallery",
      vectorPath: "Android private SQLite: vector_index",
    };
  },
  async updateAiSettings(body: MobileAiSettingsUpdateBody) {
    return updateMobileAiSettings(body);
  },
  async rebuildPhotoEmbeddings(onJobProgress?: (progress: ImportJobProgress) => void, photoIds?: string[]) {
    const state = await getMobilePersistedState();
    const targetIds = new Set(photoIds ?? state.photos.map((photo) => photo.id));
    const targets = state.photos.filter((photo) => targetIds.has(photo.id));
    const total = targets.length;
    const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
    const failures: EmbeddingRebuildReport["failures"] = [];
    let done = 0;
    let successCount = 0;
    const pipelineConfig = importPipelineConfig();
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "embedding");
    jobProgress.update({ phase: "embedding", done, total, steps: { embedding: { done, total } } });
    const rebuiltPhotos = (await mapConcurrent(targets, pipelineConfig.concurrency.embedding, async (photo: Photo): Promise<Photo> => {
      try {
        const dataUrl = await mobileAiImageDataUrlForPhoto(photo);
        const embedding = await embedMobileImage({ dataUrl, fileName: photo.fileName });
        if (embedding?.embedding?.length) {
          vectorIndex[photo.id] = embedding.embedding;
          successCount += 1;
          return {
            ...photo,
            embeddingProvider: embedding.embeddingProvider,
            embeddingModel: embedding.embeddingModel,
            embeddingSpaceId: embedding.embeddingSpaceId,
            embeddingDimension: embedding.embeddingDimension,
            embeddingMode: embedding.embeddingMode,
            embeddingFallbackReason: undefined,
          };
        } else {
          delete vectorIndex[photo.id];
          return { ...photo, embeddingMode: "disabled" as const, embeddingFallbackReason: "Android embedding profile is disabled or missing API key." };
        }
      } catch (error) {
        delete vectorIndex[photo.id];
        failures.push({ id: photo.id, fileName: photo.fileName, reason: error instanceof Error ? error.message : String(error) });
        return { ...photo, embeddingMode: "failed" as const, embeddingFallbackReason: error instanceof Error ? error.message : String(error) };
      } finally {
        done += 1;
        jobProgress.update({ phase: done < total ? "embedding" : "completed", done, total, steps: { embedding: { done, total } }, currentFileName: photo.fileName });
      }
    })) as Photo[];
    const rebuiltById = new Map<string, Photo>(rebuiltPhotos.map((photo: Photo) => [photo.id, photo]));
    const photos = state.photos.map((photo) => rebuiltById.get(photo.id) ?? photo);
    const next = { ...state, photos };
    await writeMobilePersistedState(next);
    await writeNativeVectorIndex(vectorIndex).catch(() => false);
    const snapshot = await projectState(next);
    const result = {
      ...snapshot,
      embeddingRebuild: {
        total,
        successCount,
        failedCount: failures.length,
        failedPhotoIds: failures.map((failure) => failure.id),
        failures,
        mode: photoIds?.length ? "retry_failed" : "all",
      } satisfies EmbeddingRebuildReport,
    };
    jobProgress.complete(result);
    return result;
  },
  async importFiles(
    filesLike: FileList | File[],
    _allowCloudAi: boolean,
    _locale: "zh" | "en" = "zh",
    onProgress?: (done: number, total: number) => void,
    onJobProgress?: (progress: ImportJobProgress) => void,
  ) {
    const files = Array.from(filesLike).filter((file) => file.type.startsWith("image/"));
    const total = files.length;
    if (total === 0) throw new Error("没有收到可导入图片。");
    const state = await getMobilePersistedState();
    const existingHashes = new Set(state.photos.map((photo) => photo.originalHash).filter((value): value is string => Boolean(value)));
    const photos: Photo[] = [];
    const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
    const aiStats = vectorStatsDefaults();
    const duplicatePhotoIds: string[] = [];
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "reading");
    onProgress?.(0, total);
    jobProgress.update({ phase: "reading", done: 0, total, steps: { reading: { done: 0, total } } });
    let readingDone = 0;
    let exifDone = 0;
    let thumbnailDone = 0;
    let aiDone = 0;
    let embeddingDone = 0;
    const emitImportProgress = (phase: ImportJobProgress["phase"], phaseDone: number, currentFileName?: string) => {
      jobProgress.update({
        phase,
        done: phaseDone,
        total,
        currentFileName,
        steps: {
          reading: { done: readingDone, total },
          exif: { done: exifDone, total },
          thumbnails: { done: thumbnailDone, total },
          ai: { done: aiDone, total },
          embedding: { done: embeddingDone, total },
        },
      });
    };
    let done = 0;
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      readingDone += 1;
      emitImportProgress("reading", readingDone, file.name);
      const originalHash = await hashBuffer(buffer);
      if (originalHash && existingHashes.has(originalHash)) {
        const duplicate = state.photos.find((photo) => photo.originalHash === originalHash);
        if (duplicate?.id) duplicatePhotoIds.push(duplicate.id);
        exifDone += 1;
        thumbnailDone += 1;
        aiDone += 1;
        embeddingDone += 1;
        done += 1;
        emitImportProgress(done < total ? "reading" : "grouping", done, file.name);
        continue;
      }
      if (originalHash) existingHashes.add(originalHash);
      const exif = parseExif(buffer);
      exifDone += 1;
      emitImportProgress("exif", exifDone, file.name);
      const aiImageDataUrlPromise = _allowCloudAi ? mobileAiImageDataUrlFromSource(file, file.type) : Promise.resolve(undefined);
      const thumbnailUrl = await mobileThumbnailDataUrlFromSource(file, file.type);
      thumbnailDone += 1;
      emitImportProgress("thumbnails", thumbnailDone, file.name);
      let photo: Photo = {
        id: makeId("photo"),
        fileName: file.name,
        title: file.name.replace(/\.[^.]+$/, ""),
        originalHash,
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
      emitImportProgress("ai", aiDone, file.name);
      const aiImageDataUrl = await aiImageDataUrlPromise;
      photo = await enrichMobilePhotoWithAi(photo, { dataUrl: aiImageDataUrl, allowCloud: _allowCloudAi, locale: _locale });
      aiDone += 1;
      emitImportProgress("ai", aiDone, file.name);
      emitImportProgress("embedding", embeddingDone, file.name);
      const embedding: MobileEmbeddingResult | undefined = await embedMobileImage({ dataUrl: aiImageDataUrl, fileName: file.name, allowCloud: _allowCloudAi }).catch((error) => ({
        embeddingMode: "failed" as const,
        embeddingFallbackReason: error instanceof Error ? error.message : String(error),
      }));
      recordMobileEmbeddingStats(embedding, aiStats);
      photo = {
        ...photo,
        embeddingProvider: embedding?.embeddingProvider,
        embeddingModel: embedding?.embeddingModel,
        embeddingSpaceId: embedding?.embeddingSpaceId,
        embeddingDimension: embedding?.embeddingDimension,
        embeddingMode: embedding?.embeddingMode,
        embeddingFallbackReason: embedding?.embeddingFallbackReason,
      };
      photo = mobileAiFailurePatch(photo, embedding);
      if (embedding?.embedding?.length) vectorIndex[photo.id] = embedding.embedding;
      embeddingDone += 1;
      emitImportProgress("embedding", embeddingDone, file.name);
      photos.push(photo);
      done += 1;
    }
    const next = buildImportStateFromPhotos(state, {
      totalCount: files.length,
      photos,
      duplicateCount: duplicatePhotoIds.length,
      duplicatePhotoIds,
      makeId,
      now: new Date(),
      locale: _locale,
      aiStats,
    }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    await writeNativeVectorIndex(vectorIndex).catch(() => false);
    emitImportProgress("completed", total);
    const snapshot = await projectState(next);
    jobProgress.complete(snapshot);
    return snapshot;
  },
  async importMobilePhotoAssets(
    assetsLike: NativePhotoAsset[],
    _allowCloudAi: boolean,
    _locale: "zh" | "en" = "zh",
    onProgress?: (done: number, total: number) => void,
    onJobProgress?: (progress: ImportJobProgress) => void,
  ) {
    const assets = assetsLike.filter((asset) => !asset.error && asset.uri && asset.mimeType?.startsWith("image/"));
    const total = assets.length;
    if (!total) return projectState(await getMobilePersistedState());

    const state = await getMobilePersistedState();
    const knownHashToPhoto = new Map(state.photos.filter((photo) => photo.originalHash).map((photo) => [photo.originalHash, photo]));
    const knownHashes = new Set(knownHashToPhoto.keys());
    const duplicatePhotoIds = new Set<string>();
    const importedSlots = new Array<Photo | undefined>(total);
    const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
    const aiStats = vectorStatsDefaults();
    const pipelineConfig = importPipelineConfig();
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "reading");
    onProgress?.(0, total);
    jobProgress.update({
      phase: "reading",
      done: 0,
      total,
      steps: {
        reading: { done: 0, total },
        exif: { done: 0, total },
        thumbnails: { done: 0, total },
        ai: { done: 0, total },
        embedding: { done: 0, total },
      },
    });
    let readingDone = 0;
    let exifDone = 0;
    let thumbnailDone = 0;
    let aiDone = 0;
    let embeddingDone = 0;
    const emitImportProgress = (phase: ImportJobProgress["phase"], phaseDone: number, currentFileName?: string) => {
      jobProgress.update({
        phase,
        done: phaseDone,
        total,
        currentFileName,
        steps: {
          reading: { done: readingDone, total },
          exif: { done: exifDone, total },
          thumbnails: { done: thumbnailDone, total },
          ai: { done: aiDone, total },
          embedding: { done: embeddingDone, total },
        },
      });
    };

    const markThumbnailDone = (fileName: string) => {
      thumbnailDone += 1;
      emitImportProgress("thumbnails", thumbnailDone, fileName);
    };
    const markAiDone = (fileName: string) => {
      aiDone += 1;
      emitImportProgress("ai", aiDone, fileName);
    };
    const markEmbeddingDone = (fileName: string) => {
      embeddingDone += 1;
      emitImportProgress("embedding", embeddingDone, fileName);
    };
    const storageLimit = createLimiter(pipelineConfig.concurrency.storageWrite);
    const visionLimit = createLimiter(pipelineConfig.concurrency.ai);
    const embeddingLimit = createLimiter(pipelineConfig.concurrency.embedding);
    const downstreamTasks: Promise<void>[] = [];
    const allowCloud = _allowCloudAi !== false;

    await mapConcurrent(assets, pipelineConfig.concurrency.metadata, async (asset: NativePhotoAsset, index: number) => {
      const fileName = asset.fileName || `photo-${index + 1}`;
      emitImportProgress("reading", readingDone, fileName);
      let prepared: NativePhotoAsset;
      try {
        prepared = await prepareNativePhotoAsset(asset);
      } catch (error) {
        readingDone += 1;
        exifDone += 1;
        thumbnailDone += 1;
        aiDone += 1;
        embeddingDone += 1;
        emitImportProgress("reading", readingDone, fileName);
        emitImportProgress("exif", exifDone, fileName);
        emitImportProgress("thumbnails", thumbnailDone, fileName);
        emitImportProgress("ai", aiDone, fileName);
        emitImportProgress("embedding", embeddingDone, fileName);
        console.error(error);
        return;
      }
      readingDone += 1;
      emitImportProgress("reading", readingDone, prepared.fileName);

      const buffer = prepared.webPath
        ? await fetch(prepared.webPath)
            .then((response) => response.arrayBuffer())
            .catch(() => undefined)
        : undefined;
      const parsedExif = buffer ? parseExif(buffer) : {};
      const nativeLocation = typeof prepared.latitude === "number" && typeof prepared.longitude === "number" ? { lat: prepared.latitude, lng: prepared.longitude } : undefined;
      const exifLocation = isUsableLocation(nativeLocation) ? nativeLocation : parsedExif.location;
      const capturedAt = prepared.capturedAt ?? parsedExif.capturedAt;
      const originalHash = prepared.sha256 ?? (buffer ? await hashBuffer(buffer).catch(() => undefined) : undefined) ?? prepared.uri;
      exifDone += 1;
      emitImportProgress("exif", exifDone, prepared.fileName);

      if (knownHashes.has(originalHash)) {
        const duplicatePhoto = knownHashToPhoto.get(originalHash);
        if (duplicatePhoto?.id) duplicatePhotoIds.add(duplicatePhoto.id);
        markThumbnailDone(prepared.fileName);
        markAiDone(prepared.fileName);
        markEmbeddingDone(prepared.fileName);
        await releaseNativePhotoPermissions([prepared.uri]);
        return;
      }

      knownHashes.add(originalHash);
      const importAsset: NativePhotoAsset = {
        ...prepared,
        capturedAt,
        latitude: exifLocation?.lat,
        longitude: exifLocation?.lng,
        sha256: originalHash,
      };
      const aiImagePayload = allowCloud && prepared.webPath ? mobileAiImageDataUrlFromSource(prepared.webPath, prepared.mimeType).then((dataUrl) => (dataUrl ? { dataUrl, mime: "image/jpeg" } : undefined)) : Promise.resolve(undefined);

      downstreamTasks.push(
        Promise.all([
          storageLimit(async () => {
            const thumbnailDataUrl = await mobileThumbnailDataUrlFromSource(prepared.webPath, prepared.mimeType);
            markThumbnailDone(prepared.fileName);
            return thumbnailDataUrl;
          }),
          visionLimit(async () => {
            emitImportProgress("ai", aiDone, prepared.fileName);
            const imagePayload = await aiImagePayload.catch(() => undefined);
            const basePhoto = withMobileExifStatus(photoFromNativeAsset(importAsset, { makeId, nowIso }), Boolean(capturedAt), Boolean(exifLocation));
            const aiPhoto = await enrichMobilePhotoWithAi(basePhoto, { dataUrl: imagePayload?.dataUrl, allowCloud, locale: _locale });
            markAiDone(prepared.fileName);
            return aiPhoto;
          }),
          embeddingLimit(async () => {
            emitImportProgress("embedding", embeddingDone, prepared.fileName);
            const imagePayload = await aiImagePayload.catch(() => undefined);
            const embedding: MobileEmbeddingResult | undefined = await embedMobileImage({ dataUrl: imagePayload?.dataUrl, fileName: prepared.fileName, allowCloud }).catch((error) => ({
              embeddingMode: "failed" as const,
              embeddingFallbackReason: error instanceof Error ? error.message : String(error),
            }));
            markEmbeddingDone(prepared.fileName);
            return embedding;
          }),
        ]).then(([thumbnailDataUrl, aiPhoto, embedding]) => {
          let photo: Photo = {
            ...aiPhoto,
            thumbnailUrl: thumbnailDataUrl || aiPhoto.thumbnailUrl,
          };
          recordMobileEmbeddingStats(embedding, aiStats);
          photo = {
            ...photo,
            embeddingProvider: embedding?.embeddingProvider,
            embeddingModel: embedding?.embeddingModel,
            embeddingSpaceId: embedding?.embeddingSpaceId,
            embeddingDimension: embedding?.embeddingDimension,
            embeddingMode: embedding?.embeddingMode,
            embeddingFallbackReason: embedding?.embeddingFallbackReason,
          };
          photo = mobileAiFailurePatch(photo, embedding);
          if (embedding?.embedding?.length) vectorIndex[photo.id] = embedding.embedding;
          importedSlots[index] = photo;
        }),
      );
    });

    await Promise.all(downstreamTasks);
    const photos = importedSlots.filter((photo): photo is Photo => Boolean(photo));

    if (!photos.length) {
      emitImportProgress("completed", total);
      const snapshot = await projectState(state);
      jobProgress.complete(snapshot);
      return snapshot;
    }

    const next = buildImportStateFromPhotos(state, {
      totalCount: total,
      photos,
      duplicateCount: duplicatePhotoIds.size,
      duplicatePhotoIds: Array.from(duplicatePhotoIds),
      makeId,
      now: new Date(),
      locale: _locale,
      aiStats,
    }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    await writeNativeVectorIndex(vectorIndex).catch(() => false);
    emitImportProgress("completed", total);
    const snapshot = await projectState(next);
    jobProgress.complete(snapshot);
    return snapshot;
  },
  async importAppleTestPhotos() {
    return projectState(await getMobilePersistedState());
  },
  async confirmImport(batchId: string) {
    const state = await getMobilePersistedState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") return projectState(state);
    const blockingTypes = new Set(["missing_gps", "missing_time", "confirm_location_candidate", "ai_processing_failed"]);
    const openMissingItems = state.pendingItems.filter((item) => batch.pendingItemIds.includes(item.id) && item.status === "open" && blockingTypes.has(item.type));
    if (openMissingItems.length) throw new Error("仍有待补信息或 AI 初次处理失败照片未处理，不能确认导入。");
    const created = new Set(batch.createdTripIds ?? []);
    const trips = state.trips.map((trip) => (created.has(trip.id) ? { ...trip, status: "confirmed" as const } : trip));
    const next = {
      ...state,
      trips,
      importBatches: state.importBatches.map((item) => (item.id === batchId ? { ...item, status: "confirmed" as const } : item)),
    };
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async rollbackImport(batchId: string) {
    const state = await getMobilePersistedState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const latestPending = lastItem(state.importBatches.filter((item) => item.status === "pending_confirmation"));
    if (!batch || batch.id !== latestPending?.id) throw new Error("MVP 只支持回撤最近一次待确认导入。");
    const addedPhotoIds = new Set(batch.addedPhotoIds);
    const createdTripIds = new Set(batch.createdTripIds);
    const affectedExistingTripIds = new Set(safeArray(batch.updatedTripIds));
    const pendingIds = new Set(batch.pendingItemIds);
    const removedPhotos = state.photos.filter((photo) => addedPhotoIds.has(photo.id));
    const base = {
      ...state,
      photos: state.photos.filter((photo) => !addedPhotoIds.has(photo.id)),
      trips: state.trips.filter((trip) => !createdTripIds.has(trip.id)),
      placeNodes: state.placeNodes.filter((place) => !createdTripIds.has(place.tripId)),
      routes: state.routes.filter((route) => !createdTripIds.has(route.tripId)),
      pendingItems: state.pendingItems.filter((item) => !pendingIds.has(item.id)),
      importBatches: state.importBatches.map((item) => (item.id === batchId ? { ...item, status: "rolled_back" as const } : item)),
    };
    const next = rebuildTrips(base, affectedExistingTripIds, { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    deleteMobileThumbnailsForPhotos(removedPhotos);
    await releaseNativePhotoPermissions(sourceUrisForPhotos(removedPhotos)).catch(() => undefined);
    await deleteNativeVectors(removedPhotos.map((photo) => photo.id)).catch(() => false);
    return projectState(next);
  },
  async cancelImportPhotos(batchId: string, photoIds: string[]) {
    const state = await getMobilePersistedState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const latestPending = lastItem(state.importBatches.filter((item) => item.status === "pending_confirmation"));
    if (!batch || batch.id !== latestPending?.id) throw new Error("只能从最近一次待确认导入中取消照片。");
    const requested = new Set(photoIds);
    const batchPhotoIds = new Set(batch.addedPhotoIds);
    const cancelIds = new Set([...requested].filter((id) => batchPhotoIds.has(id)));
    if (cancelIds.size === 0) return projectState(state);
    const cancelPhotos = state.photos.filter((photo) => cancelIds.has(photo.id));
    const affectedTripIds = new Set(cancelPhotos.map((photo) => photo.tripId).filter((id): id is string => Boolean(id)));
    const remainingAddedPhotoIds = batch.addedPhotoIds.filter((id) => !cancelIds.has(id));
    const emptyCreatedTripIds = new Set(
      batch.createdTripIds.filter((tripId) => !state.photos.some((photo) => photo.tripId === tripId && !cancelIds.has(photo.id))),
    );
    for (const tripId of emptyCreatedTripIds) affectedTripIds.delete(tripId);
    const pendingItems = state.pendingItems
      .map((item) => {
        if (!batch.pendingItemIds.includes(item.id)) return item;
        const relatedPhotoIds = safeArray(item.relatedPhotoIds).filter((id) => !cancelIds.has(id));
        return { ...item, relatedPhotoIds };
      })
      .filter((item) => !batch.pendingItemIds.includes(item.id) || safeArray(item.relatedPhotoIds).length > 0);
    const pendingIds = new Set(pendingItems.filter((item) => batch.pendingItemIds.includes(item.id)).map((item) => item.id));
    const canceledMissingCount = cancelPhotos.filter((photo) => photo.pendingReason).length;
    const canceledSuccessCount = cancelIds.size - canceledMissingCount;
    const patchedBatch = {
      ...batch,
      totalCount: Math.max(0, batch.totalCount - cancelIds.size),
      successCount: Math.max(0, batch.successCount - canceledSuccessCount),
      failedCount: Math.max(0, batch.failedCount - canceledMissingCount),
      createdTripIds: batch.createdTripIds.filter((id) => !emptyCreatedTripIds.has(id)),
      addedPhotoIds: remainingAddedPhotoIds,
      pendingItemIds: batch.pendingItemIds.filter((id) => pendingIds.has(id)),
      storedFileNames: safeArray(batch.storedFileNames),
      storedThumbnailNames: safeArray(batch.storedThumbnailNames),
      status: remainingAddedPhotoIds.length > 0 ? batch.status : ("rolled_back" as const),
      summary: `${batch.summary} 已取消 ${cancelIds.size} 张待补照片。`,
    };
    const base = {
      ...state,
      photos: state.photos.filter((photo) => !cancelIds.has(photo.id)),
      trips: state.trips.filter((trip) => !emptyCreatedTripIds.has(trip.id)),
      placeNodes: state.placeNodes.filter((place) => !emptyCreatedTripIds.has(place.tripId)).map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => !cancelIds.has(id)) })),
      routes: state.routes.filter((route) => !emptyCreatedTripIds.has(route.tripId)),
      pendingItems,
      importBatches: state.importBatches.map((item) => (item.id === batchId ? patchedBatch : item)),
    };
    const next = rebuildTrips(base, affectedTripIds, { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    deleteMobileThumbnailsForPhotos(cancelPhotos);
    await releaseNativePhotoPermissions(sourceUrisForPhotos(cancelPhotos)).catch(() => undefined);
    await deleteNativeVectors(cancelPhotos.map((photo) => photo.id)).catch(() => false);
    return projectState(next);
  },
  async inferPendingLocation(_batchId: string, pendingId: string, locale: "zh" | "en" = "zh") {
    const state = await getMobilePersistedState();
    const batch = state.importBatches.find((item) => item.id === _batchId);
    const pending = state.pendingItems.find((item) => item.id === pendingId);
    const photo = state.photos.find((item) => pending?.relatedPhotoIds?.includes(item.id));
    if (!batch || batch.status !== "pending_confirmation" || !pending || !batch.pendingItemIds.includes(pending.id) || !photo || !["missing_gps", "confirm_location_candidate"].includes(pending.type)) return projectState(state);
    const context = buildInferenceContextPhotos(state, batch, photo);
    const contextPlaces = allowedInferencePlaces(state, context);
    const dataUrl = await mobileAiImageDataUrlForPhoto(photo);
    let proposal;
    try {
      if (!dataUrl) throw new Error(missingInferenceText(locale, "imageMissing"));
      const inferenceInput = buildMissingInfoInferenceInput({ photo, context, contextPlaces, locale });
      let aiResult = await inferMobileMissingInfoWithImage({ dataUrl, mime: photo.mime ?? "image/jpeg", inferenceInput, locale });
      if (aiResult.action === "create_place_from_candidate") {
        aiResult = { ...aiResult, candidate: await geocodeMobileAiCandidate(aiResult.candidate as LocationCandidate, { makeId, locale }) };
      } else if (aiResult.action === "keep_pending" && aiResult.candidate?.name) {
        aiResult = { ...aiResult, candidate: await geocodeMobileAiCandidate(aiResult.candidate as LocationCandidate, { makeId, locale }) };
      }
      proposal = normalizeMissingInfoAiProposal({
        aiResult,
        photo,
        context,
        contextPlaces,
        locale,
        completeCandidatePoint: (candidate: LocationCandidate) => candidate,
      });
    } catch (error) {
      proposal = keepPending(error instanceof Error ? error.message : missingInferenceText(locale, "secondInferenceFailed"), 0, locale);
    }
    const nextPending: PendingItem = {
      ...pending,
      suggestion: proposal.suggestion,
      reason: proposal.reason,
      proposal: proposal.actionable ? proposal.proposal : undefined,
      inference: {
        status: proposal.actionable ? "suggested" : "keep_pending",
        confidence: proposal.confidence,
        reason: proposal.reason,
        displayTarget: proposal.displayTarget,
        displayTargetLabel: proposal.displayTargetLabel,
        displayTargetBadge: proposal.displayTargetBadge,
        updatedAt: nowIso(),
      },
    };
    const next: MobilePersistedState = {
      ...state,
      pendingItems: state.pendingItems.map((item) => (item.id === pending.id ? nextPending : item)),
    };
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async inferPendingLocations(batchId: string, pendingIds: string[], locale: "zh" | "en" = "zh", onJobProgress?: (progress: ImportJobProgress) => void) {
    let snapshot = await projectState(await getMobilePersistedState());
    const total = pendingIds.length;
    let done = 0;
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "ai");
    jobProgress.update({ phase: "ai", done, total });
    for (const pendingId of pendingIds) {
      snapshot = await this.inferPendingLocation(batchId, pendingId, locale);
      done += 1;
      jobProgress.update({ phase: done < total ? "ai" : "completed", done, total });
    }
    jobProgress.complete(snapshot);
    return snapshot;
  },
  async resolveImportAiFailure(batchId: string, pendingId: string, action: string = "retry_both", locale: "zh" | "en" = "zh") {
    const state = await getMobilePersistedState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const pending = state.pendingItems.find((item) => item.id === pendingId);
    const photo = state.photos.find((item) => pending?.relatedPhotoIds?.includes(item.id));
    if (!batch || batch.status !== "pending_confirmation" || !pending || !batch.pendingItemIds.includes(pending.id) || pending.type !== "ai_processing_failed" || !photo) return projectState(state);

    if (action === "archive_exif") {
      if (photo.exifStatus?.gps !== "read" || !isUsableLocation(photo.location)) throw new Error("这张照片没有真实 EXIF GPS，不能直接按真实定位归档。");
      const patched: Photo = {
        ...clearAiFailureForPhoto(photo),
        placeNodeId: undefined,
      };
      const base = appendMissingInfoPendingIfNeeded({
        ...state,
        photos: state.photos.map((item) => (item.id === photo.id ? patched : item)),
        pendingItems: state.pendingItems.map((item) => (item.id === pending.id ? { ...item, status: "accepted" as const } : item)),
      }, batch, patched);
      const next = rebuildTripsForImportedPhoto(base, patched, batch, { allowExistingPlaceMerge: true });
      await writeMobilePersistedState(next);
      return projectState(next);
    }

    let patched = photo;
    let embedding: MobileEmbeddingResult | undefined;
    let retryImageDataUrl: string | undefined;
    const getRetryImageDataUrl = async () => {
      retryImageDataUrl ??= await mobileAiImageDataUrlForPhoto(patched);
      return retryImageDataUrl;
    };
    if (action === "retry_vision" || action === "retry_both") {
      patched = await enrichMobilePhotoWithAi(patched, { dataUrl: await getRetryImageDataUrl(), allowCloud: true, locale });
    }
    if (action === "retry_embedding" || action === "retry_both") {
      const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
      embedding = await embedMobileImage({ dataUrl: await getRetryImageDataUrl(), fileName: patched.fileName }).catch((error) => ({
        embeddingMode: "failed" as const,
        embeddingFallbackReason: error instanceof Error ? error.message : String(error),
      }) satisfies MobileEmbeddingResult);
      patched = {
        ...patched,
        embeddingProvider: embedding?.embeddingProvider,
        embeddingModel: embedding?.embeddingModel,
        embeddingSpaceId: embedding?.embeddingSpaceId,
        embeddingDimension: embedding?.embeddingDimension,
        embeddingMode: embedding?.embeddingMode,
        embeddingFallbackReason: embedding?.embeddingFallbackReason,
      };
      if (embedding?.embedding?.length) vectorIndex[patched.id] = embedding.embedding;
      else delete vectorIndex[patched.id];
      await writeNativeVectorIndex(vectorIndex).catch(() => false);
    }
    const failed = Boolean(patched.aiFallbackReason || patched.embeddingMode === "failed");
    const pendingReason = failed ? "ai_processing_failed" : pendingReasonFromExif(patched);
    patched = {
      ...patched,
      aiFailure: failed
        ? {
            vision: patched.aiFallbackReason,
            embedding: embedding?.embeddingMode === "failed" ? embedding.embeddingFallbackReason : patched.embeddingFallbackReason,
            hasRealExifGps: patched.exifStatus?.gps === "read" && isUsableLocation(patched.location),
            hasRealExifTime: patched.exifStatus?.time === "read",
            updatedAt: nowIso(),
          }
        : undefined,
      pendingReason,
      locationResolution: resolveImportedLocation({ location: patched.location, aiEvidence: patched.ai, pendingReason }),
    };
    const base = {
      ...state,
      photos: state.photos.map((item) => (item.id === patched.id ? patched : item)),
      pendingItems: state.pendingItems.map((item) =>
        item.id === pending.id
          ? failed
            ? { ...item, reason: failureReasonText(patched) || item.reason, suggestion: `${patched.title ?? patched.fileName} 初次导入 AI 仍处理失败，需要重新选择处理方式。` }
            : { ...item, status: "accepted" as const }
          : item,
      ),
    };
    const withPending = failed ? base : appendMissingInfoPendingIfNeeded(base, batch, patched);
    const next = rebuildTripsForImportedPhoto(withPending, patched, batch, { allowExistingPlaceMerge: true });
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async resolveImportAiFailures(batchId: string, pendingIds: string[], action: string = "retry_both", locale: "zh" | "en" = "zh", onJobProgress?: (progress: ImportJobProgress) => void) {
    let snapshot = await projectState(await getMobilePersistedState());
    const total = pendingIds.length;
    let done = 0;
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "ai");
    jobProgress.update({ phase: "ai", done, total });
    for (const pendingId of pendingIds) {
      snapshot = await this.resolveImportAiFailure(batchId, pendingId, action, locale);
      done += 1;
      jobProgress.update({ phase: done < total ? "ai" : "completed", done, total });
    }
    jobProgress.complete(snapshot);
    return snapshot;
  },
  async mergeImportTrips(batchId: string) {
    const state = await getMobilePersistedState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.createdTripIds.length <= 1) return projectState(state);
    const [targetTripId, ...removeTripIds] = batch.createdTripIds;
    const removeSet = new Set(removeTripIds);
    const batchPhotos = state.photos.filter((photo) => batch.addedPhotoIds.includes(photo.id));
    const dates = batchPhotos.map((photo) => photo.capturedAt).filter(Boolean).sort();
    const placeNodes = state.placeNodes.map((place) => (removeSet.has(place.tripId) ? { ...place, tripId: targetTripId } : place));
    const targetPlaces = placeNodes.filter((place) => place.tripId === targetTripId);
    const routes = state.routes.filter((route) => !batch.createdTripIds.includes(route.tripId)).concat(buildRoute(targetTripId, targetPlaces) as Route);
    const next = {
      ...state,
      photos: state.photos.map((photo) => (photo.tripId && removeSet.has(photo.tripId) ? { ...photo, tripId: targetTripId } : photo)),
      placeNodes,
      routes,
      trips: state.trips
        .filter((trip) => !removeSet.has(trip.id))
        .map((trip) =>
          trip.id === targetTripId
            ? {
                ...trip,
                dateRange: { start: String(dates[0] ?? trip.dateRange.start).slice(0, 10), end: String(dates[dates.length - 1] ?? trip.dateRange.end).slice(0, 10) },
                photoCount: batchPhotos.length,
                placeNodeCount: targetPlaces.length,
                status: "pending" as const,
              }
            : trip,
        ),
      importBatches: state.importBatches.map((item) => (item.id === batchId ? { ...item, createdTripIds: [targetTripId], summary: `${item.summary} 已按用户选择合并为一个旅行档案。` } : item)),
      pendingItems: state.pendingItems.map((item) => (item.type === "split_suggestion" && batch.pendingItemIds.includes(item.id) ? { ...item, status: "accepted" as const } : item)),
    };
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async createTrip(title: string, start: string, end: string) {
    const state = await getMobilePersistedState();
    const trip: Trip = { id: makeId("trip"), title, dateRange: { start, end }, countries: [], cities: [], coverUrl: "", photoCount: 0, placeNodeCount: 0, status: "confirmed", source: "manual" };
    const next = { ...state, trips: [...state.trips, trip] };
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async updateTrip(tripId: string, body: { title?: string; dateRange?: { start: string; end: string } }) {
    const state = await getMobilePersistedState();
    const next = { ...state, trips: state.trips.map((trip) => (trip.id === tripId ? { ...trip, title: body.title ?? trip.title, dateRange: body.dateRange ?? trip.dateRange } : trip)) };
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async deleteTrip(tripId: string) {
    const state = await getMobilePersistedState();
    const removedPhotos = state.photos.filter((photo) => photo.tripId === tripId);
    const next = {
      ...state,
      trips: state.trips.filter((trip) => trip.id !== tripId),
      photos: state.photos.filter((photo) => photo.tripId !== tripId),
      placeNodes: state.placeNodes.filter((place) => place.tripId !== tripId),
      routes: state.routes.filter((route) => route.tripId !== tripId),
    };
    await writeMobilePersistedState(next);
    deleteMobileThumbnailsForPhotos(removedPhotos);
    void releaseNativePhotoPermissions(sourceUrisForPhotos(removedPhotos));
    void deleteNativeVectors(removedPhotos.map((photo) => photo.id));
    return projectState(next);
  },
  async createPlace(body: { tripId: string; name: string; lat: number; lng: number }) {
    const state = await getMobilePersistedState();
    const now = nowIso();
    const center = { lat: Number(body.lat), lng: Number(body.lng) };
    const geo = await manualMobileGeoDescription(center, { makeId });
    const name = body.name?.trim() || "手动地点";
    const place: PlaceNode = {
      id: makeId("manual-place"),
      tripId: body.tripId,
      name,
      names: manualPlaceNames(name),
      displayName: name,
      userEdits: { name, updatedAt: now },
      center,
      ...geo,
      photoIds: [],
      timeRange: { start: now, end: now },
      pending: false,
    };
    const placeNodes = [...state.placeNodes, place];
    const tripPlaces = placeNodes.filter((item) => item.tripId === body.tripId);
    const routes = state.routes.filter((route) => route.tripId !== body.tripId).concat(buildRoute(body.tripId, tripPlaces) as Route);
    const next = { ...state, placeNodes, routes };
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async updatePlace(placeId: string, body: { name?: string }) {
    const state = await getMobilePersistedState();
    const name = String(body.name ?? "").trim();
    const now = nowIso();
    const next = {
      ...state,
      placeNodes: state.placeNodes.map((place) =>
        place.id === placeId && name
          ? {
              ...place,
              name,
              names: manualPlaceNames(name),
              displayName: name,
              userEdits: { ...(place.userEdits ?? {}), name, updatedAt: now },
            }
          : place,
      ),
    };
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async deletePlace(placeId: string) {
    const state = await getMobilePersistedState();
    const place = state.placeNodes.find((item) => item.id === placeId);
    if (!place) return projectState(state);
    const placeNodes = state.placeNodes.filter((item) => item.id !== placeId);
    const tripPlaces = placeNodes.filter((item) => item.tripId === place.tripId);
    const routes = state.routes.filter((route) => route.tripId !== place.tripId).concat(buildRoute(place.tripId, tripPlaces) as Route);
    const next = {
      ...state,
      photos: state.photos.map((photo) => (photo.placeNodeId === placeId ? { ...photo, placeNodeId: undefined } : photo)),
      placeNodes,
      routes,
    };
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async reorderPlaces(tripId: string, body: { placeIds?: string[] } | string[]) {
    const state = await getMobilePersistedState();
    const order = Array.isArray(body) ? body : Array.isArray(body.placeIds) ? body.placeIds : [];
    const owned = state.placeNodes.filter((place) => place.tripId === tripId);
    const byId = new Map(owned.map((place) => [place.id, place]));
    const orderedOwned = order.map((id) => byId.get(id)).filter((place): place is PlaceNode => Boolean(place));
    for (const place of owned) {
      if (!orderedOwned.some((item) => item.id === place.id)) orderedOwned.push(place);
    }
    const other = state.placeNodes.filter((place) => place.tripId !== tripId);
    const placeNodes = [...other, ...orderedOwned];
    const routes = state.routes.filter((route) => route.tripId !== tripId).concat(buildRoute(tripId, orderedOwned) as Route);
    const next = { ...state, placeNodes, routes };
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async movePhoto(photoId: string, body: { tripId?: string }) {
    const state = await getMobilePersistedState();
    const beforeTripId = state.photos.find((photo) => photo.id === photoId)?.tripId;
    const patched = {
      ...state,
      photos: state.photos.map((photo) => (photo.id === photoId ? { ...photo, tripId: body.tripId, placeNodeId: undefined } : photo)),
      placeNodes: state.placeNodes.map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => id !== photoId) })),
    };
    const next = rebuildTrips(patched, new Set([beforeTripId, body.tripId].filter(Boolean)), { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async deletePhoto(photoId: string) {
    const state = await getMobilePersistedState();
    const removedPhotos = state.photos.filter((photo) => photo.id === photoId);
    const affectedTripIds = new Set(state.photos.filter((photo) => photo.id === photoId && photo.tripId).map((photo) => photo.tripId));
    for (const place of state.placeNodes) {
      if (place.photoIds?.includes(photoId)) affectedTripIds.add(place.tripId);
    }
    const patched = {
      ...state,
      photos: state.photos.filter((photo) => photo.id !== photoId),
      placeNodes: state.placeNodes.map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => id !== photoId) })),
      pendingItems: state.pendingItems
        .map((item) => ({ ...item, relatedPhotoIds: item.relatedPhotoIds.filter((id) => id !== photoId) }))
        .filter((item) => item.relatedPhotoIds.length > 0),
      importBatches: state.importBatches.map((batch) => ({
        ...batch,
        addedPhotoIds: batch.addedPhotoIds.filter((id) => id !== photoId),
        duplicatePhotoIds: batch.duplicatePhotoIds?.filter((id) => id !== photoId) ?? [],
      })),
    };
    const next = rebuildTrips(patched, affectedTripIds, { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    deleteMobileThumbnailsForPhotos(removedPhotos);
    void releaseNativePhotoPermissions(sourceUrisForPhotos(removedPhotos));
    void deleteNativeVectors(removedPhotos.map((photo) => photo.id));
    return projectState(next);
  },
  async updatePhoto(photoId: string, body: { capturedAt?: string; location?: GeoPoint; tags?: string[]; userEdits?: { title?: string; caption?: string; tags?: string[] } }) {
    const state = await getMobilePersistedState();
    const patched = {
      ...state,
      photos: state.photos.map((photo) =>
        photo.id === photoId
          ? {
              ...photo,
              capturedAt: body.capturedAt === "" ? undefined : body.capturedAt ?? photo.capturedAt,
              location: body.location === undefined ? photo.location : body.location,
              tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : photo.tags,
              userEdits:
                body.userEdits === undefined
                  ? photo.userEdits
                  : {
                      ...(photo.userEdits ?? {}),
                      title: body.userEdits.title?.trim(),
                      caption: body.userEdits.caption?.trim(),
                      tags: Array.isArray(body.userEdits.tags) ? body.userEdits.tags.map(String).map((tag) => tag.trim()).filter(Boolean) : undefined,
                      updatedAt: nowIso(),
                    },
              pendingReason: body.location && (body.capturedAt ?? photo.capturedAt) ? undefined : photo.pendingReason,
            }
          : photo,
      ),
    };
    const next = rebuildTripsForPhotos(patched, new Set([photoId]), { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async bindPhoto(photoId: string, placeId?: string) {
    const state = await getMobilePersistedState();
    const place = state.placeNodes.find((item) => item.id === placeId);
    const beforeTripId = state.photos.find((photo) => photo.id === photoId)?.tripId;
    if (!place) return projectState(state);
    const now = nowIso();
    const patched = {
      ...state,
      photos: state.photos.map((photo) =>
        photo.id === photoId
          ? applyManualPlaceAssignment(photo, place, {
              now,
              source: "manual_existing_place",
              reason: "用户手动将照片移动到已有地点。",
            })
          : photo,
      ),
      placeNodes: state.placeNodes.map((item) => ({
        ...item,
        photoIds: item.id === place.id ? Array.from(new Set([...item.photoIds, photoId])) : item.photoIds.filter((id) => id !== photoId),
        pending: item.id === place.id ? false : item.pending,
      })),
    };
    const next = rebuildTrips(patched, new Set([beforeTripId, place.tripId].filter(Boolean)), { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async createPlaceForPhoto(photoId: string, body: { name: string; lat: number; lng: number }) {
    const state = await getMobilePersistedState();
    const photo = state.photos.find((item) => item.id === photoId);
    if (!photo?.tripId) return projectState(state);
    const now = nowIso();
    const point = { lat: Number(body.lat), lng: Number(body.lng) };
    const name = String(body.name ?? "").trim();
    if (!name || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return projectState(state);
    const geo = await manualMobileGeoDescription(point, { makeId });
    const place: PlaceNode = {
      id: makeId("place"),
      tripId: photo.tripId,
      name,
      names: manualPlaceNames(name),
      displayName: name,
      userEdits: { name, updatedAt: now },
      center: point,
      ...geo,
      coordinatePrecision: "estimated",
      photoIds: [photoId],
      timeRange: { start: photo.capturedAt ?? now, end: photo.capturedAt ?? now },
      pending: false,
    };
    const patched = {
      ...state,
      placeNodes: state.placeNodes.map((item) => ({ ...item, photoIds: item.photoIds.filter((id) => id !== photoId) })).concat(place),
      photos: state.photos.map((item) =>
        item.id === photoId
          ? applyManualPlaceAssignment(item, place, {
              now,
              source: "manual_new_place",
              reason: "用户手动新建地点并移动照片。",
              precision: "estimated",
              candidate: manualLocationCandidate({ name, point, geo }),
            })
          : item,
      ),
    };
    const next = rebuildTrips(patched, new Set([photo.tripId]), { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async updatePending(pendingId: string, accepted: boolean) {
    const state = await getMobilePersistedState();
    const pending = state.pendingItems.find((item) => item.id === pendingId);
    const applied = applyPendingDecision(state, pendingId, { accepted }) as MobilePersistedState;
    const next = accepted ? (rebuildTripsForPhotos(applied, new Set(pending?.relatedPhotoIds ?? []), { makeId, allowExistingPlaceMerge: true }) as MobilePersistedState) : applied;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async resolvePendingManually(pendingId: string, body: { action?: string; placeId?: string; name?: string; lat?: number; lng?: number } = {}) {
    const state = await getMobilePersistedState();
    const pending = state.pendingItems.find((item) => item.id === pendingId);
    if (!pending || !["missing_gps", "missing_time", "confirm_location_candidate", "ai_processing_failed"].includes(pending.type)) return projectState(state);
    const photoIds = pending.relatedPhotoIds ?? [];
    if (!photoIds.length) return projectState(state);
    const photos = state.photos.filter((photo) => photoIds.includes(photo.id));
    const primaryPhoto = photos[0];
    const tripId = pending.relatedTripId ?? primaryPhoto?.tripId;
    if (!primaryPhoto || !tripId) return projectState(state);
    const now = nowIso();

    if (body.action === "bind_existing_place") {
      const place = state.placeNodes.find((item) => item.id === body.placeId);
      if (!place) return projectState(state);
      const patched = {
        ...state,
        photos: state.photos.map((photo) =>
          photoIds.includes(photo.id)
            ? applyManualPlaceAssignment(photo, place, {
                now,
                source: "manual_existing_place",
                reason: "用户手动合并到已有地点。",
              })
            : photo,
        ),
        pendingItems: state.pendingItems.map((item) => (item.id === pending.id || item.relatedPhotoIds?.some((photoId) => photoIds.includes(photoId)) ? { ...item, status: "accepted" as const } : item)),
      };
      const next = rebuildTrips(patched, new Set([tripId, place.tripId].filter(Boolean)), { makeId }) as MobilePersistedState;
      await writeMobilePersistedState(next);
      return projectState(next);
    }

    if (body.action === "create_manual_place") {
      const point = { lat: Number(body.lat), lng: Number(body.lng) };
      const name = String(body.name ?? "").trim();
      if (!name || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return projectState(state);
      const geo = await manualMobileGeoDescription(point, { makeId });
      const dates = photos.map((photo) => photo.capturedAt).filter(Boolean).sort();
      const place: PlaceNode = {
        id: makeId("manual-place"),
        tripId,
        name,
        names: manualPlaceNames(name),
        displayName: name,
        userEdits: { name, updatedAt: now },
        center: point,
        ...geo,
        coordinatePrecision: "estimated",
        photoIds,
        timeRange: { start: dates[0] ?? now, end: dates[dates.length - 1] ?? dates[0] ?? now },
        pending: false,
      };
      const patched = {
        ...state,
        placeNodes: [...state.placeNodes, place],
        photos: state.photos.map((photo) =>
          photoIds.includes(photo.id)
            ? applyManualPlaceAssignment(photo, place, {
                now,
                source: "manual_new_place",
                reason: "用户手动新建地点。",
                precision: "estimated",
                candidate: manualLocationCandidate({ name, point, geo }),
              })
            : photo,
        ),
        pendingItems: state.pendingItems.map((item) => (item.id === pending.id || item.relatedPhotoIds?.some((photoId) => photoIds.includes(photoId)) ? { ...item, status: "accepted" as const } : item)),
      };
      const next = rebuildTrips(patched, new Set([tripId]), { makeId }) as MobilePersistedState;
      await writeMobilePersistedState(next);
      return projectState(next);
    }

    if (body.action === "archive_unlocated") {
      const patched = {
        ...state,
        photos: state.photos.map((photo) =>
          photoIds.includes(photo.id)
            ? {
                ...photo,
                placeNodeId: undefined,
                location: undefined,
                aiFailure: undefined,
                pendingReason: undefined,
                exifStatus: clearManualExifStatus(photo, { gps: "missing" }),
                locationResolution: {
                  ...(photo.locationResolution ?? {}),
                  status: "rejected",
                  effectiveName: undefined,
                  effectivePoint: undefined,
                  confidence: undefined,
                  source: "manual_archived_unlocated",
                  candidates: photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [],
                  requiresUserAction: false,
                  updatedAt: now,
                },
              }
            : photo,
        ),
        pendingItems: state.pendingItems.map((item) => (item.id === pending.id || item.relatedPhotoIds?.some((photoId) => photoIds.includes(photoId)) ? { ...item, status: "accepted" as const } : item)),
      };
      const next = rebuildTripsForPhotos(patched, new Set(photoIds), { makeId }) as MobilePersistedState;
      await writeMobilePersistedState(next);
      return projectState(next);
    }

    return projectState(state);
  },
  async search(query: string, filters?: { tripId?: string; placeId?: string; date?: string; tag?: string; fileName?: string }) {
    const state = await projectState(await getMobilePersistedState());
    return searchMobilePhotos({ state, query, filters, embedTextQuery: embedMobileTextQuery });
  },
};

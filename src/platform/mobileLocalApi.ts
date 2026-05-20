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
import { rebuildTrips } from "../../shared/domain/trip-rebuilder.mjs";
import {
  bindPhotoState,
  createPlaceForPhotoState,
  createPlaceState,
  createTripState,
  deletePhotoState,
  deletePlaceState,
  deleteTripState,
  movePhotoState,
  patchPhotoState,
  patchPlaceState,
  patchTripState,
  reorderPlacesState,
  resolvePendingManuallyState,
  updatePendingState,
} from "../../shared/domain/edit-state-core.mjs";
import {
  appendMissingInfoPendingIfNeeded as appendMissingInfoPendingIfNeededCore,
  buildImportStateFromPhotos,
  cancelImportPhotosState,
  confirmImportState,
  mergeImportTripsState,
  rollbackImportState,
} from "../../shared/import/import-state-core.mjs";
import {
  applyAiFailurePatch,
  applyEmbeddingFields,
  buildEmbeddingRebuildReport,
  buildRetryAiFailure,
  clearAiFailureForPhoto,
  embeddingRebuildFailure,
  embeddingRebuildSucceeded,
  failureReasonText,
  mergeRebuiltPhotosState,
  patchVectorIndexForEmbedding,
  pendingReasonFromExif,
  withImportExifStatus,
} from "../../shared/import/import-photo-core.mjs";
import { allowedInferencePlaces, applyMissingInfoProposalState, buildInferenceContextPhotos, buildMissingInfoInferenceInput, keepPending, missingInferenceText, normalizeMissingInfoAiProposal } from "../../shared/import/missing-info-inference-core.mjs";
import type {
  GeoPoint,
  ImportBatch,
  LocationCandidate,
  Photo,
} from "@/domain/models";

type MobileImportJob = ImportJob;

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  return withImportExifStatus(photo, { hasExifTime, hasExifLocation }) as Photo;
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

function appendMissingInfoPendingIfNeeded(state: MobilePersistedState, batch: ImportBatch, photo: Photo): MobilePersistedState {
  return appendMissingInfoPendingIfNeededCore(state, batch, photo, { makeId }) as MobilePersistedState;
}

function rebuildTripsForImportedPhoto(state: MobilePersistedState, photo: Photo, batch: ImportBatch, options = {}) {
  const affectedTripIds = new Set([photo.tripId, ...batch.createdTripIds, ...(batch.updatedTripIds ?? [])].filter(Boolean));
  return rebuildTrips(state, affectedTripIds, { makeId, ...options }) as MobilePersistedState;
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
    const failed: EmbeddingRebuildReport["failures"] = [];
    const succeeded: string[] = [];
    let done = 0;
    const pipelineConfig = importPipelineConfig();
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "embedding");
    jobProgress.update({ phase: "embedding", done, total, steps: { embedding: { done, total } } });
    const rebuiltPhotos = (await mapConcurrent(targets, pipelineConfig.concurrency.embedding, async (photo: Photo): Promise<Photo> => {
      let embedding: MobileEmbeddingResult | undefined;
      try {
        const dataUrl = await mobileAiImageDataUrlForPhoto(photo);
        embedding = await embedMobileImage({ dataUrl, fileName: photo.fileName });
      } catch (error) {
        embedding = {
          embeddingMode: "failed" as const,
          embeddingFallbackReason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        done += 1;
        jobProgress.update({ phase: done < total ? "embedding" : "completed", done, total, steps: { embedding: { done, total } }, currentFileName: photo.fileName });
      }
      const fallbackReason = "Android embedding profile is disabled or missing API key.";
      if (embeddingRebuildSucceeded(embedding)) succeeded.push(photo.id);
      else failed.push(embeddingRebuildFailure(photo, embedding, embedding?.embeddingFallbackReason ?? fallbackReason));
      patchVectorIndexForEmbedding(vectorIndex, photo.id, embedding);
      return applyEmbeddingFields(photo, embedding, { fallbackMode: "disabled", fallbackReason }) as Photo;
    })) as Photo[];
    const next = mergeRebuiltPhotosState(state, rebuiltPhotos) as MobilePersistedState;
    await writeMobilePersistedState(next);
    await writeNativeVectorIndex(vectorIndex).catch(() => false);
    const snapshot = await projectState(next);
    const result = {
      ...snapshot,
      embeddingRebuild: buildEmbeddingRebuildReport({ total, succeeded, failed, mode: photoIds?.length ? "retry_failed" : "all" }) satisfies EmbeddingRebuildReport,
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
      photo = applyAiFailurePatch(photo, embedding, { now: nowIso }) as Photo;
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
          photo = applyAiFailurePatch(photo, embedding, { now: nowIso }) as Photo;
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
    const next = confirmImportState(state, batchId) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async rollbackImport(batchId: string) {
    const state = await getMobilePersistedState();
    const result = rollbackImportState(state, batchId, { makeId });
    const next = result.state as MobilePersistedState;
    await writeMobilePersistedState(next);
    deleteMobileThumbnailsForPhotos(result.removedPhotos);
    await releaseNativePhotoPermissions(sourceUrisForPhotos(result.removedPhotos)).catch(() => undefined);
    await deleteNativeVectors(result.removedPhotoIds).catch(() => false);
    return projectState(next);
  },
  async cancelImportPhotos(batchId: string, photoIds: string[]) {
    const state = await getMobilePersistedState();
    const result = cancelImportPhotosState(state, batchId, photoIds, { makeId });
    if (!result.canceledPhotos.length) return projectState(state);
    const next = result.state as MobilePersistedState;
    await writeMobilePersistedState(next);
    deleteMobileThumbnailsForPhotos(result.canceledPhotos);
    await releaseNativePhotoPermissions(sourceUrisForPhotos(result.canceledPhotos)).catch(() => undefined);
    await deleteNativeVectors(result.canceledPhotoIds).catch(() => false);
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
    const next = applyMissingInfoProposalState(state, _batchId, pending.id, proposal, { now: nowIso }) as MobilePersistedState;
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
    const retryVision = action === "retry_vision" || action === "retry_both";
    const retryEmbedding = action === "retry_embedding" || action === "retry_both";
    const nextFailure = buildRetryAiFailure(photo, {
      retryVision,
      retryEmbedding,
      ai: { fallbackReason: patched.aiFallbackReason },
      embedding,
      now: nowIso,
    });
    const failed = Boolean(nextFailure);
    const pendingReason = failed ? "ai_processing_failed" : pendingReasonFromExif(patched);
    patched = {
      ...patched,
      aiFailure: nextFailure,
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
    const next = mergeImportTripsState(state, batchId) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async createTrip(title: string, start: string, end: string) {
    const state = await getMobilePersistedState();
    const next = createTripState(state, { title, start, end }, { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async updateTrip(tripId: string, body: { title?: string; dateRange?: { start: string; end: string } }) {
    const state = await getMobilePersistedState();
    const next = patchTripState(state, tripId, body) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async deleteTrip(tripId: string) {
    const state = await getMobilePersistedState();
    const result = deleteTripState(state, tripId);
    const next = result.state as MobilePersistedState;
    await writeMobilePersistedState(next);
    deleteMobileThumbnailsForPhotos(result.removedPhotos);
    void releaseNativePhotoPermissions(sourceUrisForPhotos(result.removedPhotos));
    void deleteNativeVectors(result.removedPhotoIds);
    return projectState(next);
  },
  async createPlace(body: { tripId: string; name: string; lat: number; lng: number }) {
    const state = await getMobilePersistedState();
    const now = nowIso();
    const center = { lat: Number(body.lat), lng: Number(body.lng) };
    const geo = await manualMobileGeoDescription(center, { makeId });
    const next = createPlaceState(state, body, { makeId, now, geo }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async updatePlace(placeId: string, body: { name?: string }) {
    const state = await getMobilePersistedState();
    const now = nowIso();
    const next = patchPlaceState(state, placeId, body, { now }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async deletePlace(placeId: string) {
    const state = await getMobilePersistedState();
    const next = deletePlaceState(state, placeId) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async reorderPlaces(tripId: string, body: { placeIds?: string[] } | string[]) {
    const state = await getMobilePersistedState();
    const next = reorderPlacesState(state, tripId, body) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async movePhoto(photoId: string, body: { tripId?: string }) {
    const state = await getMobilePersistedState();
    const next = movePhotoState(state, photoId, body, { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async deletePhoto(photoId: string) {
    const state = await getMobilePersistedState();
    const result = deletePhotoState(state, photoId, { makeId });
    const next = result.state as MobilePersistedState;
    await writeMobilePersistedState(next);
    deleteMobileThumbnailsForPhotos(result.removedPhotos);
    void releaseNativePhotoPermissions(sourceUrisForPhotos(result.removedPhotos));
    void deleteNativeVectors(result.removedPhotoIds);
    return projectState(next);
  },
  async updatePhoto(photoId: string, body: { capturedAt?: string; location?: GeoPoint; tags?: string[]; userEdits?: { title?: string; caption?: string; tags?: string[] } }) {
    const state = await getMobilePersistedState();
    const next = patchPhotoState(state, photoId, body, { makeId, now: nowIso() }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async bindPhoto(photoId: string, placeId?: string) {
    const state = await getMobilePersistedState();
    const next = bindPhotoState(state, photoId, placeId, { makeId, now: nowIso() }) as MobilePersistedState;
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
    if (!name) throw new Error("请输入地点名。");
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) throw new Error("请输入有效经纬度。");
    const geo = await manualMobileGeoDescription(point, { makeId });
    const next = createPlaceForPhotoState(state, photoId, body, { makeId, now, geo }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async updatePending(pendingId: string, accepted: boolean) {
    const state = await getMobilePersistedState();
    const next = updatePendingState(state, pendingId, { accepted }, { makeId }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async resolvePendingManually(pendingId: string, body: { action?: string; placeId?: string; name?: string; lat?: number; lng?: number } = {}) {
    const state = await getMobilePersistedState();
    const next = (await resolvePendingManuallyState(state, pendingId, body, {
      makeId,
      now: nowIso(),
      geoForPoint: (point: GeoPoint) => manualMobileGeoDescription(point, { makeId }),
    })) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async search(query: string, filters?: { tripId?: string; placeId?: string; date?: string; tag?: string; fileName?: string }) {
    const state = await projectState(await getMobilePersistedState());
    return searchMobilePhotos({ state, query, filters, embedTextQuery: embedMobileTextQuery });
  },
};

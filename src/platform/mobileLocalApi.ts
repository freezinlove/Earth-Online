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
import { createImageDataUrl, createImageDataUrls, hashBuffer, parseExif, sourceUrisForPhotos } from "@/platform/mobileMedia";
import { emptyCredential, readMobileAiSettings, updateMobileAiSettings, type MobileAiSettingsUpdateBody } from "@/platform/mobileAiSettings";
import { analyzeMobilePhoto, embedMobileImage, embedMobileTextQuery, inferMobileMissingInfoWithImage, type MobileEmbeddingResult, type MobilePhotoAnalysis } from "@/platform/mobileAiRuntime";
import { geocodeMobileAiCandidate, manualMobileGeoDescription, projectMobileState as projectState, reverseMobileCandidates } from "@/platform/mobileGeodata";
import { searchMobilePhotos } from "@/platform/mobileSearch";
import { importPipelineConfig, mapConcurrent } from "../../shared/application/import-pipeline.mjs";
import { createJobProgressRecorder as createSharedJobProgressRecorder } from "../../shared/application/job-core.mjs";
import { isUsableLocation } from "../../shared/domain/geo.mjs";
import { mergeLocationCandidates, resolveImportedLocation } from "../../shared/domain/location-resolver.mjs";
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
  cancelImportPhotosState,
  confirmImportState,
  mergeImportTripsState,
  rollbackImportState,
} from "../../shared/import/import-state-core.mjs";
import {
  applyEmbeddingFields,
  buildEmbeddingRebuildReport,
  clearAiFailureForPhoto,
  embeddingRebuildFailure,
  embeddingRebuildSucceeded,
  failureReasonText,
  mergeRebuiltPhotosState,
  patchVectorIndexForEmbedding,
} from "../../shared/import/import-photo-core.mjs";
import { allowedInferencePlaces, applyMissingInfoProposalState, buildInferenceContextPhotos, buildMissingInfoInferenceInput, keepPending, missingInferenceText, normalizeMissingInfoAiProposal } from "../../shared/import/missing-info-inference-core.mjs";
import {
  buildRetryImportAiFailureResultCore,
  createImportAiStats,
  recordImportEmbeddingStats,
  runImportAiFailuresBatchCore,
  runInitialImportPipeline,
  runMissingInferenceBatchCore,
} from "../../shared/import/import-orchestrator-core.mjs";
import type {
  GeoPoint,
  ImportBatch,
  LocationCandidate,
  PendingItem,
  Photo,
} from "@/domain/models";

type MobileImportJob = ImportJob;
type MobilePreparedFile = {
  file: File;
  fileName: string;
  mime: string;
  ext: string;
  originalHash: string;
  location?: GeoPoint;
  capturedAt?: string;
};
type MobilePreparedAsset = NativePhotoAsset & {
  mime: string;
  ext: string;
  originalHash: string;
  location?: GeoPoint;
};
type MobileImportPhotoJob = {
  photoId: string;
  fileName: string;
  originalHash: string;
  mime: string;
  batchId: string;
  capturedAt?: string;
  location?: GeoPoint;
  hasExifTime: boolean;
  hasExifLocation: boolean;
};
type MobileBuildImportedInput = Omit<Parameters<typeof buildMobileImportedPhoto>[0], "sourceProvider">;

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

async function mobileAiImageDataUrlFromSource(source: File | string | undefined, mime = "image/jpeg") {
  if (!source) return undefined;
  const pipelineConfig = importPipelineConfig();
  return createImageDataUrl(source, pipelineConfig.images.aiImageMaxDimension, pipelineConfig.images.aiImageJpegQuality, mime).catch(() => undefined);
}

async function processMobileImageDerivativesFromSource(
  source: File | string | undefined,
  mime = "image/jpeg",
  { needThumbnail = true, onAiInputReady }: { needThumbnail?: boolean; onAiInputReady?: (payload?: { dataUrl?: string; url?: string; mime?: string }) => void } = {},
) {
  if (!source) {
    onAiInputReady?.(undefined);
    return { aiImagePayload: undefined, thumbnail: { dataUrl: "", displayUrl: undefined } };
  }
  const pipelineConfig = importPipelineConfig();
  const variants = [
    { key: "aiInput", maxDimension: pipelineConfig.images.aiImageMaxDimension, jpegQuality: pipelineConfig.images.aiImageJpegQuality },
    ...(needThumbnail
      ? [
          { key: "thumbnail", maxDimension: pipelineConfig.images.thumbnailMaxDimension, jpegQuality: pipelineConfig.images.thumbnailJpegQuality },
          { key: "display", maxDimension: pipelineConfig.images.displayImageMaxDimension, jpegQuality: pipelineConfig.images.displayImageJpegQuality },
        ]
      : []),
  ];
  let aiReadyEmitted = false;
  const emitAiReady = (payload?: { dataUrl?: string; url?: string; mime?: string }) => {
    if (aiReadyEmitted) return;
    aiReadyEmitted = true;
    onAiInputReady?.(payload);
  };
  const dataUrls = await createImageDataUrls(source, variants, mime, (key, dataUrl) => {
    if (key === "aiInput") emitAiReady(dataUrl ? { dataUrl, url: dataUrl, mime: "image/jpeg" } : undefined);
  }).catch(() => ({} as Record<string, string>));
  const aiImagePayload = dataUrls.aiInput ? { dataUrl: dataUrls.aiInput, url: dataUrls.aiInput, mime: "image/jpeg" } : undefined;
  emitAiReady(aiImagePayload);
  return {
    aiImagePayload,
    thumbnail: needThumbnail
      ? {
          dataUrl: dataUrls.thumbnail || "",
          displayUrl: dataUrls.display || undefined,
        }
      : undefined,
  };
}

async function mobileAiImageDataUrlForPhoto(photo: Photo) {
  if (photo.aiInputUrl?.startsWith("data:")) return photo.aiInputUrl;
  return mobileAiImageDataUrlFromSource(photo.aiInputUrl || photo.sourceWebPath || photo.storageUrl || photo.thumbnailUrl, photo.mime ?? "image/jpeg");
}

function mobileImportProgressPayload({
  phase,
  done,
  total,
  currentFileName,
  counters,
}: {
  phase: ImportJobProgress["phase"];
  done: number;
  total: number;
  currentFileName?: string;
  counters: Record<"reading" | "exif" | "thumbnails" | "ai" | "embedding", number>;
}): ImportJobProgress {
  return {
    phase,
    done,
    total,
    currentFileName,
    steps: {
      reading: { done: counters.reading, total },
      exif: { done: counters.exif, total },
      thumbnails: { done: counters.thumbnails, total },
      ai: { done: counters.ai, total },
      embedding: { done: counters.embedding, total },
    },
  };
}

async function withMobileLocationCandidates({ location, aiEvidence, locale }: { location?: GeoPoint; aiEvidence: NonNullable<Photo["ai"]>; locale: "zh" | "en" }) {
  const aiCandidates = await Promise.all((aiEvidence?.locationCandidates ?? []).map((candidate: LocationCandidate) => geocodeMobileAiCandidate(candidate, { makeId, locale })));
  const backendCandidates = location ? await reverseMobileCandidates(location, { makeId }) : [];
  return {
    ...aiEvidence,
    locationCandidates: mergeLocationCandidates(backendCandidates, aiCandidates),
  };
}

async function analyzeMobileVisionForImport({
  fileName,
  mime,
  dataUrl,
  preset,
  location,
  allowCloud,
  locale,
}: {
  fileName: string;
  mime?: string;
  dataUrl?: string;
  preset: string;
  location?: GeoPoint;
  allowCloud: boolean;
  locale: "zh" | "en";
}) {
  return analyzeMobilePhoto({ fileName, mime: mime ?? "image/jpeg", dataUrl, preset, location, allowCloud, locale });
}

async function embedMobileImageForImport({ dataUrl, fileName, allowCloud }: { dataUrl?: string; fileName: string; allowCloud?: boolean }) {
  return embedMobileImage({ dataUrl, fileName, allowCloud }).catch((error) => ({
    embeddingMode: "failed" as const,
    embeddingFallbackReason: error instanceof Error ? error.message : String(error),
  }) satisfies MobileEmbeddingResult);
}

function mobileFileExt(fileName: string, mime = "image/jpeg") {
  const match = fileName.match(/\.[^.]+$/);
  if (match) return match[0];
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("heic")) return ".heic";
  return ".jpg";
}

function buildMobileImportedPhoto({
  job,
  prepared,
  thumbnail,
  aiImagePayload,
  ai,
  embedding,
  aiFailure,
  aiEvidence,
  photoPendingReason,
  sourceProvider,
}: {
  job: MobileImportPhotoJob;
  prepared: MobilePreparedFile | MobilePreparedAsset;
  thumbnail: { dataUrl?: string; displayUrl?: string };
  aiImagePayload?: { dataUrl?: string; url?: string };
  ai: MobilePhotoAnalysis;
  embedding?: MobileEmbeddingResult;
  aiFailure: Photo["aiFailure"];
  aiEvidence: Photo["ai"];
  photoPendingReason?: Photo["pendingReason"];
  sourceProvider: "file_input" | "android_photo_picker";
}): Photo {
  const titleBase = job.fileName.replace(/\.[^.]+$/, "");
  const locationResolution = resolveImportedLocation({ location: job.location, aiEvidence, pendingReason: photoPendingReason });
  const nativePrepared = sourceProvider === "android_photo_picker" ? (prepared as MobilePreparedAsset) : undefined;
  return {
    id: job.photoId,
    fileName: job.fileName,
    title: ai.title || titleBase,
    originalHash: job.originalHash,
    mime: job.mime,
    thumbnailUrl: thumbnail.dataUrl || nativePrepared?.thumbnailDataUrl || nativePrepared?.webPath || "",
    aiInputUrl: aiImagePayload?.url ?? aiImagePayload?.dataUrl,
    displayUrl: thumbnail.displayUrl,
    storageUrl: nativePrepared && nativePrepared.persisted !== false ? nativePrepared.webPath ?? nativePrepared.uri : undefined,
    sourceUri: nativePrepared && nativePrepared.persisted !== false ? nativePrepared.uri : undefined,
    sourceWebPath: nativePrepared && nativePrepared.persisted !== false ? nativePrepared.webPath : undefined,
    sourceProvider,
    capturedAt: job.capturedAt,
    location: job.location,
    tags: nativePrepared?.persisted === false ? [...ai.tags, "原图授权未持久化"] : ai.tags,
    aiCaption: ai.caption,
    ai: aiEvidence,
    locationResolution,
    aiProvider: ai.provider,
    aiModel: ai.model,
    aiFallbackReason: ai.fallbackReason,
    embeddingProvider: embedding?.embeddingProvider,
    embeddingModel: embedding?.embeddingModel,
    embeddingSpaceId: embedding?.embeddingSpaceId,
    embeddingDimension: embedding?.embeddingDimension ?? embedding?.embedding?.length,
    embeddingMode: embedding?.embeddingMode,
    embeddingFallbackReason: embedding?.embeddingFallbackReason,
    aiFailure,
    importedBatchId: job.batchId,
    pendingReason: photoPendingReason,
    exifStatus: {
      time: job.hasExifTime ? "read" : "fallback",
      gps: job.hasExifLocation ? "read" : "missing",
    },
  };
}

async function buildMobileMissingInfoInferenceProposal(state: MobilePersistedState, batch: ImportBatch, pending: PendingItem, { locale = "zh" as "zh" | "en" } = {}) {
  const photo = state.photos.find((item) => pending.relatedPhotoIds?.includes(item.id));
  if (!photo) return keepPending(missingInferenceText(locale, "photoNotFound"), 0.2, locale);
  const context = buildInferenceContextPhotos(state, batch, photo);
  const contextPlaces = allowedInferencePlaces(state, context);
  const dataUrl = await mobileAiImageDataUrlForPhoto(photo);
  if (!dataUrl) return keepPending(missingInferenceText(locale, "imageMissing"), 0, locale);
  const inferenceInput = buildMissingInfoInferenceInput({ photo, context, contextPlaces, locale });
  let aiResult = await inferMobileMissingInfoWithImage({ dataUrl, mime: photo.mime ?? "image/jpeg", inferenceInput, locale });
  if (aiResult.action === "create_place_from_candidate") {
    aiResult = { ...aiResult, candidate: await geocodeMobileAiCandidate(aiResult.candidate as LocationCandidate, { makeId, locale }) };
  } else if (aiResult.action === "keep_pending" && aiResult.candidate?.name) {
    aiResult = { ...aiResult, candidate: await geocodeMobileAiCandidate(aiResult.candidate as LocationCandidate, { makeId, locale }) };
  }
  return normalizeMissingInfoAiProposal({
    aiResult,
    photo,
    context,
    contextPlaces,
    locale,
    completeCandidatePoint: (candidate: LocationCandidate) => candidate,
  });
}

async function buildMobileRetryImportAiFailureResult(_state: MobilePersistedState, _batch: ImportBatch, _pending: PendingItem, photo: Photo, action: string, { locale = "zh" as "zh" | "en" } = {}) {
  return buildRetryImportAiFailureResultCore({
    photo,
    action,
    locale,
    makeId,
    readPhotoImagePayload: async (target: Photo) => {
      const dataUrl = await mobileAiImageDataUrlForPhoto(target);
      return dataUrl ? { dataUrl, mime: target.mime ?? "image/jpeg" } : undefined;
    },
    analyzeVision: analyzeMobileVisionForImport,
    embedImage: embedMobileImageForImport,
    withLocationCandidates: withMobileLocationCandidates,
  });
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
      aiInputDir: "Android IndexedDB AI input images",
      dataDir: "Android private app storage",
      dbPath: "Android private SQLite: earth-online.sqlite",
      displayDir: "Android IndexedDB display images",
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
    const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
    const pipelineConfig = importPipelineConfig();
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "reading");
    onProgress?.(0, total);
    jobProgress.update(mobileImportProgressPayload({ phase: "reading", done: 0, total, counters: { reading: 0, exif: 0, thumbnails: 0, ai: 0, embedding: 0 } }));
    const result = await runInitialImportPipeline({
      items: files,
      state,
      vectorIndex,
      now: new Date(),
      locale: _locale,
      makeId,
      allowCloud: _allowCloudAi !== false,
      concurrency: pipelineConfig.concurrency,
      progress: { update: (progress: ImportJobProgress) => jobProgress.update(progress) },
      adapter: {
        initialPhases: ["reading", "exif", "thumbnails", "ai", "embedding"],
        progress: mobileImportProgressPayload,
        itemFileName: (file: File, index: number) => file.name || `photo-${index + 1}`,
        createAiStats: createImportAiStats,
        async prepareItem(file: File, index: number) {
          const buffer = await file.arrayBuffer();
          const originalHash = (await hashBuffer(buffer)) ?? `${file.name}-${file.size}-${file.lastModified}-${index}`;
          const exif = parseExif(buffer);
          return {
            file,
            fileName: file.name || `photo-${index + 1}`,
            mime: file.type || "image/jpeg",
            ext: mobileFileExt(file.name, file.type),
            originalHash,
            location: exif.location,
            capturedAt: exif.capturedAt,
          };
        },
        capturedAt: (prepared: MobilePreparedFile) => prepared.capturedAt ?? (prepared.file.lastModified ? new Date(prepared.file.lastModified).toISOString() : nowIso()),
        processImageDerivatives: (prepared: MobilePreparedFile, _job: MobileImportPhotoJob, options?: { needThumbnail?: boolean; onAiInputReady?: (payload?: { dataUrl?: string; url?: string; mime?: string }) => void }) =>
          processMobileImageDerivativesFromSource(prepared.file, prepared.mime, options),
        analyzeVision: analyzeMobileVisionForImport,
        embedImage: embedMobileImageForImport,
        recordEmbeddingStats: recordImportEmbeddingStats,
        withLocationCandidates: withMobileLocationCandidates,
        buildNewPhoto: (input: MobileBuildImportedInput) => buildMobileImportedPhoto({ ...input, sourceProvider: "file_input" }),
        duplicateCount: ({ duplicatePhotoIds }: { duplicatePhotoIds: Set<string> }) => duplicatePhotoIds.size,
      },
    });
    await writeMobilePersistedState(result.state as MobilePersistedState);
    await writeNativeVectorIndex(result.vectorIndex).catch(() => false);
    jobProgress.update(mobileImportProgressPayload({ phase: "completed", done: total, total, counters: { reading: total, exif: total, thumbnails: total, ai: total, embedding: total } }));
    const snapshot = await projectState(result.state as MobilePersistedState);
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
    const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
    const pipelineConfig = importPipelineConfig();
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "reading");
    onProgress?.(0, total);
    jobProgress.update(mobileImportProgressPayload({ phase: "reading", done: 0, total, counters: { reading: 0, exif: 0, thumbnails: 0, ai: 0, embedding: 0 } }));
    const result = await runInitialImportPipeline({
      items: assets,
      state,
      vectorIndex,
      now: new Date(),
      locale: _locale,
      makeId,
      allowCloud: _allowCloudAi !== false,
      concurrency: pipelineConfig.concurrency,
      progress: { update: (progress: ImportJobProgress) => jobProgress.update(progress) },
      adapter: {
        initialPhases: ["reading", "exif", "thumbnails", "ai", "embedding"],
        progress: mobileImportProgressPayload,
        skipPrepareErrors: true,
        itemFileName: (asset: NativePhotoAsset, index: number) => asset.fileName || `photo-${index + 1}`,
        createAiStats: createImportAiStats,
        async prepareItem(asset: NativePhotoAsset) {
          const prepared = await prepareNativePhotoAsset(asset);
          const nativeLocation = typeof prepared.latitude === "number" && typeof prepared.longitude === "number" ? { lat: prepared.latitude, lng: prepared.longitude } : undefined;
          let parsedExif: ReturnType<typeof parseExif> = {};
          let fallbackHash: string | undefined;
          if (!prepared.sha256 && prepared.webPath) {
            const buffer = await fetch(prepared.webPath)
              .then((response) => response.arrayBuffer())
              .catch(() => undefined);
            parsedExif = buffer ? parseExif(buffer) : {};
            fallbackHash = buffer ? await hashBuffer(buffer).catch(() => undefined) : undefined;
          }
          const exifLocation = isUsableLocation(nativeLocation) ? nativeLocation : parsedExif.location;
          const capturedAt = prepared.capturedAt ?? parsedExif.capturedAt;
          const originalHash = prepared.sha256 ?? fallbackHash ?? prepared.uri;
          return {
            ...prepared,
            fileName: prepared.fileName,
            mime: prepared.mimeType,
            ext: mobileFileExt(prepared.fileName, prepared.mimeType),
            originalHash,
            location: exifLocation,
            capturedAt,
            sha256: originalHash,
            latitude: exifLocation?.lat,
            longitude: exifLocation?.lng,
          };
        },
        onPrepareError: (error: unknown) => console.error(error),
        onDuplicateComplete: (prepared: MobilePreparedAsset, duplicatePhoto?: Photo) => {
          const existingSources = new Set([duplicatePhoto?.sourceUri, duplicatePhoto?.sourceWebPath, duplicatePhoto?.storageUrl].filter(Boolean));
          if (existingSources.has(prepared.uri) || (prepared.webPath && existingSources.has(prepared.webPath))) return;
          releaseNativePhotoPermissions([prepared.uri]).catch(() => undefined);
        },
        capturedAt: (prepared: MobilePreparedAsset) => prepared.capturedAt ?? nowIso(),
        processImageDerivatives: (prepared: MobilePreparedAsset, _job: MobileImportPhotoJob, options?: { needThumbnail?: boolean; onAiInputReady?: (payload?: { dataUrl?: string; url?: string; mime?: string }) => void }) =>
          processMobileImageDerivativesFromSource(prepared.webPath, prepared.mime, options),
        analyzeVision: analyzeMobileVisionForImport,
        embedImage: embedMobileImageForImport,
        recordEmbeddingStats: recordImportEmbeddingStats,
        withLocationCandidates: withMobileLocationCandidates,
        buildNewPhoto: (input: MobileBuildImportedInput) => buildMobileImportedPhoto({ ...input, sourceProvider: "android_photo_picker" }),
        duplicateCount: ({ duplicatePhotoIds }: { duplicatePhotoIds: Set<string> }) => duplicatePhotoIds.size,
      },
    });
    await writeMobilePersistedState(result.state as MobilePersistedState);
    await writeNativeVectorIndex(result.vectorIndex).catch(() => false);
    jobProgress.update(mobileImportProgressPayload({ phase: "completed", done: total, total, counters: { reading: total, exif: total, thumbnails: total, ai: total, embedding: total } }));
    const snapshot = await projectState(result.state as MobilePersistedState);
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
    let proposal;
    try {
      proposal = await buildMobileMissingInfoInferenceProposal(state, batch, pending, { locale });
    } catch (error) {
      proposal = keepPending(error instanceof Error ? error.message : missingInferenceText(locale, "secondInferenceFailed"), 0, locale);
    }
    const next = applyMissingInfoProposalState(state, _batchId, pending.id, proposal, { now: nowIso }) as MobilePersistedState;
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async inferPendingLocations(batchId: string, pendingIds: string[], locale: "zh" | "en" = "zh", onJobProgress?: (progress: ImportJobProgress) => void) {
    const state = await getMobilePersistedState();
    const total = pendingIds.length;
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "ai");
    const result = await runMissingInferenceBatchCore({
      state,
      batchId,
      pendingIds,
      locale,
      concurrency: importPipelineConfig().concurrency.missingInference,
      progress: { update: (progress: ImportJobProgress) => jobProgress.update(progress) },
      buildProposal: buildMobileMissingInfoInferenceProposal,
      now: nowIso,
      emitCompleted: false,
    });
    await writeMobilePersistedState(result.state as MobilePersistedState);
    jobProgress.update({ phase: "completed", done: result.total, total: result.total });
    const snapshot = await projectState(result.state as MobilePersistedState);
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

    const retry = await buildMobileRetryImportAiFailureResult(state, batch, pending, photo, action, { locale });
    const patched = retry.patchedPhoto as Photo;
    const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
    if (retry.retryEmbedding && Array.isArray(retry.embedding.embedding)) vectorIndex[patched.id] = retry.embedding.embedding;
    else if (retry.retryEmbedding) delete vectorIndex[patched.id];
    await writeNativeVectorIndex(vectorIndex).catch(() => false);
    const base = {
      ...state,
      photos: state.photos.map((item) => (item.id === patched.id ? patched : item)),
      pendingItems: state.pendingItems.map((item) =>
        item.id === pending.id
          ? retry.failed
            ? { ...item, reason: failureReasonText(patched) || item.reason, suggestion: `${patched.title ?? patched.fileName} 初次导入 AI 仍处理失败，需要重新选择处理方式。` }
            : { ...item, status: "accepted" as const }
          : item,
      ),
    };
    const withPending = retry.failed ? base : appendMissingInfoPendingIfNeeded(base, batch, patched);
    const next = rebuildTripsForImportedPhoto(withPending, patched, batch, { allowExistingPlaceMerge: true });
    await writeMobilePersistedState(next);
    return projectState(next);
  },
  async resolveImportAiFailures(batchId: string, pendingIds: string[], action: string = "retry_both", locale: "zh" | "en" = "zh", onJobProgress?: (progress: ImportJobProgress) => void) {
    const state = await getMobilePersistedState();
    const total = pendingIds.length;
    const jobProgress = mobileJobProgressRecorder(onJobProgress, total, "ai");
    const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
    const result = await runImportAiFailuresBatchCore({
      state,
      vectorIndex,
      batchId,
      pendingIds,
      action,
      locale,
      concurrency: importPipelineConfig().concurrency.ai,
      progress: { update: (progress: ImportJobProgress) => jobProgress.update(progress) },
      buildRetryResult: buildMobileRetryImportAiFailureResult,
      appendMissingInfoPendingIfNeeded,
      makeId,
      emitCompleted: false,
    });
    await writeMobilePersistedState(result.state as MobilePersistedState);
    await writeNativeVectorIndex(result.vectorIndex).catch(() => false);
    jobProgress.update({ phase: "completed", done: result.total, total: result.total });
    const snapshot = await projectState(result.state as MobilePersistedState);
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

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { safeArray } from "../domain/arrays.mjs";
import { parseExif } from "../domain/exif-parser.mjs";
import { geoContextFor, isUsableLocation, normalizeLocale } from "../domain/geo.mjs";
import { forwardLocalGeocode, reverseLocalGeocode } from "../domain/local-geocoder.mjs";
import { mergeLocationCandidates, resolveImportedLocation, toAiEvidence } from "../domain/location-resolver.mjs";
import { isWeakPlaceName } from "../domain/place-name-selector.mjs";
import { makePhotoTitle } from "../domain/text-normalizer.mjs";
import { rebuildTrips } from "../domain/trip-rebuilder.mjs";
import { readMultipartFormDataToDir } from "../http/body.mjs";
import { extFromName, hashBuffer } from "../storage/file-storage.mjs";
import { importPipelineConfig, mapConcurrent } from "../../shared/application/import-pipeline.mjs";
import {
  appendMissingInfoPendingIfNeeded as appendMissingInfoPendingIfNeededCore,
  cancelImportPhotosState,
  confirmImportState,
  mergeImportTripsState,
  rollbackImportState,
} from "../../shared/import/import-state-core.mjs";
import {
  applyMissingInfoProposalResultsState,
  applyMissingInfoProposalState,
  allowedInferencePlaces,
  buildInferenceContextPhotos,
  buildMissingInfoInferenceInput,
  keepPending,
  missingInferenceText,
  normalizeMissingInfoAiProposal,
} from "../../shared/import/missing-info-inference-core.mjs";
import {
  buildEmbeddingRebuildReport,
  clearAiFailureForPhoto as clearAiFailureForPhotoCore,
  applyEmbeddingFields,
  embeddingRebuildFailure,
  embeddingRebuildSucceeded,
  failureReasonText,
  mergeRebuiltPhotosState,
  patchVectorIndexForEmbedding,
} from "../../shared/import/import-photo-core.mjs";
import {
  applyImportAiFailureRetryResultsCore,
  buildRetryImportAiFailureResultCore,
  createImportAiStats,
  recordImportEmbeddingStats,
  recordImportVisionStats,
  runImportAiFailuresBatchCore,
  runInitialImportPipeline,
  runMissingInferenceBatchCore,
} from "../../shared/import/import-orchestrator-core.mjs";

export function createImportServices({
  analyzeTravelImage,
  analyzeTravelImageVision = analyzeTravelImage,
  embedTravelImageAnalysis,
  embedTravelImageImage,
  inferMissingInfoWithImage,
  importJobs,
  makeId,
  paths,
  readState,
  readVectorIndex,
  repository,
  responseState,
  secretProvider,
  writeState,
  writeVectorIndex,
}) {
  const jobSubscribers = new Map();
  const pipelineConfig = importPipelineConfig(process.env);
  const metadataConcurrency = pipelineConfig.concurrency.metadata;
  const storageWriteConcurrency = pipelineConfig.concurrency.storageWrite;
  const aiConcurrency = pipelineConfig.concurrency.ai;
  const embeddingConcurrency = pipelineConfig.concurrency.embedding;
  const missingInferenceConcurrency = pipelineConfig.concurrency.missingInference;
  const failedImportJobRetentionMs = Number(process.env.EARTH_ONLINE_FAILED_IMPORT_JOB_RETENTION_MS ?? 24 * 60 * 60 * 1000);
  const aiImageMaxDimension = pipelineConfig.images.aiImageMaxDimension;
  const aiImageJpegQuality = pipelineConfig.images.aiImageJpegQuality;
  const displayImageMaxDimension = pipelineConfig.images.displayImageMaxDimension;
  const displayImageJpegQuality = pipelineConfig.images.displayImageJpegQuality;
  const thumbnailMaxDimension = pipelineConfig.images.thumbnailMaxDimension;
  const thumbnailJpegQuality = pipelineConfig.images.thumbnailJpegQuality;

  async function readImportFile(file) {
    const fullPath = file.tempPath || file.sourcePath;
    if (fullPath) {
      const buffer = await fs.readFile(fullPath);
      return { fullPath, mime: file.type || "image/jpeg", buffer };
    }
    throw new Error(`Import file is missing a tempPath/sourcePath: ${file.name || "unnamed"}`);
  }

  async function createJpegDerivativeFromFile(fullPath, { fallbackExt = ".jpg", maxDimension, quality }) {
    try {
      return {
        ext: ".jpg",
        buffer: await sharp(fullPath, { failOn: "none" })
          .rotate()
          .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer(),
      };
    } catch {
      return { ext: fallbackExt, buffer: await fs.readFile(fullPath) };
    }
  }

  async function createJpegDerivativeFromSharpBase(base, fullPath, { fallbackExt = ".jpg", maxDimension, quality }) {
    try {
      return {
        ext: ".jpg",
        buffer: await base
          .clone()
          .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer(),
      };
    } catch {
      return { ext: fallbackExt, buffer: await fs.readFile(fullPath) };
    }
  }

  async function createAiInputFromFile(fullPath, ext) {
    const maxDimension = Number.isFinite(aiImageMaxDimension) && aiImageMaxDimension > 0 ? aiImageMaxDimension : 1200;
    const quality = Number.isFinite(aiImageJpegQuality) && aiImageJpegQuality > 0 && aiImageJpegQuality <= 100 ? aiImageJpegQuality : 82;
    return createJpegDerivativeFromFile(fullPath, { fallbackExt: ext, maxDimension, quality });
  }

  async function processImportImageDerivatives(prepared, job, { needThumbnail = true, onAiInputReady } = {}) {
    const base = sharp(prepared.fullPath, { failOn: "none" }).rotate();
    const aiInput = await createJpegDerivativeFromSharpBase(base, prepared.fullPath, {
      fallbackExt: prepared.ext,
      maxDimension: Number.isFinite(aiImageMaxDimension) && aiImageMaxDimension > 0 ? aiImageMaxDimension : 1200,
      quality: Number.isFinite(aiImageJpegQuality) && aiImageJpegQuality > 0 && aiImageJpegQuality <= 100 ? aiImageJpegQuality : 82,
    });
    const aiMime = mimeFromExt(aiInput.ext, prepared.mime);
    let aiImagePayload = imagePayloadFromBuffer(aiInput.buffer, aiMime);
    if (job?.photoId && paths.aiInputDir) {
      const aiInputName = `${job.photoId}${aiInput.ext}`;
      await fs.writeFile(path.join(paths.aiInputDir, aiInputName), aiInput.buffer);
      aiImagePayload = {
        ...aiImagePayload,
        name: aiInputName,
        url: `/data/ai-inputs/${aiInputName}`,
      };
    }
    onAiInputReady?.(aiImagePayload);
    if (!needThumbnail) return { aiImagePayload };

    const thumbnail = await createJpegDerivativeFromSharpBase(base, prepared.fullPath, {
      fallbackExt: prepared.ext,
      maxDimension: thumbnailMaxDimension,
      quality: thumbnailJpegQuality,
    });
    const display = await createJpegDerivativeFromSharpBase(base, prepared.fullPath, {
      fallbackExt: prepared.ext,
      maxDimension: Number.isFinite(displayImageMaxDimension) && displayImageMaxDimension > 0 ? displayImageMaxDimension : 1800,
      quality: Number.isFinite(displayImageJpegQuality) && displayImageJpegQuality > 0 && displayImageJpegQuality <= 100 ? displayImageJpegQuality : 85,
    });
    const thumbName = `${job.photoId}${thumbnail.ext}`;
    const displayName = `${job.photoId}${display.ext}`;
    await fs.writeFile(path.join(paths.thumbDir, thumbName), thumbnail.buffer);
    if (paths.displayDir) await fs.writeFile(path.join(paths.displayDir, displayName), display.buffer);
    await fs.copyFile(prepared.fullPath, path.join(paths.photoDir, job.storageName));
    return {
      aiImagePayload,
      thumbnail: {
        name: thumbName,
        displayName,
        displayUrl: `/data/display/${displayName}`,
      },
    };
  }

  function mimeFromExt(ext = ".jpg", fallback = "image/jpeg") {
    const normalized = String(ext).toLowerCase();
    if (normalized === ".png") return "image/png";
    if (normalized === ".webp") return "image/webp";
    if (normalized === ".heic" || normalized === ".heif") return "image/heic";
    if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
    return fallback;
  }

  function imagePayloadFromBuffer(buffer, mime = "image/jpeg") {
    return {
      mime,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
    };
  }

  async function readImagePayloadFromFile(fullPath, mime) {
    const buffer = await fs.readFile(fullPath);
    return imagePayloadFromBuffer(buffer, mime);
  }

  async function readAiImagePayloadFromFile(fullPath, mime) {
    const derivative = await createAiInputFromFile(fullPath, path.extname(fullPath).toLowerCase() || ".jpg");
    return imagePayloadFromBuffer(derivative.buffer, mimeFromExt(derivative.ext, mime));
  }

  async function cleanupStaleImportJobDirs() {
    if (!paths.importJobDir) return;
    const retentionMs = Number.isFinite(failedImportJobRetentionMs) && failedImportJobRetentionMs > 0 ? failedImportJobRetentionMs : 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    const entries = await fs.readdir(paths.importJobDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = path.join(paths.importJobDir, entry.name);
          const stat = await fs.stat(fullPath).catch(() => undefined);
          if (stat && stat.mtimeMs < cutoff) await fs.rm(fullPath, { recursive: true, force: true });
        }),
    );
  }

  async function importPhotos(payload, progress = {}) {
    const state = await readState();
    const vectorIndex = await readVectorIndex();
    const now = new Date();
    const files = safeArray(payload.files).slice(0, 1000);
    const locale = normalizeLocale(payload.locale);
    if (files.length === 0) throw new Error("没有收到可导入图片。");

    const result = await runInitialImportPipeline({
      items: files,
      state,
      vectorIndex,
      now,
      locale,
      makeId,
      allowCloud: payload.allowCloudAi !== false,
      reanalyzeDuplicates: payload.reanalyzeDuplicates,
      concurrency: {
        metadata: metadataConcurrency,
        storageWrite: storageWriteConcurrency,
        ai: aiConcurrency,
        embedding: embeddingConcurrency,
      },
      progress,
      adapter: {
        initialPhases: ["exif", "thumbnails", "ai", "embedding"],
        countsPhase: (phase) => phase !== "reading",
        itemFileName: (file, index) => file.name || `photo-${index + 1}`,
        createAiStats: createImportAiStats,
        async prepareItem(file) {
          const parsed = await readImportFile(file);
          const { fullPath, mime, buffer } = parsed;
          const ext = extFromName(file.name, mime);
          const exif = parseExif(buffer);
          return {
            file,
            fileName: file.name,
            fullPath,
            mime,
            ext,
            originalHash: hashBuffer(buffer),
            location: exif.location,
            capturedAt: exif.capturedAt,
          };
        },
        storageName: (prepared, { photoId }) => `${photoId}${prepared.ext}`,
        capturedAt: (prepared, { now: importNow, total, index }) =>
          prepared.capturedAt ??
          (prepared.file.lastModified ? new Date(prepared.file.lastModified).toISOString() : new Date(importNow.getTime() - (total - index) * 86400000).toISOString()),
        processImageDerivatives: processImportImageDerivatives,
        thumbnailName: (thumbnail) => thumbnail.name,
        analyzeVision: (input) => analyzePhotoVision(input),
        embedImage: (input) => embedPhotoImage(input),
        recordVisionStats: recordImportVisionStats,
        recordEmbeddingStats: recordImportEmbeddingStats,
        withLocationCandidates: ({ location, aiEvidence, locale }) => withBackendLocationCandidates({ location, aiEvidence, locale }),
        applyDuplicateAnalysis({ duplicatePhoto, parsedLocation, ai, embedding, vectorIndex, makeId, locale }) {
          const resolvedLocation = duplicatePhoto.location ?? parsedLocation;
          const aiEvidenceBase = toAiEvidence(ai, { makeId });
          const aiEvidence = withBackendLocationCandidates({ location: resolvedLocation, aiEvidence: aiEvidenceBase, locale });
          duplicatePhoto.tags = ai.tags;
          duplicatePhoto.title = ai.title || makePhotoTitle(duplicatePhoto);
          duplicatePhoto.aiCaption = ai.caption;
          duplicatePhoto.ai = aiEvidence;
          duplicatePhoto.locationResolution = resolveImportedLocation({
            location: resolvedLocation,
            aiEvidence,
            pendingReason: duplicatePhoto.pendingReason,
          });
          duplicatePhoto.aiProvider = ai.provider;
          duplicatePhoto.aiModel = ai.model;
          duplicatePhoto.aiFallbackReason = ai.fallbackReason;
          duplicatePhoto.embeddingProvider = embedding.embeddingProvider;
          duplicatePhoto.embeddingModel = embedding.embeddingModel;
          duplicatePhoto.embeddingSpaceId = embedding.embeddingSpaceId;
          duplicatePhoto.embeddingDimension = embedding.embeddingDimension ?? embedding.embedding?.length;
          duplicatePhoto.embeddingMode = embedding.embeddingMode;
          duplicatePhoto.embeddingFallbackReason = embedding.embeddingFallbackReason;
          if (parsedLocation && !duplicatePhoto.location) duplicatePhoto.location = parsedLocation;
          if (Array.isArray(embedding.embedding)) vectorIndex[duplicatePhoto.id] = embedding.embedding;
          else delete vectorIndex[duplicatePhoto.id];
        },
        buildNewPhoto({ job, thumbnail, ai, embedding, aiFailure, aiEvidence, photoPendingReason, aiImagePayload }) {
          return {
            id: job.photoId,
            fileName: job.fileName || job.storageName,
            title: ai.title || makePhotoTitle({ fileName: job.fileName || job.storageName, tags: ai.tags, aiCaption: ai.caption }),
            originalHash: job.originalHash,
            mime: job.mime,
            thumbnailUrl: `/data/thumbs/${thumbnail.name}`,
            aiInputUrl: aiImagePayload?.url,
            displayUrl: thumbnail.displayUrl,
            storageUrl: `/data/photos/${job.storageName}`,
            capturedAt: job.capturedAt,
            location: job.location,
            tags: ai.tags,
            aiCaption: ai.caption,
            ai: aiEvidence,
            locationResolution: resolveImportedLocation({ location: job.location, aiEvidence, pendingReason: photoPendingReason }),
            aiProvider: ai.provider,
            aiModel: ai.model,
            aiFallbackReason: ai.fallbackReason,
            embeddingProvider: embedding.embeddingProvider,
            embeddingModel: embedding.embeddingModel,
            embeddingSpaceId: embedding.embeddingSpaceId,
            embeddingDimension: embedding.embeddingDimension ?? embedding.embedding?.length,
            embeddingMode: embedding.embeddingMode,
            embeddingFallbackReason: embedding.embeddingFallbackReason,
            aiFailure,
            importedBatchId: job.batchId,
            pendingReason: photoPendingReason,
            exifStatus: {
              time: job.hasExifTime ? "read" : "fallback",
              gps: job.hasExifLocation ? "read" : "missing",
            },
          };
        },
        buildStateOptions: ({ photos }) => ({
          storedFileNames: photos.map((photo) => path.basename(photo.storageUrl)),
          storedThumbnailNames: photos.map((photo) => path.basename(photo.thumbnailUrl)),
          storedAiInputNames: photos.map((photo) => photo.aiInputUrl && path.basename(photo.aiInputUrl)).filter(Boolean),
          storedDisplayNames: photos.map((photo) => photo.displayUrl && path.basename(photo.displayUrl)).filter(Boolean),
          completeCandidatePoint,
        }),
      },
    });
    await writeVectorIndex(result.vectorIndex);
    await writeState(result.state);
    progress.update?.({ phase: "completed", done: files.length, total: files.length });
    return responseState();
  }

  async function startImportJob(payload) {
    const id = makeId("job");
    return enqueueImportJob(id, {
      ...payload,
      allowCloudAi: payload.allowCloudAi === "false" ? false : payload.allowCloudAi === "true" ? true : payload.allowCloudAi,
      reanalyzeDuplicates: payload.reanalyzeDuplicates === "true" ? true : payload.reanalyzeDuplicates,
      files: safeArray(payload.files),
    });
  }

  async function startMultipartImportJob(req) {
    await cleanupStaleImportJobDirs();
    const id = makeId("job");
    const rawDir = path.join(paths.importJobDir ?? path.join(paths.rootDir, "data", "import-jobs"), id, "raw");
    let payload;
    try {
      payload = await readMultipartFormDataToDir(req, rawDir);
    } catch (error) {
      await fs.rm(path.dirname(rawDir), { recursive: true, force: true });
      throw error;
    }
    return enqueueImportJob(id, {
      ...payload,
      allowCloudAi: payload.allowCloudAi === "false" ? false : payload.allowCloudAi === "true" ? true : payload.allowCloudAi,
      reanalyzeDuplicates: payload.reanalyzeDuplicates === "true" ? true : payload.reanalyzeDuplicates,
    });
  }

  function enqueueImportJob(id, jobPayload) {
    const total = safeArray(jobPayload.files).length;
    const createdAt = new Date().toISOString();
    const initialProgress = {
      phase: "queued",
      done: 0,
      total,
      steps: {
        upload: { done: total, total },
        exif: { done: 0, total },
        thumbnails: { done: 0, total },
        ai: { done: 0, total },
        embedding: { done: 0, total },
      },
    };
    const job = {
      id,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: initialProgress,
      progressEvents: [{ ...initialProgress, sequence: 0, createdAt }],
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
      current.progress = {
        phase: "exif",
        done: 0,
        total,
        steps: {
          upload: { done: total, total },
          exif: { done: 0, total },
          thumbnails: { done: 0, total },
          ai: { done: 0, total },
          embedding: { done: 0, total },
        },
      };
      appendProgressEvent(current);
      repository.saveImportJob(current);
      const updateProgress = (next) => {
        const steps = { ...(current.progress?.steps ?? {}) };
        if (["uploading", "exif", "thumbnails", "ai", "embedding"].includes(next.phase)) {
          const stepKey = next.phase === "uploading" ? "upload" : next.phase;
          steps[next.phase] = {
            done: next.done ?? steps[next.phase]?.done ?? 0,
            total: next.total ?? steps[next.phase]?.total ?? total,
            currentFileName: next.currentFileName,
          };
          steps[stepKey] = {
            done: next.done ?? steps[stepKey]?.done ?? 0,
            total: next.total ?? steps[stepKey]?.total ?? total,
            currentFileName: next.currentFileName,
          };
        }
        if (next.phase === "completed") {
          steps.upload = { ...(steps.upload ?? {}), done: total, total };
          steps.exif = { ...(steps.exif ?? {}), done: total, total };
          steps.thumbnails = { ...(steps.thumbnails ?? {}), done: total, total };
          steps.ai = { ...(steps.ai ?? {}), done: total, total };
          steps.embedding = { ...(steps.embedding ?? {}), done: total, total };
        }
        current.progress = {
          ...(current.progress ?? {}),
          ...next,
          total: next.total ?? current.progress?.total ?? total,
          steps,
        };
        current.updatedAt = new Date().toISOString();
        appendProgressEvent(current);
        repository.saveImportJob(current);
      };
      try {
        current.result = await importPhotos(jobPayload, { update: updateProgress });
        if (paths.importJobDir) await fs.rm(path.join(paths.importJobDir, id), { recursive: true, force: true });
        current.status = "completed";
        current.progress = {
          ...(current.progress ?? {}),
          phase: "completed",
          done: total,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            upload: { done: total, total },
            exif: { done: total, total },
            thumbnails: { done: total, total },
            ai: { done: total, total },
            embedding: { done: total, total },
          },
        };
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "import job failed";
        current.progress = { ...(current.progress ?? {}), phase: "failed", total };
        appendProgressEvent(current);
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
      publishJobTerminal(current);
    }, 0);
    return job;
  }

  async function startPendingInferenceJob(batchId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") {
      throw new Error("找不到待确认导入批次。");
    }
    const requestedIds = new Set(safeArray(body.pendingIds).map(String));
    const pendingItems = state.pendingItems.filter(
      (item) =>
        batch.pendingItemIds.includes(item.id) &&
        item.status === "open" &&
        ["missing_gps", "confirm_location_candidate"].includes(item.type) &&
        requestedIds.has(item.id),
    );
    return enqueuePendingInferenceJob(makeId("job"), { batchId, pendingIds: pendingItems.map((item) => item.id), locale: normalizeLocale(body.locale) });
  }

  async function startAiFailureResolveJob(batchId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") {
      throw new Error("找不到待确认导入批次。");
    }
    const requestedIds = new Set(safeArray(body.pendingIds).map(String));
    const action = ["retry_vision", "retry_embedding", "retry_both"].includes(body.action) ? body.action : "retry_vision";
    const pendingItems = state.pendingItems.filter(
      (item) =>
        batch.pendingItemIds.includes(item.id) &&
        item.status === "open" &&
        item.type === "ai_processing_failed" &&
        requestedIds.has(item.id),
    );
    return enqueueAiFailureResolveJob(makeId("job"), { batchId, pendingIds: pendingItems.map((item) => item.id), action, locale: normalizeLocale(body.locale) });
  }

  function enqueuePendingInferenceJob(id, jobPayload) {
    const total = safeArray(jobPayload.pendingIds).length;
    const createdAt = new Date().toISOString();
    const initialProgress = {
      phase: "queued",
      done: 0,
      total,
      steps: {
        ai: { done: 0, total },
      },
    };
    const job = {
      id,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: initialProgress,
      progressEvents: [{ ...initialProgress, sequence: 0, createdAt }],
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
      current.progress = {
        phase: "ai",
        done: 0,
        total,
        steps: {
          ai: { done: 0, total },
        },
      };
      appendProgressEvent(current);
      repository.saveImportJob(current);
      const updateProgress = (next) => {
        const steps = { ...(current.progress?.steps ?? {}) };
        steps.ai = {
          done: next.done ?? steps.ai?.done ?? 0,
          total: next.total ?? steps.ai?.total ?? total,
          currentFileName: next.currentFileName,
        };
        current.progress = {
          ...(current.progress ?? {}),
          ...next,
          phase: next.phase ?? "ai",
          total: next.total ?? current.progress?.total ?? total,
          steps,
        };
        current.updatedAt = new Date().toISOString();
        appendProgressEvent(current);
        repository.saveImportJob(current);
      };
      try {
        current.result = await inferPendingLocationsBatch(jobPayload, { update: updateProgress });
        current.status = "completed";
        current.progress = {
          ...(current.progress ?? {}),
          phase: "completed",
          done: total,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            ai: { done: total, total },
          },
        };
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "pending inference job failed";
        current.progress = { ...(current.progress ?? {}), phase: "failed", total };
        appendProgressEvent(current);
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
      publishJobTerminal(current);
    }, 0);
    return job;
  }

  function enqueueAiFailureResolveJob(id, jobPayload) {
    const total = safeArray(jobPayload.pendingIds).length;
    const createdAt = new Date().toISOString();
    const initialProgress = {
      phase: "queued",
      done: 0,
      total,
      steps: {
        ai: { done: 0, total },
      },
    };
    const job = {
      id,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: initialProgress,
      progressEvents: [{ ...initialProgress, sequence: 0, createdAt }],
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
      current.progress = {
        phase: "ai",
        done: 0,
        total,
        steps: {
          ai: { done: 0, total },
        },
      };
      appendProgressEvent(current);
      repository.saveImportJob(current);
      const updateProgress = (next) => {
        const steps = { ...(current.progress?.steps ?? {}) };
        steps.ai = {
          done: next.done ?? steps.ai?.done ?? 0,
          total: next.total ?? steps.ai?.total ?? total,
          currentFileName: next.currentFileName,
        };
        current.progress = {
          ...(current.progress ?? {}),
          ...next,
          phase: next.phase ?? "ai",
          total: next.total ?? current.progress?.total ?? total,
          steps,
        };
        current.updatedAt = new Date().toISOString();
        appendProgressEvent(current);
        repository.saveImportJob(current);
      };
      try {
        current.result = await resolveImportAiFailuresBatch(jobPayload, { update: updateProgress });
        current.status = "completed";
        current.progress = {
          ...(current.progress ?? {}),
          phase: "completed",
          done: total,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            ai: { done: total, total },
          },
        };
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "AI failure resolve job failed";
        current.progress = { ...(current.progress ?? {}), phase: "failed", total };
        appendProgressEvent(current);
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
      publishJobTerminal(current);
    }, 0);
    return job;
  }

  function enqueueEmbeddingRebuildJob(id, jobPayload = {}) {
    const createdAt = new Date().toISOString();
    const job = {
      id,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: {
        phase: "queued",
        done: 0,
        total: 0,
        steps: {
          embedding: { done: 0, total: 0 },
        },
      },
      progressEvents: [
        {
          phase: "queued",
          done: 0,
          total: 0,
          steps: {
            embedding: { done: 0, total: 0 },
          },
          sequence: 0,
          createdAt,
        },
      ],
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
      const updateProgress = (next) => {
        const total = next.total ?? current.progress?.total ?? 0;
        const done = next.done ?? current.progress?.done ?? 0;
        current.progress = {
          ...(current.progress ?? {}),
          ...next,
          phase: next.phase ?? "embedding",
          done,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            embedding: {
              done,
              total,
              currentFileName: next.currentFileName,
            },
          },
        };
        current.updatedAt = new Date().toISOString();
        appendProgressEvent(current);
        repository.saveImportJob(current);
      };
      updateProgress({ phase: "embedding", done: 0, total: 0 });
      try {
        current.result = await rebuildPhotoEmbeddings(jobPayload, { update: updateProgress });
        const total = current.progress?.total ?? 0;
        current.status = "completed";
        current.progress = {
          ...(current.progress ?? {}),
          phase: "completed",
          done: total,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            embedding: { done: total, total },
          },
        };
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "embedding rebuild job failed";
        current.progress = { ...(current.progress ?? {}), phase: "failed" };
        appendProgressEvent(current);
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
      publishJobTerminal(current);
    }, 0);
    return job;
  }

  function startEmbeddingRebuildJob(body = {}) {
    return enqueueEmbeddingRebuildJob(makeId("job"), {
      photoIds: safeArray(body.photoIds).map(String).filter(Boolean),
    });
  }

  async function rebuildPhotoEmbeddings(jobPayload = {}, progress = {}) {
    const state = await readState();
    const requestedPhotoIds = new Set(safeArray(jobPayload.photoIds).map(String).filter(Boolean));
    const photos = requestedPhotoIds.size ? safeArray(state.photos).filter((photo) => requestedPhotoIds.has(photo.id)) : safeArray(state.photos);
    const total = photos.length;
    const previousVectorIndex = await readVectorIndex();
    const nextVectorIndex = requestedPhotoIds.size ? { ...previousVectorIndex } : {};
    const failed = [];
    const succeeded = [];
    let done = 0;
    progress.update?.({ phase: "embedding", done, total });
    const rebuiltPhotos = await mapConcurrent(photos, embeddingConcurrency, async (photo) => {
      const imagePayload = await readPhotoImagePayload(photo);
      let embedding;
      if (imagePayload) {
        embedding = await embedPhotoImageWithRetry({
          fileName: photo.fileName,
          mime: imagePayload.mime,
          dataUrl: imagePayload.dataUrl,
          allowCloud: true,
        });
      } else {
        embedding = {
          embedding: undefined,
          embeddingProvider: undefined,
          embeddingModel: undefined,
          embeddingSpaceId: undefined,
          embeddingDimension: undefined,
          embeddingMode: "failed",
          embeddingFallbackReason: "找不到原图，无法重建向量。",
        };
      }
      if (embeddingRebuildSucceeded(embedding)) {
        succeeded.push(photo.id);
      } else {
        failed.push(embeddingRebuildFailure(photo, embedding));
      }
      patchVectorIndexForEmbedding(nextVectorIndex, photo.id, embedding);
      done += 1;
      progress.update?.({ phase: "embedding", done, total, currentFileName: photo.fileName });
      return applyEmbeddingFields(photo, embedding);
    });
    await writeVectorIndex(nextVectorIndex);
    await writeState(mergeRebuiltPhotosState(state, rebuiltPhotos));
    progress.update?.({ phase: "completed", done: total, total });
    return {
      ...(await responseState()),
      embeddingRebuild: buildEmbeddingRebuildReport({ total, succeeded, failed, mode: requestedPhotoIds.size ? "retry_failed" : "all" }),
    };
  }

  async function wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function embedPhotoImageWithRetry(input, { attempts = 3 } = {}) {
    let latest;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      latest = await embedPhotoImage(input);
      if (Array.isArray(latest.embedding) && latest.embedding.length > 0 && latest.embeddingMode === "cross_modal") return latest;
      if (attempt < attempts) await wait(400 * attempt);
    }
    return latest;
  }

  function appendProgressEvent(job) {
    const progress = job.progress;
    if (!progress) return;
    const previous = safeArray(job.progressEvents);
    const last = previous.at(-1);
    if (last && last.phase === progress.phase && last.done === progress.done && last.total === progress.total && last.currentFileName === progress.currentFileName) return;
    const sequence = Number.isFinite(Number(last?.sequence)) ? Number(last.sequence) + 1 : 0;
    const event = {
      ...JSON.parse(JSON.stringify(progress)),
      sequence,
      createdAt: job.updatedAt ?? new Date().toISOString(),
    };
    job.progressEvents = [...previous, event].slice(-3000);
    publishJobProgress(job.id, event);
  }

  function writeSse(res, eventName, payload) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function publishJobProgress(jobId, event) {
    const subscribers = jobSubscribers.get(jobId);
    if (!subscribers?.size) return;
    for (const res of subscribers) writeSse(res, "progress", event);
  }

  function publishJobTerminal(job) {
    const subscribers = jobSubscribers.get(job.id);
    if (!subscribers?.size) return;
    for (const res of subscribers) {
      writeSse(res, "done", { status: job.status, error: job.error });
      res.end();
    }
    jobSubscribers.delete(job.id);
  }

  function subscribeImportJob(id, req, res) {
    const job = getImportJob(id);
    if (!job) return false;
    res.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    for (const event of safeArray(job.progressEvents)) writeSse(res, "progress", event);
    if (job.status === "completed" || job.status === "failed") {
      writeSse(res, "done", { status: job.status, error: job.error });
      res.end();
      return true;
    }
    const subscribers = jobSubscribers.get(id) ?? new Set();
    subscribers.add(res);
    jobSubscribers.set(id, subscribers);
    req.on("close", () => {
      const current = jobSubscribers.get(id);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) jobSubscribers.delete(id);
    });
    return true;
  }

  function getImportJob(id) {
    const job = importJobs.get(id);
    return job ?? repository.getImportJob(id);
  }

  async function importAppleTestPhotos(options = {}) {
    const appleDir = path.join(paths.rootDir, "DESIGN_SPECS", "photo test", "apple");
    await fs.access(appleDir).catch(() => {
      throw new Error("Apple test photo fixtures are not included in the public repository.");
    });
    const entries = await fs.readdir(appleDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && /\.(jpe?g|png|heic)$/i.test(entry.name)) {
        const sourcePath = path.join(appleDir, entry.name);
        const stat = await fs.stat(sourcePath);
        files.push({
          name: entry.name,
          type: /\.(png)$/i.test(entry.name) ? "image/png" : /\.(heic)$/i.test(entry.name) ? "image/heic" : "image/jpeg",
          size: stat.size,
          lastModified: stat.mtimeMs,
          sourcePath,
        });
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
    await writeState(confirmImportState(state, id));
    return responseState();
  }

  async function inferPendingLocation(batchId, pendingId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const pending = state.pendingItems.find((item) => item.id === pendingId);
    if (!batch || batch.status !== "pending_confirmation" || !pending || !batch.pendingItemIds.includes(pending.id)) return responseState();
    if (!["missing_gps", "confirm_location_candidate"].includes(pending.type)) return responseState();

    const proposal = await buildMissingInfoInferenceProposal(state, batch, pending, { locale: normalizeLocale(body.locale) });
    const latestState = await readState();
    const latestBatch = latestState.importBatches.find((item) => item.id === batchId);
    const latestPending = latestState.pendingItems.find((item) => item.id === pendingId);
    if (!latestBatch || latestBatch.status !== "pending_confirmation" || !latestPending || !latestBatch.pendingItemIds.includes(latestPending.id)) return responseState();
    if (!["missing_gps", "confirm_location_candidate"].includes(latestPending.type)) return responseState();
    await writeState(applyMissingInfoProposalState(latestState, batchId, latestPending.id, proposal, { now: () => new Date().toISOString() }));
    return responseState();
  }

  async function inferPendingLocationsBatch({ batchId, pendingIds, locale: rawLocale }, progress = {}) {
    const state = await readState();
    const locale = normalizeLocale(rawLocale);
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") return responseState();
    const result = await runMissingInferenceBatchCore({
      state,
      batchId,
      pendingIds,
      locale,
      concurrency: missingInferenceConcurrency,
      progress,
      buildProposal: buildMissingInfoInferenceProposal,
      now: () => new Date().toISOString(),
      emitCompleted: false,
    });
    const latestState = await readState();
    const latestBatch = latestState.importBatches.find((item) => item.id === batchId);
    if (!latestBatch || latestBatch.status !== "pending_confirmation") return responseState();
    await writeState(applyMissingInfoProposalResultsState(latestState, batchId, result.results ?? [], { now: () => new Date().toISOString() }));
    progress.update?.({ phase: "completed", done: result.total, total: result.total });
    return responseState();
  }

  async function rollbackImport(id) {
    const state = await readState();
    const result = rollbackImportState(state, id, { makeId });
    for (const name of result.storedFileNames) {
      await fs.rm(path.join(paths.photoDir, path.basename(name)), { force: true });
    }
    for (const name of result.storedThumbnailNames) {
      await fs.rm(path.join(paths.thumbDir, path.basename(name)), { force: true });
    }
    for (const name of result.storedAiInputNames ?? []) {
      if (paths.aiInputDir) await fs.rm(path.join(paths.aiInputDir, path.basename(name)), { force: true });
    }
    for (const name of result.storedDisplayNames ?? []) {
      if (paths.displayDir) await fs.rm(path.join(paths.displayDir, path.basename(name)), { force: true });
    }
    const vectorIndex = await readVectorIndex();
    for (const photoId of result.removedPhotoIds) delete vectorIndex[photoId];
    await writeVectorIndex(vectorIndex);
    await writeState(result.state);
    return responseState();
  }

  async function cancelImportPhotos(batchId, body = {}) {
    const state = await readState();
    const result = cancelImportPhotosState(state, batchId, body, { makeId });
    if (!result.canceledPhotos.length) return responseState();

    for (const photo of result.canceledPhotos) {
      if (photo.storageUrl) await fs.rm(path.join(paths.photoDir, path.basename(photo.storageUrl)), { force: true });
      if (photo.thumbnailUrl) await fs.rm(path.join(paths.thumbDir, path.basename(photo.thumbnailUrl)), { force: true });
      if (photo.aiInputUrl && paths.aiInputDir) await fs.rm(path.join(paths.aiInputDir, path.basename(photo.aiInputUrl)), { force: true });
      if (photo.displayUrl && paths.displayDir) await fs.rm(path.join(paths.displayDir, path.basename(photo.displayUrl)), { force: true });
    }

    const vectorIndex = await readVectorIndex();
    for (const id of result.canceledPhotoIds) delete vectorIndex[id];
    await writeVectorIndex(vectorIndex);
    await writeState(result.state);
    return responseState();
  }

  async function resolveImportAiFailure(batchId, pendingId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const pending = state.pendingItems.find((item) => item.id === pendingId);
    if (!batch || batch.status !== "pending_confirmation" || !pending || !batch.pendingItemIds.includes(pending.id) || pending.type !== "ai_processing_failed") return responseState();
    const photo = state.photos.find((item) => item.id === pending.relatedPhotoIds?.[0]);
    if (!photo) return responseState();

    if (body.action === "archive_exif") return archiveAiFailureWithExif(state, batch, pending, photo);
    if (body.action === "retry_vision" || body.action === "retry_embedding" || body.action === "retry_both") return retryImportAiFailure(state, batch, pending, photo, body.action, { locale: normalizeLocale(body.locale) });
    throw new Error("未知的 AI 失败处理方式。");
  }

  async function resolveImportAiFailuresBatch({ batchId, pendingIds, action = "retry_vision", locale: rawLocale }, progress = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") return responseState();
    const locale = normalizeLocale(rawLocale);
    const results = await runImportAiFailuresBatchCore({
      state,
      vectorIndex: {},
      batchId,
      pendingIds,
      action,
      locale,
      concurrency: aiConcurrency,
      progress,
      buildRetryResult: buildRetryImportAiFailureResult,
      appendMissingInfoPendingIfNeeded,
      makeId,
      emitCompleted: false,
      applyState: false,
    });

    const latestState = await readState();
    const latestBatch = latestState.importBatches.find((item) => item.id === batchId);
    if (!latestBatch || latestBatch.status !== "pending_confirmation") return responseState();

    const latestResult = applyImportAiFailureRetryResultsCore({
      state: latestState,
      vectorIndex: await readVectorIndex(),
      batchId,
      results: results.results ?? [],
      appendMissingInfoPendingIfNeeded,
      makeId,
    });
    await writeVectorIndex(latestResult.vectorIndex);
    await writeState(latestResult.state);
    progress.update?.({ phase: "completed", done: results.total, total: results.total });
    return responseState();
  }

  async function archiveAiFailureWithExif(state, batch, pending, photo) {
    if (photo.exifStatus?.gps !== "read" || !isUsableLocation(photo.location)) throw new Error("这张照片没有真实 EXIF GPS，不能直接按真实定位归档。");
    const patchedPhoto = {
      ...clearAiFailureForPhoto(photo),
      placeNodeId: undefined,
    };
    const nextState = appendMissingInfoPendingIfNeeded(
      {
        ...state,
        photos: state.photos.map((item) => (item.id === photo.id ? patchedPhoto : item)),
        pendingItems: state.pendingItems.map((item) => (item.id === pending.id ? { ...item, status: "accepted" } : item)),
      },
      batch,
      patchedPhoto,
    );
    await writeState(rebuildTripsForImportedPhoto(nextState, patchedPhoto, batch, { allowExistingPlaceMerge: true }));
    return responseState();
  }

  async function buildRetryImportAiFailureResult(state, batch, pending, photo, action, { locale = "zh" } = {}) {
    return buildRetryImportAiFailureResultCore({
      photo,
      action,
      locale,
      makeId,
      readPhotoImagePayload,
      analyzeVision: analyzePhotoVision,
      embedImage: embedPhotoImage,
      withLocationCandidates: ({ location, aiEvidence, locale }) => withBackendLocationCandidates({ location, aiEvidence, locale }),
    });
  }

  async function retryImportAiFailure(state, batch, pending, photo, action, { locale = "zh" } = {}) {
    const retry = await buildRetryImportAiFailureResult(state, batch, pending, photo, action, { locale });
    const vectorIndex = await readVectorIndex();
    if (retry.retryEmbedding && Array.isArray(retry.embedding.embedding)) vectorIndex[photo.id] = retry.embedding.embedding;
    else if (retry.retryEmbedding) delete vectorIndex[photo.id];
    await writeVectorIndex(vectorIndex);
    const nextState = appendMissingInfoPendingIfNeeded(
      {
        ...state,
        photos: state.photos.map((item) => (item.id === photo.id ? retry.patchedPhoto : item)),
        pendingItems: state.pendingItems.map((item) => (item.id === pending.id && !retry.failed ? { ...item, status: "accepted" } : item.id === pending.id ? { ...item, reason: failureReasonText(retry.patchedPhoto), suggestion: `${retry.patchedPhoto.title ?? retry.patchedPhoto.fileName} 初次导入 AI 仍处理失败，需要重新选择处理方式。` } : item)),
      },
      batch,
      retry.patchedPhoto,
    );
    await writeState(rebuildTripsForImportedPhoto(nextState, retry.patchedPhoto, batch, { allowExistingPlaceMerge: true }));
    return responseState();
  }

  function clearAiFailureForPhoto(photo) {
    const aiEvidence = withBackendLocationCandidates({ location: photo.location, aiEvidence: photo.ai });
    return clearAiFailureForPhotoCore(photo, { aiEvidence });
  }

  function appendMissingInfoPendingIfNeeded(state, batch, photo) {
    return appendMissingInfoPendingIfNeededCore(state, batch, photo, { makeId, completeCandidatePoint });
  }

  function rebuildTripsForImportedPhoto(state, photo, batch, options = {}) {
    const affectedTripIds = new Set([photo.tripId, ...batch.createdTripIds, ...(batch.updatedTripIds ?? [])].filter(Boolean));
    return rebuildTrips(state, affectedTripIds, { makeId, ...options });
  }

  async function mergeImportTrips(batchId) {
    const state = await readState();
    await writeState(mergeImportTripsState(state, batchId));
    return responseState();
  }

  async function analyzePhotoVision({ fileName, mime, dataUrl, preset, location, allowCloud, locale = "zh" }) {
    return analyzeTravelImageVision({
      rootDir: paths.rootDir,
      secretProvider,
      fileName,
      mime,
      dataUrl,
      preset,
      geoContext: geoContextFor(preset, location, locale),
      allowCloud,
      locale,
    });
  }

  async function embedPhotoAnalysis({ fileName, analysis, allowCloud }) {
    if (!embedTravelImageAnalysis) {
      return {
        embedding: analysis.embedding,
        embeddingProvider: analysis.embeddingProvider,
        embeddingModel: analysis.embeddingModel,
        embeddingSpaceId: analysis.embeddingSpaceId,
        embeddingDimension: analysis.embeddingDimension ?? analysis.embedding?.length,
        embeddingMode: analysis.embeddingMode ?? "disabled",
      };
    }
    return embedTravelImageAnalysis({
      rootDir: paths.rootDir,
      secretProvider,
      fileName,
      analysis,
      allowCloud,
    });
  }

  async function embedPhotoImage({ fileName, mime, dataUrl, allowCloud }) {
    if (!embedTravelImageImage) {
      return embedPhotoAnalysis({
        fileName,
        analysis: { title: fileName, caption: mime, tags: [], visiblePlaceNames: [] },
        allowCloud: false,
      });
    }
    return embedTravelImageImage({
      rootDir: paths.rootDir,
      secretProvider,
      fileName,
      mime,
      dataUrl,
      allowCloud,
    });
  }

  async function buildMissingInfoInferenceProposal(state, batch, pending, { locale = "zh" } = {}) {
    const photo = state.photos.find((item) => item.id === pending.relatedPhotoIds[0]);
    if (!photo) return keepPending(missingInferenceText(locale, "photoNotFound"), 0.2, locale);
    const context = buildInferenceContextPhotos(state, batch, photo);
    const contextPlaces = allowedInferencePlaces(state, context);
    const imagePayload = await readPhotoImagePayload(photo);
    if (!imagePayload) return keepPending(missingInferenceText(locale, "imageMissing"), 0, locale);
    const inferenceInput = buildMissingInfoInferenceInput({ photo, context, contextPlaces, locale });
    const aiResult = await inferMissingInfoWithImage({
      rootDir: paths.rootDir,
      secretProvider,
      dataUrl: imagePayload.dataUrl,
      mime: imagePayload.mime,
      inferenceInput,
      allowCloud: true,
      locale,
    });
    return normalizeMissingInfoAiProposal({ aiResult, photo, context, contextPlaces, locale, completeCandidatePoint });
  }

  async function readPhotoImagePayload(photo) {
    if (photo.aiInputUrl && paths.aiInputDir) {
      const fileName = path.basename(photo.aiInputUrl);
      const fullPath = path.join(paths.aiInputDir, fileName);
      const ext = path.extname(fileName).toLowerCase();
      const mime = mimeFromExt(ext, "image/jpeg");
      const existingPayload = await fs.access(fullPath).then(() => readImagePayloadFromFile(fullPath, mime)).catch(() => undefined);
      if (existingPayload) return existingPayload;
    }
    if (!photo.storageUrl) return undefined;
    const fileName = path.basename(photo.storageUrl);
    const fullPath = path.join(paths.photoDir, fileName);
    const ext = path.extname(fileName).toLowerCase();
    const mime = photo.mime || mimeFromExt(ext, "image/jpeg");
    return fs.access(fullPath).then(() => readAiImagePayloadFromFile(fullPath, mime)).catch(() => undefined);
  }

  function completeCandidatePoint(candidate, locale = "zh") {
    if (!candidate?.name) return candidate;
    if (isWeakPlaceName(candidate.name)) return candidate;
    const cityQuery = candidate.city || candidate.name;
    const fallback = forwardLocalGeocode(
      {
        name: candidate.name,
        city: candidate.city || candidate.name,
        country: candidate.country,
      },
      { makeId },
    )[0];
    if (!fallback?.point) return candidate;
    return {
      ...candidate,
      point: fallback.point,
      city: fallback.city ?? candidate.city ?? cityQuery,
      country: fallback.country ?? candidate.country,
      localizedCityNames: fallback.localizedCityNames ?? candidate.localizedCityNames,
      localizedCountryNames: fallback.localizedCountryNames ?? candidate.localizedCountryNames,
      localizedNames: candidate.localizedNames ?? fallback.localizedNames,
      confidence: Math.max(Number(candidate.confidence ?? 0), Math.min(0.72, Number(fallback.confidence ?? 0.6))),
      reason:
        normalizeLocale(locale) === "en"
          ? `${candidate.reason || "AI provided a clear place name."} Local gazetteer coordinates were added from ${fallback.name}.`
          : `${candidate.reason || "AI 给出了明确地点名。"} 已用本地地名库补入估计坐标：${fallback.name}。`,
      source: "geocode",
      precision: "estimated",
    };
  }

  function withBackendLocationCandidates({ location, aiEvidence, locale = "zh" }) {
    if (!aiEvidence) return aiEvidence;
    const aiCandidates = safeArray(aiEvidence.locationCandidates).map(stripCandidatePoint);
    const backendCandidates = isUsableLocation(location)
      ? reverseLocalGeocode(location, { makeId })
      : aiCandidates.map((candidate) => geocodeAiLocationCandidate(candidate, locale));
    return {
      ...aiEvidence,
      locationCandidates: mergeLocationCandidates(backendCandidates, aiCandidates),
    };
  }

  function stripCandidatePoint(candidate) {
    if (!candidate) return candidate;
    const rest = { ...candidate };
    delete rest.point;
    delete rest.lat;
    delete rest.lng;
    return rest;
  }

  function geocodeAiLocationCandidate(candidate, locale = "zh") {
    if (!candidate?.name && !candidate?.city) return candidate;
    if (candidate?.name && isWeakPlaceName(candidate.name)) return candidate;
    const cityQuery = candidate.city || candidate.name;
    const fallback = forwardLocalGeocode({ name: candidate.name, city: candidate.city || candidate.name, country: candidate.country }, { makeId })[0];
    if (!fallback?.point) return candidate;
    return {
      ...candidate,
      point: fallback.point,
      city: fallback.city ?? candidate.city ?? cityQuery,
      country: fallback.country ?? candidate.country,
      localizedCityNames: fallback.localizedCityNames ?? candidate.localizedCityNames,
      localizedCountryNames: fallback.localizedCountryNames ?? candidate.localizedCountryNames,
      localizedNames: candidate.localizedNames ?? fallback.localizedNames,
      confidence: Math.max(Number(candidate.confidence ?? 0), Math.min(0.72, Number(fallback.confidence ?? 0.6))),
      source: "geocode",
      precision: "estimated",
      reason:
        normalizeLocale(locale) === "en"
          ? `${candidate.reason || "AI provided a place name."} Local gazetteer coordinates were added from ${fallback.name}.`
          : `${candidate.reason || "AI 给出了地点名。"} 已用本地地名库补入估计坐标：${fallback.name}。`,
    };
  }

  return {
    importPhotos,
    startImportJob,
    startMultipartImportJob,
    startEmbeddingRebuildJob,
    getImportJob,
    subscribeImportJob,
    importAppleTestPhotos,
    confirmImport,
    rollbackImport,
    cancelImportPhotos,
    resolveImportAiFailure,
    startAiFailureResolveJob,
    inferPendingLocation,
    startPendingInferenceJob,
    mergeImportTrips,
  };
}

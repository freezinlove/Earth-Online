import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { safeArray } from "../domain/arrays.mjs";
import { toDateInput } from "../domain/dates.mjs";
import { parseExif } from "../domain/exif-parser.mjs";
import { geoContextFor, inferPreset, isUsableLocation, normalizeLocale } from "../domain/geo.mjs";
import { forwardLocalGeocode, reverseLocalGeocode } from "../domain/local-geocoder.mjs";
import { mergeLocationCandidates, resolveImportedLocation, toAiEvidence } from "../domain/location-resolver.mjs";
import { isWeakPlaceName } from "../domain/place-name-selector.mjs";
import { buildRoute } from "../domain/route-projector.mjs";
import { makePhotoTitle } from "../domain/text-normalizer.mjs";
import { rebuildTrips } from "../domain/trip-rebuilder.mjs";
import { readMultipartFormDataToDir } from "../http/body.mjs";
import { extFromName, hashBuffer } from "../storage/file-storage.mjs";
import { createLimiter, importPipelineConfig, mapConcurrent } from "../../shared/application/import-pipeline.mjs";
import {
  addLocationPendingItems,
  addMissingInfoPendingItems,
  buildImportStateFromPhotos,
  hasAiProcessingFailure,
  hasMissingImportInfo,
} from "../../shared/import/import-state-core.mjs";
import {
  allowedInferencePlaces,
  buildInferenceContextPhotos,
  buildMissingInfoInferenceInput,
  keepPending,
  missingInferenceText,
  normalizeMissingInfoAiProposal,
} from "../../shared/import/missing-info-inference-core.mjs";

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

  async function createThumbnailFromFile(fullPath, ext) {
    try {
      return {
        ext: ".jpg",
        buffer: await sharp(fullPath, { failOn: "none" })
          .rotate()
          .resize({ width: thumbnailMaxDimension, height: thumbnailMaxDimension, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: thumbnailJpegQuality })
          .toBuffer(),
      };
    } catch {
      return { ext, buffer: await fs.readFile(fullPath) };
    }
  }

  async function readAiImagePayloadFromFile(fullPath, mime) {
    const maxDimension = Number.isFinite(aiImageMaxDimension) && aiImageMaxDimension > 0 ? aiImageMaxDimension : 1200;
    const quality = Number.isFinite(aiImageJpegQuality) && aiImageJpegQuality > 0 && aiImageJpegQuality <= 100 ? aiImageJpegQuality : 82;
    try {
      const buffer = await sharp(fullPath, { failOn: "none" })
        .rotate()
        .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      return {
        mime: "image/jpeg",
        dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      };
    } catch {
      const buffer = await fs.readFile(fullPath);
      return {
        mime,
        dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
      };
    }
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
    const duplicatePhotoIds = new Set();
    let exifDone = 0;
    let thumbnailDone = 0;
    let aiDone = 0;
    let embeddingDone = 0;
    progress.update?.({ phase: "exif", done: 0, total: files.length });
    progress.update?.({ phase: "thumbnails", done: 0, total: files.length });
    progress.update?.({ phase: "ai", done: 0, total: files.length });
    progress.update?.({ phase: "embedding", done: 0, total: files.length });

    const storageLimit = createLimiter(storageWriteConcurrency);
    const visionLimit = createLimiter(aiConcurrency);
    const embeddingLimit = createLimiter(embeddingConcurrency);
    const downstreamTasks = [];
    const importedSlots = new Array(files.length);
    const allowCloud = payload.allowCloudAi !== false;

    const markThumbnailDone = (fileName) => {
      thumbnailDone += 1;
      progress.update?.({ phase: "thumbnails", done: thumbnailDone, total: files.length, currentFileName: fileName });
    };
    const markAiDone = (fileName) => {
      aiDone += 1;
      progress.update?.({ phase: "ai", done: aiDone, total: files.length, currentFileName: fileName });
    };
    const markEmbeddingDone = (fileName) => {
      embeddingDone += 1;
      progress.update?.({ phase: "embedding", done: embeddingDone, total: files.length, currentFileName: fileName });
    };

    await mapConcurrent(files, metadataConcurrency, async (file, index) => {
      const fileName = file.name || `photo-${index + 1}`;
      progress.update?.({ phase: "exif", done: exifDone, total: files.length, currentFileName: fileName });
      const parsed = await readImportFile(file);
      const { fullPath, mime, buffer } = parsed;
      const ext = extFromName(file.name, mime);
      const originalHash = hashBuffer(buffer);
      const exif = parseExif(buffer);
      exifDone += 1;
      progress.update?.({ phase: "exif", done: exifDone, total: files.length, currentFileName: fileName });

      if (knownHashes.has(originalHash)) {
        duplicateNames.push(fileName);
        const duplicatePhoto = knownHashToPhoto.get(originalHash);
        if (duplicatePhoto?.id) duplicatePhotoIds.add(duplicatePhoto.id);
        markThumbnailDone(fileName);
        if (payload.reanalyzeDuplicates) {
          const existingPhoto = duplicatePhoto;
          if (existingPhoto) {
            const parsedLocation = isUsableLocation(exif.location) ? exif.location : existingPhoto.location;
            const aiImagePayload = allowCloud ? readAiImagePayloadFromFile(fullPath, mime) : Promise.resolve(undefined);
            downstreamTasks.push(
              Promise.all([
                visionLimit(async () => {
                  const imagePayload = await aiImagePayload;
                  const ai = await analyzePhotoVision({
                    fileName,
                    mime: imagePayload?.mime ?? mime,
                    dataUrl: imagePayload?.dataUrl,
                    preset: inferPreset(fileName, parsedLocation),
                    location: parsedLocation,
                    allowCloud,
                    locale,
                  });
                  recordVisionStats(ai, aiStats);
                  markAiDone(fileName);
                  return ai;
                }),
                embeddingLimit(async () => {
                  const imagePayload = await aiImagePayload;
                  const embedding = await embedPhotoImage({ fileName, mime: imagePayload?.mime ?? mime, dataUrl: imagePayload?.dataUrl, allowCloud });
                  recordEmbeddingStats(embedding, aiStats);
                  markEmbeddingDone(fileName);
                  return embedding;
                }),
              ]).then(([ai, embedding]) => {
                const resolvedLocation = existingPhoto.location ?? parsedLocation;
                const aiEvidenceBase = toAiEvidence(ai, { makeId });
                const aiEvidence = withBackendLocationCandidates({ location: resolvedLocation, aiEvidence: aiEvidenceBase, locale });
                existingPhoto.tags = ai.tags;
                existingPhoto.title = ai.title || makePhotoTitle(existingPhoto);
                existingPhoto.aiCaption = ai.caption;
                existingPhoto.ai = aiEvidence;
                existingPhoto.locationResolution = resolveImportedLocation({
                  location: resolvedLocation,
                  aiEvidence,
                  pendingReason: existingPhoto.pendingReason,
                });
                existingPhoto.aiProvider = ai.provider;
                existingPhoto.aiModel = ai.model;
                existingPhoto.aiFallbackReason = ai.fallbackReason;
                existingPhoto.embeddingProvider = embedding.embeddingProvider;
                existingPhoto.embeddingModel = embedding.embeddingModel;
                existingPhoto.embeddingSpaceId = embedding.embeddingSpaceId;
                existingPhoto.embeddingDimension = embedding.embeddingDimension ?? embedding.embedding?.length;
                existingPhoto.embeddingMode = embedding.embeddingMode;
                existingPhoto.embeddingFallbackReason = embedding.embeddingFallbackReason;
                if (parsedLocation && !existingPhoto.location) existingPhoto.location = parsedLocation;
                if (Array.isArray(embedding.embedding)) vectorIndex[existingPhoto.id] = embedding.embedding;
                else delete vectorIndex[existingPhoto.id];
              }),
            );
          }
        } else {
          markAiDone(fileName);
          markEmbeddingDone(fileName);
        }
        return;
      }

      knownHashes.add(originalHash);
      const photoId = makeId("photo");
      const storageName = `${photoId}${ext}`;
      const storagePath = path.join(paths.photoDir, storageName);
      const parsedLocation = isUsableLocation(exif.location) ? exif.location : undefined;
      const preset = inferPreset(fileName, parsedLocation);
      const capturedAt =
        exif.capturedAt ??
        (file.lastModified ? new Date(file.lastModified).toISOString() : new Date(now.getTime() - (files.length - index) * 86400000).toISOString());
      const hasExifLocation = Boolean(parsedLocation);
      const location = parsedLocation;
      const pendingReason = !location ? "missing_gps" : !exif.capturedAt ? "missing_time" : undefined;
      const newAiJob = {
        type: "new",
        index,
        photoId,
        fileName,
        storageName,
        thumbName: `${photoId}.jpg`,
        originalHash,
        mime,
        fullPath,
        preset,
        location,
        capturedAt,
        pendingReason,
        hasExifLocation,
        hasExifTime: Boolean(exif.capturedAt),
      };
      const aiImagePayload = allowCloud ? readAiImagePayloadFromFile(fullPath, mime) : Promise.resolve(undefined);
      downstreamTasks.push(
        Promise.all([
          storageLimit(async () => {
            const thumbnail = await createThumbnailFromFile(fullPath, ext);
            const thumbName = `${photoId}${thumbnail.ext}`;
            await Promise.all([fs.copyFile(fullPath, storagePath), fs.writeFile(path.join(paths.thumbDir, thumbName), thumbnail.buffer)]);
            markThumbnailDone(fileName);
            return thumbName;
          }),
          visionLimit(async () => {
            const imagePayload = await aiImagePayload;
            const ai = await analyzePhotoVision({
              fileName,
              mime: imagePayload?.mime ?? mime,
              dataUrl: imagePayload?.dataUrl,
              preset,
              location,
              allowCloud,
              locale,
            });
            recordVisionStats(ai, aiStats);
            markAiDone(fileName);
            return ai;
          }),
          embeddingLimit(async () => {
            const imagePayload = await aiImagePayload;
            const embedding = await embedPhotoImage({ fileName, mime: imagePayload?.mime ?? mime, dataUrl: imagePayload?.dataUrl, allowCloud });
            recordEmbeddingStats(embedding, aiStats);
            markEmbeddingDone(fileName);
            return embedding;
          }),
        ]).then(([thumbName, ai, embedding]) => {
          const aiFailure = buildAiFailure(ai, embedding, newAiJob);
          const photoPendingReason = aiFailure ? "ai_processing_failed" : newAiJob.pendingReason;
          const aiEvidenceBase = toAiEvidence(ai, { makeId });
          const aiEvidence = withBackendLocationCandidates({ location: newAiJob.location, aiEvidence: aiEvidenceBase, locale });
          const photo = {
            id: newAiJob.photoId,
            fileName: newAiJob.fileName || newAiJob.storageName,
            title: ai.title || makePhotoTitle({ fileName: newAiJob.fileName || newAiJob.storageName, tags: ai.tags, aiCaption: ai.caption }),
            originalHash: newAiJob.originalHash,
            mime: newAiJob.mime,
            thumbnailUrl: `/data/thumbs/${thumbName}`,
            storageUrl: `/data/photos/${newAiJob.storageName}`,
            capturedAt: newAiJob.capturedAt,
            location: newAiJob.location,
            tags: ai.tags,
            aiCaption: ai.caption,
            ai: aiEvidence,
            locationResolution: resolveImportedLocation({ location: newAiJob.location, aiEvidence, pendingReason: photoPendingReason }),
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
            importedBatchId: batchId,
            pendingReason: photoPendingReason,
            exifStatus: {
              time: newAiJob.hasExifTime ? "read" : "fallback",
              gps: newAiJob.hasExifLocation ? "read" : "missing",
            },
          };
          if (Array.isArray(embedding.embedding)) vectorIndex[photo.id] = embedding.embedding;
          importedSlots[newAiJob.index] = photo;
        }),
      );
    });

    await Promise.all(downstreamTasks);
    imported.push(...importedSlots.filter(Boolean));

    progress.update?.({ phase: "grouping", done: files.length, total: files.length });
    const nextState = buildImportStateFromPhotos(state, {
      batchId,
      totalCount: files.length,
      photos: imported,
      duplicateCount: duplicateNames.length,
      duplicatePhotoIds: Array.from(duplicatePhotoIds),
      duplicateNames,
      makeId,
      now,
      locale,
      aiStats,
      storedFileNames: imported.map((photo) => path.basename(photo.storageUrl)),
      storedThumbnailNames: imported.map((photo) => path.basename(photo.thumbnailUrl)),
      completeCandidatePoint,
    });
    await writeVectorIndex(vectorIndex);
    await writeState(nextState);
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
      const success = Array.isArray(embedding.embedding) && embedding.embedding.length > 0 && embedding.embeddingMode === "cross_modal";
      if (success) {
        nextVectorIndex[photo.id] = embedding.embedding;
        succeeded.push(photo.id);
      } else {
        delete nextVectorIndex[photo.id];
        failed.push({
          id: photo.id,
          fileName: photo.fileName,
          reason: embedding.embeddingFallbackReason || "向量模型未返回可用 embedding。",
        });
      }
      done += 1;
      progress.update?.({ phase: "embedding", done, total, currentFileName: photo.fileName });
      return {
        ...photo,
        embeddingProvider: embedding.embeddingProvider,
        embeddingModel: embedding.embeddingModel,
        embeddingSpaceId: embedding.embeddingSpaceId,
        embeddingDimension: embedding.embeddingDimension ?? embedding.embedding?.length,
        embeddingMode: embedding.embeddingMode,
        embeddingFallbackReason: embedding.embeddingFallbackReason,
      };
    });
    const rebuiltById = new Map(rebuiltPhotos.map((photo) => [photo.id, photo]));
    await writeVectorIndex(nextVectorIndex);
    const nextState = {
      ...state,
      photos: safeArray(state.photos).map((photo) => rebuiltById.get(photo.id) ?? photo),
    };
    await writeState({
      ...nextState,
    });
    progress.update?.({ phase: "completed", done: total, total });
    return {
      ...(await responseState()),
      embeddingRebuild: {
        total,
        successCount: succeeded.length,
        failedCount: failed.length,
        failedPhotoIds: failed.map((item) => item.id),
        failures: failed,
        mode: requestedPhotoIds.size ? "retry_failed" : "all",
      },
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
    const batch = state.importBatches.find((item) => item.id === id);
    if (!batch || batch.status !== "pending_confirmation") return responseState();
    const openMissingItems = state.pendingItems.filter(
      (item) =>
        batch.pendingItemIds.includes(item.id) &&
        item.status === "open" &&
        ["missing_gps", "missing_time", "confirm_location_candidate", "ai_processing_failed"].includes(item.type),
    );
    if (openMissingItems.length) throw new Error("仍有待补信息或 AI 初次处理失败照片未处理，不能确认导入。");
    await writeState({
      ...state,
      trips: state.trips.map((trip) => (batch.createdTripIds.includes(trip.id) ? { ...trip, status: "confirmed" } : trip)),
      importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "confirmed" } : item)),
    });
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
    const nextPending = applyMissingInfoProposal(latestPending, proposal);
    await writeState({
      ...latestState,
      pendingItems: latestState.pendingItems.map((item) => (item.id === latestPending.id ? nextPending : item)),
    });
    return responseState();
  }

  async function inferPendingLocationsBatch({ batchId, pendingIds, locale: rawLocale }, progress = {}) {
    const state = await readState();
    const locale = normalizeLocale(rawLocale);
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") return responseState();
    const requestedIds = new Set(safeArray(pendingIds).map(String));
    const items = state.pendingItems.filter(
      (item) =>
        batch.pendingItemIds.includes(item.id) &&
        item.status === "open" &&
        ["missing_gps", "confirm_location_candidate"].includes(item.type) &&
        requestedIds.has(item.id),
    );
    const total = items.length;
    let done = 0;
    progress.update?.({ phase: "ai", done, total });
    const results = await mapConcurrent(items, missingInferenceConcurrency, async (pending) => {
      const photo = state.photos.find((item) => pending.relatedPhotoIds.includes(item.id));
      try {
        const proposal = await buildMissingInfoInferenceProposal(state, batch, pending, { locale });
        return { pendingId: pending.id, proposal };
      } catch (error) {
        return {
          pendingId: pending.id,
          proposal: keepPending(error instanceof Error ? error.message : missingInferenceText(locale, "secondInferenceFailed"), 0, locale),
        };
      } finally {
        done += 1;
        progress.update?.({ phase: "ai", done, total, currentFileName: photo?.fileName });
      }
    });
    const proposalByPendingId = new Map(results.map((item) => [item.pendingId, item.proposal]));
    const latestState = await readState();
    const latestBatch = latestState.importBatches.find((item) => item.id === batchId);
    if (!latestBatch || latestBatch.status !== "pending_confirmation") return responseState();
    await writeState({
      ...latestState,
      pendingItems: latestState.pendingItems.map((item) => {
        const proposal = proposalByPendingId.get(item.id);
        if (!proposal || !latestBatch.pendingItemIds.includes(item.id) || item.status !== "open") return item;
        if (!["missing_gps", "confirm_location_candidate"].includes(item.type)) return item;
        return applyMissingInfoProposal(item, proposal);
      }),
    });
    progress.update?.({ phase: "completed", done: total, total });
    return responseState();
  }

  function applyMissingInfoProposal(pending, proposal) {
    return {
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
        updatedAt: new Date().toISOString(),
      },
    };
  }

  async function rollbackImport(id) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === id);
    const latestPending = state.importBatches.filter((item) => item.status === "pending_confirmation").at(-1);
    if (!batch || batch.id !== latestPending?.id) throw new Error("MVP 只支持回撤最近一次待确认导入。");
    const photoIds = new Set(batch.addedPhotoIds);
    const tripIds = new Set(batch.createdTripIds);
    const affectedExistingTripIds = new Set(safeArray(batch.updatedTripIds));
    const pendingIds = new Set(batch.pendingItemIds);
    for (const name of safeArray(batch.storedFileNames)) {
      await fs.rm(path.join(paths.photoDir, path.basename(name)), { force: true });
    }
    for (const name of safeArray(batch.storedThumbnailNames)) {
      await fs.rm(path.join(paths.thumbDir, path.basename(name)), { force: true });
    }
    const vectorIndex = await readVectorIndex();
    for (const id of photoIds) delete vectorIndex[id];
    await writeVectorIndex(vectorIndex);
    const base = {
      ...state,
      photos: state.photos.filter((photo) => !photoIds.has(photo.id)),
      trips: state.trips.filter((trip) => !tripIds.has(trip.id)),
      placeNodes: state.placeNodes.filter((place) => !tripIds.has(place.tripId)),
      routes: state.routes.filter((route) => !tripIds.has(route.tripId)),
      pendingItems: state.pendingItems.filter((item) => !pendingIds.has(item.id)),
      importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "rolled_back" } : item)),
    };
    await writeState(rebuildTrips(base, affectedExistingTripIds, { makeId }));
    return responseState();
  }

  async function cancelImportPhotos(batchId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const latestPending = state.importBatches.filter((item) => item.status === "pending_confirmation").at(-1);
    if (!batch || batch.id !== latestPending?.id) throw new Error("只能从最近一次待确认导入中取消照片。");
    const requested = new Set(safeArray(body.photoIds));
    const batchPhotoIds = new Set(batch.addedPhotoIds);
    const cancelIds = new Set([...requested].filter((id) => batchPhotoIds.has(id)));
    if (cancelIds.size === 0) return responseState();

    const cancelPhotos = state.photos.filter((photo) => cancelIds.has(photo.id));
    for (const photo of cancelPhotos) {
      if (photo.storageUrl) await fs.rm(path.join(paths.photoDir, path.basename(photo.storageUrl)), { force: true });
      if (photo.thumbnailUrl) await fs.rm(path.join(paths.thumbDir, path.basename(photo.thumbnailUrl)), { force: true });
    }

    const affectedTripIds = new Set(cancelPhotos.map((photo) => photo.tripId).filter(Boolean));
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
      .filter((item) => !batch.pendingItemIds.includes(item.id) || item.relatedPhotoIds.length > 0);
    const pendingIds = new Set(pendingItems.filter((item) => batch.pendingItemIds.includes(item.id)).map((item) => item.id));

    const vectorIndex = await readVectorIndex();
    for (const id of cancelIds) delete vectorIndex[id];
    await writeVectorIndex(vectorIndex);

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
      storedFileNames: safeArray(batch.storedFileNames).filter((name) => !cancelPhotos.some((photo) => path.basename(photo.storageUrl ?? "") === path.basename(name))),
      storedThumbnailNames: safeArray(batch.storedThumbnailNames).filter((name) => !cancelPhotos.some((photo) => path.basename(photo.thumbnailUrl ?? "") === path.basename(name))),
      status: remainingAddedPhotoIds.length > 0 ? batch.status : "rolled_back",
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
    await writeState(rebuildTrips(base, affectedTripIds, { makeId }));
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
    const requestedIds = new Set(safeArray(pendingIds).map(String));
    const items = state.pendingItems
      .filter((pending) => pending.status === "open" && pending.type === "ai_processing_failed" && batch.pendingItemIds.includes(pending.id) && requestedIds.has(pending.id))
      .map((pending) => ({
        pending,
        photo: state.photos.find((photo) => pending.relatedPhotoIds?.includes(photo.id)),
      }))
      .filter((item) => Boolean(item.photo));
    const total = items.length;
    let done = 0;
    progress.update?.({ phase: "ai", done, total });
    const results = await mapConcurrent(items, aiConcurrency, async ({ pending, photo }) => {
      try {
        const retry = await buildRetryImportAiFailureResult(state, batch, pending, photo, action, { locale });
        return { pendingId: pending.id, photoId: photo.id, retry };
      } catch (error) {
        return { pendingId: pending.id, photoId: photo.id, error: error instanceof Error ? error.message : "AI Vision 重跑失败。" };
      } finally {
        done += 1;
        progress.update?.({ phase: "ai", done, total, currentFileName: photo?.fileName });
      }
    });

    const latestState = await readState();
    const latestBatch = latestState.importBatches.find((item) => item.id === batchId);
    if (!latestBatch || latestBatch.status !== "pending_confirmation") return responseState();

    let nextState = latestState;
    const vectorIndex = await readVectorIndex();
    const affectedTripIds = new Set([...latestBatch.createdTripIds, ...(latestBatch.updatedTripIds ?? [])].filter(Boolean));
    const resultByPendingId = new Map(results.map((item) => [item.pendingId, item]));
    nextState = {
      ...nextState,
      photos: nextState.photos.map((photo) => {
        const pending = nextState.pendingItems.find((item) => item.status === "open" && item.type === "ai_processing_failed" && latestBatch.pendingItemIds.includes(item.id) && item.relatedPhotoIds?.includes(photo.id));
        const result = pending ? resultByPendingId.get(pending.id) : undefined;
        if (!result?.retry) return photo;
        if (photo.tripId) affectedTripIds.add(photo.tripId);
        if (result.retry.retryEmbedding && Array.isArray(result.retry.embedding.embedding)) vectorIndex[photo.id] = result.retry.embedding.embedding;
        else if (result.retry.retryEmbedding) delete vectorIndex[photo.id];
        return result.retry.patchedPhoto;
      }),
      pendingItems: nextState.pendingItems.map((pending) => {
        const result = resultByPendingId.get(pending.id);
        if (!result || !latestBatch.pendingItemIds.includes(pending.id) || pending.status !== "open" || pending.type !== "ai_processing_failed") return pending;
        if (result.error) return { ...pending, reason: result.error, suggestion: "初次导入 AI 重跑失败，需要重新选择处理方式。" };
        if (!result.retry) return pending;
        return result.retry.failed
          ? { ...pending, reason: failureReasonText(result.retry.patchedPhoto), suggestion: `${result.retry.patchedPhoto.title ?? result.retry.patchedPhoto.fileName} 初次导入 AI 仍处理失败，需要重新选择处理方式。` }
          : { ...pending, status: "accepted" };
      }),
    };
    await writeVectorIndex(vectorIndex);
    for (const result of results) {
      if (!result.retry || result.retry.failed) continue;
      const currentBatch = nextState.importBatches.find((item) => item.id === batchId) ?? latestBatch;
      nextState = appendMissingInfoPendingIfNeeded(nextState, currentBatch, result.retry.patchedPhoto);
    }
    await writeState(rebuildTrips(nextState, affectedTripIds, { makeId, allowExistingPlaceMerge: true }));
    progress.update?.({ phase: "completed", done: total, total });
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
    const imagePayload = await readPhotoImagePayload(photo);
    if (!imagePayload) throw new Error("找不到原图，无法重跑初次导入 AI。");
    const retryVision = action === "retry_vision" || action === "retry_both";
    const retryEmbedding = action === "retry_embedding" || action === "retry_both";
    let ai = photo.ai
      ? {
          provider: photo.aiProvider ?? photo.ai.provider,
          promptId: photo.ai.promptId,
          promptVersion: photo.ai.promptVersion,
          model: photo.aiModel ?? photo.ai.model,
          title: photo.title,
          tags: photo.tags ?? [],
          caption: photo.aiCaption,
          visiblePlaceNames: photo.ai.visiblePlaceNames ?? [],
          locationCandidates: photo.ai.locationCandidates ?? [],
          uncertainties: photo.ai.uncertainties ?? [],
          fallbackReason: photo.aiFallbackReason,
        }
      : undefined;
    let embedding = {
      embedding: undefined,
      embeddingProvider: photo.embeddingProvider,
      embeddingModel: photo.embeddingModel,
      embeddingSpaceId: photo.embeddingSpaceId,
      embeddingDimension: photo.embeddingDimension,
      embeddingMode: photo.embeddingMode,
      embeddingFallbackReason: photo.embeddingFallbackReason,
    };
    if (retryVision) {
      ai = await analyzePhotoVision({
        fileName: photo.fileName,
        mime: imagePayload.mime,
        dataUrl: imagePayload.dataUrl,
        preset: inferPreset(photo.fileName, photo.location),
        location: photo.location,
        allowCloud: true,
        locale,
      });
    }
    if (!ai) throw new Error("照片缺少可用的初次导入分析结果。");
    if (retryEmbedding) {
      embedding = await embedPhotoImage({
        fileName: photo.fileName,
        mime: imagePayload.mime,
        dataUrl: imagePayload.dataUrl,
        allowCloud: true,
      });
    }

    const nextFailure = {
      vision: retryVision ? ai.fallbackReason : photo.aiFailure?.vision,
      embedding: retryEmbedding ? embeddingFailureReason(embedding) : photo.aiFailure?.embedding,
      hasRealExifGps: photo.exifStatus?.gps === "read" && isUsableLocation(photo.location),
      hasRealExifTime: photo.exifStatus?.time === "read",
      updatedAt: new Date().toISOString(),
    };
    const failed = Boolean(nextFailure.vision || nextFailure.embedding);
    const aiEvidenceBase = toAiEvidence(ai, { makeId });
    const aiEvidence = withBackendLocationCandidates({ location: photo.location, aiEvidence: aiEvidenceBase, locale });
    const patchedPhoto = {
      ...photo,
      title: ai.title || makePhotoTitle({ fileName: photo.fileName, tags: ai.tags, aiCaption: ai.caption }),
      tags: ai.tags,
      aiCaption: ai.caption,
      ai: aiEvidence,
      locationResolution: resolveImportedLocation({ location: photo.location, aiEvidence, pendingReason: failed ? "ai_processing_failed" : pendingReasonFromExif(photo) }),
      aiProvider: ai.provider,
      aiModel: ai.model,
      aiFallbackReason: ai.fallbackReason,
      embeddingProvider: retryEmbedding ? embedding.embeddingProvider : photo.embeddingProvider,
      embeddingModel: retryEmbedding ? embedding.embeddingModel : photo.embeddingModel,
      embeddingSpaceId: retryEmbedding ? embedding.embeddingSpaceId : photo.embeddingSpaceId,
      embeddingDimension: retryEmbedding ? embedding.embeddingDimension ?? embedding.embedding?.length : photo.embeddingDimension,
      embeddingMode: retryEmbedding ? embedding.embeddingMode : photo.embeddingMode,
      embeddingFallbackReason: retryEmbedding ? embedding.embeddingFallbackReason : photo.embeddingFallbackReason,
      aiFailure: failed ? nextFailure : undefined,
      pendingReason: failed ? "ai_processing_failed" : pendingReasonFromExif(photo),
    };

    return { patchedPhoto, embedding, failed, retryEmbedding };
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

  function pendingReasonFromExif(photo) {
    if (photo.exifStatus?.gps === "missing" || !isUsableLocation(photo.location)) return "missing_gps";
    if (photo.exifStatus?.time !== "read") return "missing_time";
    return undefined;
  }

  function clearAiFailureForPhoto(photo) {
    const aiEvidence = withBackendLocationCandidates({ location: photo.location, aiEvidence: photo.ai });
    return {
      ...photo,
      aiFailure: undefined,
      pendingReason: pendingReasonFromExif(photo),
      ai: aiEvidence,
      locationResolution: resolveImportedLocation({ location: photo.location, aiEvidence, pendingReason: pendingReasonFromExif(photo) }),
    };
  }

  function appendMissingInfoPendingIfNeeded(state, batch, photo) {
    if (hasAiProcessingFailure(photo) || !hasMissingImportInfo(photo)) return state;
    const alreadyOpen = state.pendingItems.some(
      (item) => item.status === "open" && batch.pendingItemIds.includes(item.id) && ["missing_gps", "missing_time", "confirm_location_candidate"].includes(item.type) && item.relatedPhotoIds?.includes(photo.id),
    );
    if (alreadyOpen) return state;
    const nextItems = [];
    addLocationPendingItems([photo], nextItems, { makeId, completeCandidatePoint });
    addMissingInfoPendingItems([photo], nextItems, { makeId });
    if (!nextItems.length) return state;
    return {
      ...state,
      pendingItems: [...state.pendingItems, ...nextItems],
      importBatches: state.importBatches.map((item) => (item.id === batch.id ? { ...item, pendingItemIds: [...item.pendingItemIds, ...nextItems.map((pendingItem) => pendingItem.id)] } : item)),
    };
  }

  function failureReasonText(photo) {
    return [
      photo.aiFailure?.hasRealExifGps ? "真实GPS" : "无GPS",
      photo.aiFailure?.vision ? `AI Vision：${photo.aiFailure.vision}` : undefined,
      photo.aiFailure?.embedding ? `Embedding：${photo.aiFailure.embedding}` : undefined,
    ]
      .filter(Boolean)
      .join("。");
  }

  function rebuildTripsForImportedPhoto(state, photo, batch, options = {}) {
    const affectedTripIds = new Set([photo.tripId, ...batch.createdTripIds, ...(batch.updatedTripIds ?? [])].filter(Boolean));
    return rebuildTrips(state, affectedTripIds, { makeId, ...options });
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

  function recordVisionStats(ai, aiStats) {
    if (ai.provider === "qwen" || ai.provider === "aliyun") aiStats.qwenCount += 1;
    else aiStats.fallbackCount += 1;
  }

  function recordEmbeddingStats(ai, aiStats) {
    if (Array.isArray(ai.embedding) && ai.embedding.length > 0) aiStats.embeddingCount += 1;
    if (ai.embeddingProvider === "qwen" || ai.embeddingProvider === "aliyun") aiStats.qwenEmbeddingCount += 1;
    else if (ai.embeddingMode !== "cross_modal") aiStats.deterministicEmbeddingCount += 1;
  }

  function embeddingFailureReason(embedding) {
    if (!embedding) return undefined;
    if (embedding.embeddingMode !== "failed") return undefined;
    return embedding.embeddingFallbackReason || "Embedding 未返回可用向量。";
  }

  function buildAiFailure(ai, embedding, job) {
    const vision = ai?.fallbackReason;
    const embeddingFailure = embeddingFailureReason(embedding);
    if (!vision && !embeddingFailure) return undefined;
    return {
      vision,
      embedding: embeddingFailure,
      hasRealExifGps: Boolean(job.hasExifLocation),
      hasRealExifTime: Boolean(job.hasExifTime),
      updatedAt: new Date().toISOString(),
    };
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
    if (!photo.storageUrl) return undefined;
    const fileName = path.basename(photo.storageUrl);
    const fullPath = path.join(paths.photoDir, fileName);
    const ext = path.extname(fileName).toLowerCase();
    const mime = photo.mime || (ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".heic" ? "image/heic" : "image/jpeg");
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
      city: candidate.city ?? fallback.city ?? cityQuery,
      country: candidate.country ?? fallback.country,
      localizedNames: candidate.localizedNames ?? fallback.localizedNames,
      localizedCountryNames: candidate.localizedCountryNames ?? fallback.localizedCountryNames,
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
      city: candidate.city ?? fallback.city ?? cityQuery,
      country: candidate.country ?? fallback.country,
      localizedNames: candidate.localizedNames ?? fallback.localizedNames,
      localizedCountryNames: candidate.localizedCountryNames ?? fallback.localizedCountryNames,
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

import { createLimiter, mapConcurrent } from "../application/import-pipeline.mjs";
import { safeArray } from "../domain/arrays.mjs";
import { inferPreset, isUsableLocation, normalizeLocale } from "../domain/geo.mjs";
import { resolveImportedLocation, toAiEvidence } from "../domain/location-resolver.mjs";
import { makePhotoTitle } from "../domain/text-normalizer.mjs";
import { rebuildTrips } from "../domain/trip-rebuilder.mjs";
import { applyMissingInfoProposalResultsState, keepPending, missingInferenceText } from "./missing-info-inference-core.mjs";
import { buildAiFailure, buildRetryAiFailure, failureReasonText, pendingReasonFromExif } from "./import-photo-core.mjs";
import { buildImportStateFromPhotos } from "./import-state-core.mjs";

export function createImportAiStats() {
  return {
    qwenCount: 0,
    fallbackCount: 0,
    embeddingCount: 0,
    qwenEmbeddingCount: 0,
    deterministicEmbeddingCount: 0,
  };
}

export function recordImportVisionStats(ai, aiStats) {
  if (ai?.provider === "qwen" || ai?.provider === "aliyun") aiStats.qwenCount += 1;
  else aiStats.fallbackCount += 1;
}

export function recordImportEmbeddingStats(embedding, aiStats) {
  if (Array.isArray(embedding?.embedding) && embedding.embedding.length > 0) aiStats.embeddingCount += 1;
  if (embedding?.embeddingProvider === "qwen" || embedding?.embeddingProvider === "aliyun") aiStats.qwenEmbeddingCount += 1;
  else if (embedding?.embeddingMode !== "cross_modal") aiStats.deterministicEmbeddingCount += 1;
}

export async function runInitialImportPipeline({
  items,
  state,
  vectorIndex,
  now = new Date(),
  locale: rawLocale = "zh",
  makeId,
  allowCloud = true,
  reanalyzeDuplicates = false,
  concurrency,
  progress = {},
  adapter,
}) {
  const locale = normalizeLocale(rawLocale);
  const total = items.length;
  const batchId = makeId("batch");
  const aiStats = adapter.createAiStats?.() ?? createImportAiStats();
  const knownHashToPhoto = new Map(state.photos.filter((photo) => photo.originalHash).map((photo) => [photo.originalHash, photo]));
  const knownHashes = new Set(knownHashToPhoto.keys());
  const duplicatePhotoIds = new Set();
  const duplicateNames = [];
  const importedSlots = new Array(total);
  const downstreamTasks = [];
  const counters = { reading: 0, exif: 0, thumbnails: 0, ai: 0, embedding: 0 };

  const emit = (phase, done, currentFileName) => {
    progress.update?.(adapter.progress?.({ phase, done, total, currentFileName, counters }) ?? { phase, done, total, currentFileName });
  };

  for (const phase of adapter.initialPhases ?? ["exif", "thumbnails", "ai", "embedding"]) {
    emit(phase, 0);
  }

  const markDone = (phase, fileName) => {
    counters[phase] += 1;
    emit(phase, counters[phase], fileName);
  };
  const markAllDone = (fileName) => {
    for (const phase of ["reading", "exif", "thumbnails", "ai", "embedding"]) {
      if (adapter.countsPhase?.(phase) === false) continue;
      markDone(phase, fileName);
    }
  };

  const storageLimit = createLimiter(concurrency.storageWrite);
  const visionLimit = createLimiter(concurrency.ai);
  const embeddingLimit = createLimiter(concurrency.embedding);

  await mapConcurrent(items, concurrency.metadata, async (item, index) => {
    const fallbackFileName = adapter.itemFileName?.(item, index) ?? `photo-${index + 1}`;
    if (adapter.countsPhase?.("reading") === false) emit("exif", counters.exif, fallbackFileName);
    else emit("reading", counters.reading, fallbackFileName);

    let prepared;
    try {
      prepared = await adapter.prepareItem(item, index, { fallbackFileName, now, total, locale, allowCloud });
    } catch (error) {
      if (!adapter.skipPrepareErrors) throw error;
      adapter.onPrepareError?.(error, item, { index, fileName: fallbackFileName });
      markAllDone(fallbackFileName);
      return;
    }

    const fileName = prepared.fileName || fallbackFileName;
    if (adapter.countsPhase?.("reading") !== false) markDone("reading", fileName);
    markDone("exif", fileName);

    const originalHash = prepared.originalHash;
    if (knownHashes.has(originalHash)) {
      duplicateNames.push(fileName);
      const duplicatePhoto = knownHashToPhoto.get(originalHash);
      if (duplicatePhoto?.id) duplicatePhotoIds.add(duplicatePhoto.id);
      markDone("thumbnails", fileName);
      if (reanalyzeDuplicates && duplicatePhoto && adapter.reanalyzeDuplicate !== false) {
        const parsedLocation = isUsableLocation(prepared.location) ? prepared.location : duplicatePhoto.location;
        const aiImagePayload = adapter.createAiImagePayload?.(prepared, { duplicatePhoto }) ?? Promise.resolve(undefined);
        downstreamTasks.push(
          Promise.all([
            visionLimit(async () => {
              const imagePayload = await aiImagePayload;
              const ai = await adapter.analyzeVision({
                prepared,
                fileName,
                mime: imagePayload?.mime ?? prepared.mime,
                dataUrl: imagePayload?.dataUrl,
                preset: inferPreset(fileName, parsedLocation),
                location: parsedLocation,
                allowCloud,
                locale,
              });
              (adapter.recordVisionStats ?? recordImportVisionStats)(ai, aiStats);
              markDone("ai", fileName);
              return ai;
            }),
            embeddingLimit(async () => {
              const imagePayload = await aiImagePayload;
              const embedding = await adapter.embedImage({
                prepared,
                fileName,
                mime: imagePayload?.mime ?? prepared.mime,
                dataUrl: imagePayload?.dataUrl,
                allowCloud,
              });
              (adapter.recordEmbeddingStats ?? recordImportEmbeddingStats)(embedding, aiStats);
              markDone("embedding", fileName);
              return embedding;
            }),
          ]).then(([ai, embedding]) =>
            adapter.applyDuplicateAnalysis?.({
              duplicatePhoto,
              prepared,
              parsedLocation,
              ai,
              embedding,
              vectorIndex,
              makeId,
              locale,
            }),
          ),
        );
      } else {
        markDone("ai", fileName);
        markDone("embedding", fileName);
      }
      await adapter.onDuplicateComplete?.(prepared, duplicatePhoto);
      return;
    }

    knownHashes.add(originalHash);
    const photoId = makeId("photo");
    const storageName = adapter.storageName?.(prepared, { photoId }) ?? `${photoId}${prepared.ext ?? ""}`;
    const location = isUsableLocation(prepared.location) ? prepared.location : undefined;
    const capturedAt = adapter.capturedAt?.(prepared, { now, total, index }) ?? prepared.capturedAt;
    const pendingReason = !location ? "missing_gps" : !prepared.capturedAt ? "missing_time" : undefined;
    const job = {
      type: "new",
      index,
      photoId,
      batchId,
      fileName,
      storageName,
      originalHash,
      mime: prepared.mime,
      ext: prepared.ext,
      prepared,
      preset: inferPreset(fileName, location),
      location,
      capturedAt,
      pendingReason,
      hasExifLocation: Boolean(location),
      hasExifTime: Boolean(prepared.capturedAt),
    };
    const aiImagePayload = adapter.createAiImagePayload?.(prepared, job) ?? Promise.resolve(undefined);
    downstreamTasks.push(
      Promise.all([
        storageLimit(async () => {
          const thumbnail = await adapter.storeOriginalAndThumbnail(prepared, job);
          markDone("thumbnails", fileName);
          return thumbnail;
        }),
        visionLimit(async () => {
          const imagePayload = await aiImagePayload;
          const ai = await adapter.analyzeVision({
            prepared,
            job,
            fileName,
            mime: imagePayload?.mime ?? prepared.mime,
            dataUrl: imagePayload?.dataUrl,
            preset: job.preset,
            location,
            allowCloud,
            locale,
          });
          (adapter.recordVisionStats ?? recordImportVisionStats)(ai, aiStats);
          markDone("ai", fileName);
          return ai;
        }),
        embeddingLimit(async () => {
          const imagePayload = await aiImagePayload;
          const embedding = await adapter.embedImage({
            prepared,
            job,
            fileName,
            mime: imagePayload?.mime ?? prepared.mime,
            dataUrl: imagePayload?.dataUrl,
            allowCloud,
          });
          (adapter.recordEmbeddingStats ?? recordImportEmbeddingStats)(embedding, aiStats);
          markDone("embedding", fileName);
          return embedding;
        }),
      ]).then(async ([thumbnail, ai, embedding]) => {
        const resolvedAiImagePayload = await aiImagePayload;
        const aiFailure = buildAiFailure(ai, embedding, {
          ...job,
          thumbName: adapter.thumbnailName?.(thumbnail, job),
        });
        const photoPendingReason = aiFailure ? "ai_processing_failed" : job.pendingReason;
        const aiEvidenceBase = toAiEvidence(ai, { makeId });
        const aiEvidence = await adapter.withLocationCandidates({ location: job.location, aiEvidence: aiEvidenceBase, locale });
        const photo =
          adapter.buildNewPhoto?.({
            job,
            prepared,
            thumbnail,
            ai,
            embedding,
            aiFailure,
            aiEvidence,
            photoPendingReason,
            aiImagePayload: resolvedAiImagePayload,
            makeId,
            locale,
          }) ??
          buildDefaultImportedPhoto({
            job,
            thumbnail,
            ai,
            embedding,
            aiFailure,
            aiEvidence,
            photoPendingReason,
            aiImagePayload: resolvedAiImagePayload,
          });
        if (Array.isArray(embedding?.embedding)) vectorIndex[photo.id] = embedding.embedding;
        importedSlots[index] = photo;
      }),
    );
  });

  await Promise.all(downstreamTasks);
  const photos = importedSlots.filter(Boolean);
  emit("grouping", total);
  const nextState = buildImportStateFromPhotos(state, {
    batchId,
    totalCount: total,
    photos,
    duplicateCount: adapter.duplicateCount?.({ duplicatePhotoIds, duplicateNames }) ?? duplicateNames.length,
    duplicatePhotoIds: Array.from(duplicatePhotoIds),
    duplicateNames,
    makeId,
    now,
    locale,
    aiStats,
    ...(adapter.buildStateOptions?.({ photos, duplicatePhotoIds, duplicateNames, aiStats, batchId }) ?? {}),
  });
  return { state: nextState, vectorIndex, aiStats, importedPhotos: photos, duplicatePhotoIds, duplicateNames, batchId };
}

function buildDefaultImportedPhoto({ job, thumbnail, ai, embedding, aiFailure, aiEvidence, photoPendingReason, aiImagePayload }) {
  return {
    id: job.photoId,
    fileName: job.fileName || job.storageName,
    title: ai.title || makePhotoTitle({ fileName: job.fileName || job.storageName, tags: ai.tags, aiCaption: ai.caption }),
    originalHash: job.originalHash,
    mime: job.mime,
    thumbnailUrl: thumbnail?.url ?? thumbnail,
    aiInputUrl: aiImagePayload?.url ?? thumbnail?.aiInputUrl,
    displayUrl: thumbnail?.displayUrl,
    storageUrl: job.storageUrl,
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
  };
}

export async function runMissingInferenceBatchCore({
  state,
  batchId,
  pendingIds,
  locale: rawLocale = "zh",
  concurrency,
  progress = {},
  buildProposal,
  now = () => new Date().toISOString(),
  emitCompleted = true,
}) {
  const locale = normalizeLocale(rawLocale);
  const batch = state.importBatches.find((item) => item.id === batchId);
  if (!batch || batch.status !== "pending_confirmation") return { state, total: 0 };
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
  const results = await mapConcurrent(items, concurrency, async (pending) => {
    const photo = state.photos.find((item) => pending.relatedPhotoIds.includes(item.id));
    try {
      const proposal = await buildProposal(state, batch, pending, { locale });
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
  const nextState = applyMissingInfoProposalResultsState(state, batchId, results, { now });
  if (emitCompleted) progress.update?.({ phase: "completed", done: total, total });
  return { state: nextState, total, results };
}

export async function buildRetryImportAiFailureResultCore({
  photo,
  action,
  locale = "zh",
  makeId,
  readPhotoImagePayload,
  analyzeVision,
  embedImage,
  withLocationCandidates = ({ aiEvidence }) => aiEvidence,
}) {
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
    ai = await analyzeVision({
      fileName: photo.fileName,
      mime: imagePayload.mime,
      dataUrl: imagePayload.dataUrl,
      preset: inferPreset(photo.fileName, photo.location),
      location: photo.location,
      allowCloud: true,
      locale,
      photo,
    });
  }
  if (!ai) throw new Error("照片缺少可用的初次导入分析结果。");
  if (retryEmbedding) {
    embedding = await embedImage({
      fileName: photo.fileName,
      mime: imagePayload.mime,
      dataUrl: imagePayload.dataUrl,
      allowCloud: true,
      photo,
    });
  }

  const nextFailure = buildRetryAiFailure(photo, { retryVision, retryEmbedding, ai, embedding });
  const failed = Boolean(nextFailure);
  const aiEvidenceBase = toAiEvidence(ai, { makeId });
  const aiEvidence = await withLocationCandidates({ location: photo.location, aiEvidence: aiEvidenceBase, locale });
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

export async function runImportAiFailuresBatchCore({
  state,
  vectorIndex,
  batchId,
  pendingIds,
  action = "retry_vision",
  locale = "zh",
  concurrency,
  progress = {},
  buildRetryResult,
  appendMissingInfoPendingIfNeeded,
  makeId,
  emitCompleted = true,
  applyState = true,
}) {
  const batch = state.importBatches.find((item) => item.id === batchId);
  if (!batch || batch.status !== "pending_confirmation") return { state, vectorIndex, total: 0 };
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
  const results = await mapConcurrent(items, concurrency, async ({ pending, photo }) => {
    try {
      const retry = await buildRetryResult(state, batch, pending, photo, action, { locale });
      return { pendingId: pending.id, photoId: photo.id, retry };
    } catch (error) {
      return { pendingId: pending.id, photoId: photo.id, error: error instanceof Error ? error.message : "AI Vision 重跑失败。" };
    } finally {
      done += 1;
      progress.update?.({ phase: "ai", done, total, currentFileName: photo?.fileName });
    }
  });

  if (!applyState) {
    if (emitCompleted) progress.update?.({ phase: "completed", done: total, total });
    return { state, vectorIndex, total, results };
  }
  const applied = applyImportAiFailureRetryResultsCore({
    state,
    vectorIndex,
    batchId,
    results,
    appendMissingInfoPendingIfNeeded,
    makeId,
  });
  if (emitCompleted) progress.update?.({ phase: "completed", done: total, total });
  return { ...applied, total, results };
}

export function applyImportAiFailureRetryResultsCore({
  state,
  vectorIndex,
  batchId,
  results,
  appendMissingInfoPendingIfNeeded,
  makeId,
}) {
  const batch = state.importBatches.find((item) => item.id === batchId);
  if (!batch || batch.status !== "pending_confirmation") return { state, vectorIndex };
  let nextState = state;
  const affectedTripIds = new Set([...batch.createdTripIds, ...(batch.updatedTripIds ?? [])].filter(Boolean));
  const resultByPendingId = new Map(results.map((item) => [item.pendingId, item]));
  nextState = {
    ...nextState,
    photos: nextState.photos.map((photo) => {
      const pending = nextState.pendingItems.find((item) => item.status === "open" && item.type === "ai_processing_failed" && batch.pendingItemIds.includes(item.id) && item.relatedPhotoIds?.includes(photo.id));
      const result = pending ? resultByPendingId.get(pending.id) : undefined;
      if (!result?.retry) return photo;
      if (photo.tripId) affectedTripIds.add(photo.tripId);
      if (result.retry.retryEmbedding && Array.isArray(result.retry.embedding.embedding)) vectorIndex[photo.id] = result.retry.embedding.embedding;
      else if (result.retry.retryEmbedding) delete vectorIndex[photo.id];
      return result.retry.patchedPhoto;
    }),
    pendingItems: nextState.pendingItems.map((pending) => {
      const result = resultByPendingId.get(pending.id);
      if (!result || !batch.pendingItemIds.includes(pending.id) || pending.status !== "open" || pending.type !== "ai_processing_failed") return pending;
      if (result.error) return { ...pending, reason: result.error, suggestion: "初次导入 AI 重跑失败，需要重新选择处理方式。" };
      if (!result.retry) return pending;
      return result.retry.failed
        ? { ...pending, reason: failureReasonText(result.retry.patchedPhoto), suggestion: `${result.retry.patchedPhoto.title ?? result.retry.patchedPhoto.fileName} 初次导入 AI 仍处理失败，需要重新选择处理方式。` }
        : { ...pending, status: "accepted" };
    }),
  };
  for (const result of results) {
    if (!result.retry || result.retry.failed) continue;
    const currentBatch = nextState.importBatches.find((item) => item.id === batchId) ?? batch;
    nextState = appendMissingInfoPendingIfNeeded(nextState, currentBatch, result.retry.patchedPhoto);
  }
  nextState = rebuildTrips(nextState, affectedTripIds, { makeId, allowExistingPlaceMerge: true });
  return { state: nextState, vectorIndex };
}

import { safeArray } from "../domain/arrays.mjs";
import { isUsableLocation } from "../domain/geo.mjs";
import { resolveImportedLocation } from "../domain/location-resolver.mjs";

function resolveNow(now) {
  if (typeof now === "function") return now();
  return now ?? new Date().toISOString();
}

export function importExifStatus({ hasExifTime, hasExifLocation }) {
  return {
    time: hasExifTime ? "read" : "fallback",
    gps: hasExifLocation ? "read" : "missing",
  };
}

export function pendingReasonFromImportExif({ hasExifTime, hasExifLocation }) {
  return hasExifLocation ? (hasExifTime ? undefined : "missing_time") : "missing_gps";
}

export function withImportExifStatus(photo, { hasExifTime, hasExifLocation }) {
  return {
    ...photo,
    exifStatus: importExifStatus({ hasExifTime, hasExifLocation }),
    pendingReason: pendingReasonFromImportExif({ hasExifTime, hasExifLocation }),
  };
}

export function pendingReasonFromExif(photo) {
  if (photo.exifStatus?.gps === "missing" || !isUsableLocation(photo.location)) return "missing_gps";
  if (photo.exifStatus?.time !== "read") return "missing_time";
  return undefined;
}

export function embeddingFailureReason(embedding) {
  if (!embedding) return undefined;
  if (embedding.embeddingMode !== "failed") return undefined;
  return embedding.embeddingFallbackReason || "Embedding 未返回可用向量。";
}

export function buildAiFailure(ai, embedding, job, { now } = {}) {
  const vision = ai?.fallbackReason;
  const embeddingFailure = embeddingFailureReason(embedding);
  if (!vision && !embeddingFailure) return undefined;
  return {
    vision,
    embedding: embeddingFailure,
    hasRealExifGps: Boolean(job.hasExifLocation),
    hasRealExifTime: Boolean(job.hasExifTime),
    updatedAt: resolveNow(now),
  };
}

export function buildRetryAiFailure(photo, { retryVision, retryEmbedding, ai, embedding, now } = {}) {
  const vision = retryVision ? ai?.fallbackReason : photo.aiFailure?.vision;
  const embeddingFailure = retryEmbedding ? embeddingFailureReason(embedding) : photo.aiFailure?.embedding;
  if (!vision && !embeddingFailure) return undefined;
  return {
    vision,
    embedding: embeddingFailure,
    hasRealExifGps: photo.exifStatus?.gps === "read" && isUsableLocation(photo.location),
    hasRealExifTime: photo.exifStatus?.time === "read",
    updatedAt: resolveNow(now),
  };
}

export function applyAiFailurePatch(photo, embedding, { now, resolveLocation = resolveImportedLocation } = {}) {
  const visionFailure = photo.aiFallbackReason;
  const embeddingFailure = embeddingFailureReason(embedding) ?? (photo.embeddingMode === "failed" ? photo.embeddingFallbackReason : undefined);
  const failed = Boolean(visionFailure || embeddingFailure);
  const pendingReason = failed ? "ai_processing_failed" : photo.pendingReason;
  return {
    ...photo,
    aiFailure: failed
      ? {
          vision: visionFailure,
          embedding: embeddingFailure,
          hasRealExifGps: photo.exifStatus?.gps === "read" && isUsableLocation(photo.location),
          hasRealExifTime: photo.exifStatus?.time === "read",
          updatedAt: resolveNow(now),
        }
      : undefined,
    pendingReason,
    locationResolution: resolveLocation({ location: photo.location, aiEvidence: photo.ai, pendingReason }),
  };
}

export function clearAiFailureForPhoto(photo, { aiEvidence = photo.ai, resolveLocation = resolveImportedLocation } = {}) {
  const pendingReason = pendingReasonFromExif(photo);
  return {
    ...photo,
    aiFailure: undefined,
    pendingReason,
    ai: aiEvidence,
    locationResolution: resolveLocation({ location: photo.location, aiEvidence, pendingReason }),
  };
}

export function failureReasonText(photo) {
  return [
    photo.aiFailure?.hasRealExifGps ? "真实GPS" : "无GPS",
    photo.aiFailure?.vision ? `AI Vision：${photo.aiFailure.vision}` : undefined,
    photo.aiFailure?.embedding ? `Embedding：${photo.aiFailure.embedding}` : undefined,
  ]
    .filter(Boolean)
    .join("。");
}

export function embeddingRebuildSucceeded(embedding) {
  return Array.isArray(embedding?.embedding) && embedding.embedding.length > 0 && embedding.embeddingMode === "cross_modal";
}

export function applyEmbeddingFields(photo, embedding, { fallbackMode, fallbackReason } = {}) {
  return {
    ...photo,
    embeddingProvider: embedding?.embeddingProvider,
    embeddingModel: embedding?.embeddingModel,
    embeddingSpaceId: embedding?.embeddingSpaceId,
    embeddingDimension: embedding?.embeddingDimension ?? embedding?.embedding?.length,
    embeddingMode: embedding?.embeddingMode ?? fallbackMode,
    embeddingFallbackReason: embedding?.embeddingFallbackReason ?? fallbackReason,
  };
}

export function patchVectorIndexForEmbedding(vectorIndex, photoId, embedding) {
  if (embeddingRebuildSucceeded(embedding)) vectorIndex[photoId] = embedding.embedding;
  else delete vectorIndex[photoId];
  return vectorIndex;
}

export function embeddingRebuildFailure(photo, embedding, fallbackReason = "向量模型未返回可用 embedding。") {
  return {
    id: photo.id,
    fileName: photo.fileName,
    reason: embedding?.embeddingFallbackReason || fallbackReason,
  };
}

export function mergeRebuiltPhotosState(state, rebuiltPhotos) {
  const rebuiltById = new Map(rebuiltPhotos.map((photo) => [photo.id, photo]));
  return {
    ...state,
    photos: safeArray(state.photos).map((photo) => rebuiltById.get(photo.id) ?? photo),
  };
}

export function buildEmbeddingRebuildReport({ total, succeeded = [], failed = [], mode }) {
  return {
    total,
    successCount: succeeded.length,
    failedCount: failed.length,
    failedPhotoIds: failed.map((item) => item.id),
    failures: failed,
    mode,
  };
}

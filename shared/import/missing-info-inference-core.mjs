import { haversineKm, isUsableLocation, normalizeLocale } from "../domain/geo.mjs";
import { cleanPlaceName, isWeakPlaceName } from "../domain/place-name-selector.mjs";

export const missingGpsLowConfidenceThreshold = 0.55;
const closeNeighborContextMs = 15 * 60 * 1000;

export function buildInferenceContextPhotos(state, batch, photo) {
  const batchPhotoIds = new Set(batch.addedPhotoIds);
  const currentTime = new Date(photo.capturedAt).getTime();
  let previous;
  let next;
  let previousLocated;
  let nextLocated;
  for (const item of state.photos) {
    if (item.id === photo.id) continue;
    const itemTime = new Date(item.capturedAt).getTime();
    if (!Number.isFinite(currentTime) || !Number.isFinite(itemTime)) continue;
    const distance = timeDistanceMs(item.capturedAt, photo.capturedAt);
    const isSameTripOrBatch = item.tripId === photo.tripId || batchPhotoIds.has(item.id);
    if (!isSameTripOrBatch) continue;
    const located = hasReadExifGps(item);
    if (itemTime <= currentTime) {
      if (!previous || distance < previous.distance) previous = { item, distance };
      if (located && (!previousLocated || distance < previousLocated.distance)) previousLocated = { item, distance };
    } else if (!next || distance < next.distance) {
      next = { item, distance };
    }
    if (itemTime > currentTime && located) {
      if (!nextLocated || distance < nextLocated.distance) nextLocated = { item, distance };
    }
  }
  return { previousPhoto: previous?.item, nextPhoto: next?.item, previousLocatedPhoto: previousLocated?.item, nextLocatedPhoto: nextLocated?.item };
}

export function allowedInferencePlaces(state, context) {
  const placeIds = new Set([context.previousPhoto?.placeNodeId, context.nextPhoto?.placeNodeId].filter(Boolean));
  return state.placeNodes.filter((place) => placeIds.has(place.id));
}

export function buildMissingInfoInferenceInput({ photo, context, contextPlaces, locale = "zh" }) {
  return {
    task: "missing_gps_second_pass",
    currentPhoto: {
      capturedAt: formatAiTimestamp(photo.capturedAt),
      initialLocationCandidate: serializeInitialLocationCandidate(photo),
    },
    neighbors: {
      previous: serializeNeighborPhoto(context.previousPhoto, contextPlaces, locale),
      next: serializeNeighborPhoto(context.nextPhoto, contextPlaces, locale),
    },
    allowedPlaces: contextPlaces.map((place) => ({
      id: place.id,
      name: localizedPlaceValue(place, "name", locale),
      city: localizedPlaceValue(place, "city", locale),
      country: localizedPlaceValue(place, "country", locale),
    })),
  };
}

export function normalizeMissingInfoAiProposal({ aiResult, photo, context, contextPlaces, locale = "zh", completeCandidatePoint = (candidate) => candidate } = {}) {
  if (aiResult.action === "bind_photos_to_place") {
    const place = contextPlaces.find((item) => item.id === aiResult.targetPlaceId);
    if (!place) return keepPending(missingInferenceText(locale, "targetNotAllowed"), aiResult.confidence ?? 0, locale);
    const closeNeighbor = closeNeighborForPlace(photo, context, place);
    if (isMissingGpsPhoto(photo) && Number(aiResult.confidence ?? 0) < missingGpsLowConfidenceThreshold && !closeNeighbor) {
      return keepPending(aiResult.reason || missingInferenceText(locale, "lowConfidence"), aiResult.confidence ?? 0, locale);
    }
    const reason = withCloseNeighborReason(aiResult.reason, closeNeighbor, locale);
    return {
      actionable: true,
      confidence: aiResult.confidence,
      displayTarget: `${missingInferenceText(locale, "mergeBadge")} ${place.displayName ?? place.name}`,
      displayTargetLabel: place.displayName ?? place.name,
      displayTargetBadge: missingInferenceText(locale, "mergeBadge"),
      suggestion: `${missingInferenceText(locale, "mergeBadge")} ${place.displayName ?? place.name}`,
      reason,
      proposal: {
        action: "bind_photos_to_place",
        photoIds: [photo.id],
        placeId: place.id,
        confidence: aiResult.confidence,
        reason,
        rewrittenInitialAnalysis: normalizedRewriteForProposal(aiResult.rewrittenInitialAnalysis),
      },
    };
  }

  if (aiResult.action === "create_place_from_candidate") {
    return createCandidateInferenceProposal({ candidate: aiResult.candidate, aiResult, photo, context, contextPlaces, locale, completeCandidatePoint });
  }

  const highConfidenceFallback = highConfidenceKeepPendingProposal({ aiResult, photo, context, contextPlaces, locale, completeCandidatePoint });
  if (highConfidenceFallback) return highConfidenceFallback;
  return keepPending(aiResult.reason || missingInferenceText(locale, "noAutoArchive"), aiResult.confidence ?? 0, locale);
}

function createCandidateInferenceProposal({ candidate: rawCandidate, aiResult, photo, context, contextPlaces, locale = "zh", completeCandidatePoint }) {
  const candidate = completeCandidatePoint(rawCandidate, locale);
  if (!candidate?.name) return keepPending(candidate?.reason || missingInferenceText(locale, "invalidPlaceName"), candidate?.confidence ?? 0, locale);
  if (!candidate.point) return keepPending(geocodeBlockedReason(candidate, locale), candidate.confidence ?? 0, locale);
  const mergePlace = findMergeableContextPlace(candidate, contextPlaces);
  if (mergePlace) {
    const closeNeighbor = closeNeighborForPlace(photo, context, mergePlace);
    const strongOverlap = hasStrongGeographicOverlap(candidate, mergePlace);
    if (isMissingGpsPhoto(photo) && Number(candidate.confidence ?? 0) < missingGpsLowConfidenceThreshold && !closeNeighbor && !strongOverlap) {
      return keepPending(candidate.reason || missingInferenceText(locale, "lowConfidence"), candidate.confidence ?? 0, locale);
    }
    const placeName = mergePlace.displayName ?? mergePlace.name;
    const reason = withInferenceSupportReason(
      `${candidate.reason || missingInferenceText(locale, "clearPlace")} ${missingInferenceText(locale, "matchedExistingPlace")}: ${placeName}.`,
      { closeNeighbor, strongOverlap },
      locale,
    );
    return {
      actionable: true,
      confidence: candidate.confidence,
      displayTarget: `${missingInferenceText(locale, "mergeBadge")} ${placeName}`,
      displayTargetLabel: placeName,
      displayTargetBadge: missingInferenceText(locale, "mergeBadge"),
      suggestion: `${missingInferenceText(locale, "mergeBadge")} ${placeName}`,
      reason,
      proposal: {
        action: "bind_photos_to_place",
        photoIds: [photo.id],
        placeId: mergePlace.id,
        confidence: candidate.confidence,
        reason,
        rewrittenInitialAnalysis: normalizedRewriteForProposal(aiResult.rewrittenInitialAnalysis),
      },
    };
  }
  if (isMissingGpsPhoto(photo) && Number(candidate.confidence ?? 0) < missingGpsLowConfidenceThreshold) return keepPending(candidate.reason || missingInferenceText(locale, "lowConfidence"), candidate.confidence ?? 0, locale);
  return {
    actionable: true,
    confidence: candidate.confidence,
    displayTarget: `${missingInferenceText(locale, "newPlaceBadge")} ${candidate.name}`,
    displayTargetLabel: candidate.name,
    displayTargetBadge: missingInferenceText(locale, "newPlaceBadge"),
    suggestion: `${missingInferenceText(locale, "newPlaceBadge")} ${candidate.name}`,
    reason: candidate.reason,
    proposal: {
      action: "create_place_from_candidate",
      tripId: photo.tripId,
      photoIds: [photo.id],
      candidate: {
        ...candidate,
        source: "ai_context_inference",
        precision: "estimated",
      },
      rewrittenInitialAnalysis: normalizedRewriteForProposal(aiResult.rewrittenInitialAnalysis),
    },
  };
}

function highConfidenceKeepPendingProposal({ aiResult, photo, context, contextPlaces, locale = "zh", completeCandidatePoint }) {
  if (Number(aiResult.confidence ?? 0) < missingGpsLowConfidenceThreshold) return undefined;
  const candidate = highConfidenceCandidate(aiResult, photo);
  if (!candidate) return keepPending(missingInferenceText(locale, "highConfidenceMissingCandidate"), aiResult.confidence ?? 0, locale);
  return createCandidateInferenceProposal({
    candidate: {
      ...candidate,
      confidence: Math.max(Number(candidate.confidence ?? 0), Number(aiResult.confidence ?? 0)),
      reason: aiResult.reason || candidate.reason,
    },
    aiResult,
    photo,
    context,
    contextPlaces,
    locale,
    completeCandidatePoint,
  });
}

function serializeInitialLocationCandidate(photo) {
  const candidate = bestPhotoLocationCandidate(photo);
  if (!candidate) return null;
  return {
    name: candidate.name,
    city: candidate.city,
  };
}

function bestPhotoLocationCandidate(photo) {
  return [...(photo.locationResolution?.candidates ?? []), ...(photo.ai?.locationCandidates ?? [])]
    .filter((candidate) => candidate?.name)
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0];
}

function serializeNeighborPhoto(photo, contextPlaces, locale = "zh") {
  if (!photo) {
    return {
      capturedAt: null,
      placeId: null,
      placeName: null,
      city: null,
      country: null,
      hasRealExifGps: false,
    };
  }
  const hasReliableGps = hasReadExifGps(photo);
  const place = photo.placeNodeId ? contextPlaces.find((item) => item.id === photo.placeNodeId) : undefined;
  const candidate = bestPhotoLocationCandidate(photo);
  return {
    capturedAt: formatAiTimestamp(photo.capturedAt),
    placeId: place?.id ?? null,
    placeName: place ? localizedPlaceValue(place, "displayName", locale) : (photo.locationResolution?.effectiveName ?? candidate?.name ?? null),
    city: place ? localizedPlaceValue(place, "city", locale) : (candidate?.city ?? null),
    country: place ? localizedPlaceValue(place, "country", locale) : (candidate?.country ?? null),
    hasRealExifGps: hasReliableGps,
  };
}

function localizedPlaceValue(place, field, locale = "zh") {
  if (!place) return null;
  if (normalizeLocale(locale) !== "en") {
    if (field === "displayName") return place.displayName ?? place.name ?? null;
    return place[field] ?? null;
  }
  if (field === "name" || field === "displayName") return place.names?.en ?? place.displayName ?? place.name ?? null;
  if (field === "city") return place.cityNames?.en ?? place.city ?? null;
  if (field === "country") return place.countryNames?.en ?? place.country ?? null;
  return place[field] ?? null;
}

function formatAiTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 16).replace("T", " ");
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function closeNeighborForPlace(photo, context, place) {
  if (!place?.id) return undefined;
  return uniquePhotos([context.previousPhoto, context.nextPhoto, context.previousLocatedPhoto, context.nextLocatedPhoto])
    .map((neighbor) => ({
      neighbor,
      distance: timeDistanceMs(neighbor.capturedAt, photo.capturedAt),
    }))
    .filter(({ neighbor, distance }) => hasReadExifGps(neighbor) && neighbor.placeNodeId === place.id && distance <= closeNeighborContextMs)
    .sort((left, right) => left.distance - right.distance)[0];
}

function normalizedRewriteForProposal(rewrittenInitialAnalysis) {
  if (!rewrittenInitialAnalysis?.caption || !Array.isArray(rewrittenInitialAnalysis.tags) || !rewrittenInitialAnalysis.locationCandidate) return undefined;
  const candidate = rewrittenInitialAnalysis.locationCandidate;
  return {
    title: rewrittenInitialAnalysis.title,
    tags: rewrittenInitialAnalysis.tags,
    caption: rewrittenInitialAnalysis.caption,
    locationCandidate: {
      name: candidate.name,
      country: candidate.country,
      city: candidate.city,
      confidence: candidate.confidence,
    },
  };
}

function hasReadExifGps(photo) {
  return photo?.exifStatus?.gps === "read" && isUsableLocation(photo.location);
}

function uniquePhotos(photos) {
  const seen = new Set();
  return photos.filter((photo) => {
    if (!photo || seen.has(photo.id)) return false;
    seen.add(photo.id);
    return true;
  });
}

function withCloseNeighborReason(reason, closeNeighbor, locale = "zh") {
  if (!closeNeighbor) return reason;
  const minutes = Math.max(1, Math.round(closeNeighbor.distance / 60000));
  const baseReason = reason || missingInferenceText(locale, "bindablePlace");
  return normalizeLocale(locale) === "en"
    ? `${baseReason} A neighboring geotagged photo is only ${minutes} minutes away and matches the target place, so the low-confidence nearby context is allowed.`
    : `${baseReason} 与相邻已定位照片仅相隔 ${minutes} 分钟，且目标地点一致，已允许低置信度近时间上下文通过。`;
}

function withInferenceSupportReason(reason, { closeNeighbor, strongOverlap }, locale = "zh") {
  if (strongOverlap) return reason;
  return withCloseNeighborReason(reason, closeNeighbor, locale);
}

function hasStrongGeographicOverlap(candidate, place) {
  if (!candidate?.point || !place?.center) return false;
  const distance = haversineKm(candidate.point, place.center);
  const candidateName = cleanPlaceName(candidate.name);
  const placeName = cleanPlaceName(place.displayName ?? place.name);
  const candidateCity = cleanPlaceName(candidate.city);
  const placeCity = cleanPlaceName(place.city);
  const candidateCountry = cleanPlaceName(candidate.country);
  const placeCountry = cleanPlaceName(place.country);
  const sameCountry = !candidateCountry || !placeCountry || candidateCountry === placeCountry;
  const sameCity = Boolean(candidateCity && placeCity && candidateCity === placeCity);
  const sameName = Boolean(candidateName && placeName && (candidateName === placeName || candidateName.includes(placeName) || placeName.includes(candidateName)));
  return sameCountry && (distance <= 1.2 || (sameCity && distance <= 5) || (sameName && distance <= 12));
}

function findMergeableContextPlace(candidate, contextPlaces) {
  if (!candidate?.point) return undefined;
  const candidateName = cleanPlaceName(candidate.name);
  const candidateCity = cleanPlaceName(candidate.city);
  const candidateCountry = cleanPlaceName(candidate.country);
  return contextPlaces
    .map((place) => {
      if (!place.center) return undefined;
      const distance = haversineKm(candidate.point, place.center);
      const placeName = cleanPlaceName(place.displayName ?? place.name);
      const placeCity = cleanPlaceName(place.city);
      const placeCountry = cleanPlaceName(place.country);
      const sameCountry = !candidateCountry || !placeCountry || candidateCountry === placeCountry;
      const sameCity = Boolean(candidateCity && placeCity && candidateCity === placeCity);
      const sameName = Boolean(candidateName && placeName && (candidateName === placeName || candidateName.includes(placeName) || placeName.includes(candidateName)));
      const threshold = sameName ? 25 : sameCity ? 25 : 25;
      if (!sameCountry || distance > threshold) return undefined;
      return { place, distance, sameName, sameCity };
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.sameName) - Number(left.sameName) || Number(right.sameCity) - Number(left.sameCity) || left.distance - right.distance)[0]?.place;
}

function geocodeBlockedReason(candidate, locale = "zh") {
  const name = candidate?.name || candidate?.city;
  const english = normalizeLocale(locale) === "en";
  if (!name) return missingInferenceText(locale, "invalidPlaceName");
  if (candidate?.name && isWeakPlaceName(candidate.name)) return missingInferenceText(locale, "invalidPlaceName");
  return english
    ? `AI gave a high-confidence clue for ${name}, but the local gazetteer could not estimate usable coordinates, so manual placement is still required.`
    : `AI 给出了「${name}」的高置信地点线索，但本地地名库无法估计可用坐标，仍需手动补点。`;
}

function highConfidenceCandidate(aiResult, photo) {
  const candidates = [aiResult.candidate, bestPhotoLocationCandidate(photo)].filter(Boolean);
  return candidates.find((candidate) => candidate?.name && !isWeakPlaceName(candidate.name));
}

function isMissingGpsPhoto(photo) {
  return photo.pendingReason === "missing_gps" || photo.exifStatus?.gps === "missing" || !isUsableLocation(photo.location);
}

export function missingInferenceText(locale, key) {
  const english = normalizeLocale(locale) === "en";
  const messages = {
    photoNotFound: english ? "The pending photo could not be found." : "找不到待补照片。",
    imageMissing: english ? "The original image for this pending photo could not be found, so context inference cannot run." : "找不到当前待补照片原图，无法执行基于上下文推断。",
    secondInferenceFailed: english ? "Context inference failed." : "基于上下文推断失败。",
    targetNotAllowed: english ? "AI suggested a target place that is not in the backend allowed-place list." : "AI 建议的目标地点不在后端允许的地点列表中。",
    lowConfidence: english ? "The inferred location confidence is too low for this pending photo." : "待补照片地点置信度不足。",
    invalidPlaceName: english ? "AI did not provide a valid place name that can be created." : "AI 未给出可创建地点的合法名称。",
    noGeocode: english ? "AI provided a place name, but the local gazetteer could not estimate usable coordinates, so manual placement is still required." : "AI 给出了地点名，但本地地名库无法估计可用坐标，仍需手动补点。",
    noAutoArchive: english ? "AI still cannot determine a reliable location for this photo." : "AI 认为当前照片仍无法可靠判断地点。",
    highConfidenceMissingCandidate: english ? "AI returned high confidence but did not provide a concrete place candidate that can be created or bound, so manual confirmation is still required." : "AI 返回了高置信度，但没有给出可创建或可绑定的具体地点候选，仍需手动确认。",
    clearPlace: english ? "AI provided a clear place." : "AI 给出了明确地点。",
    matchedExistingPlace: english ? "It matched an existing place in the same trip" : "已匹配到同一行程中的现有地点",
    bindablePlace: english ? "AI suggested a place that can be bound to the same location." : "AI 给出了可绑定到同一地点的建议。",
    mergeBadge: english ? "Merge" : "合并",
    newPlaceBadge: english ? "New place" : "新地点",
    pendingTarget: english ? "Still pending" : "仍待确认",
    pendingLabel: english ? "Pending" : "待确认",
    keepPendingSuggestion: english ? "AI does not recommend automatic archiving yet. Manual handling is still required." : "AI 暂不建议自动归档，仍需手动处理。",
  };
  return messages[key] ?? messages.noAutoArchive;
}

export function keepPending(reason, confidence, locale = "zh") {
  const cappedConfidence = Math.min(Number(confidence ?? 0), Math.max(0, missingGpsLowConfidenceThreshold - 0.01));
  return {
    actionable: false,
    confidence: cappedConfidence,
    displayTarget: missingInferenceText(locale, "pendingTarget"),
    displayTargetLabel: missingInferenceText(locale, "pendingLabel"),
    displayTargetBadge: missingInferenceText(locale, "pendingLabel"),
    suggestion: missingInferenceText(locale, "keepPendingSuggestion"),
    reason,
    proposal: { action: "keep_pending", confidence: cappedConfidence, reason },
  };
}

export function applyMissingInfoProposal(pending, proposal, { now = () => new Date().toISOString() } = {}) {
  const updatedAt = typeof now === "function" ? now() : now;
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
      updatedAt,
    },
  };
}

export function applyMissingInfoProposalState(state, batchId, pendingId, proposal, { now } = {}) {
  const batch = state.importBatches.find((item) => item.id === batchId);
  const pending = state.pendingItems.find((item) => item.id === pendingId);
  if (!batch || batch.status !== "pending_confirmation" || !pending || !batch.pendingItemIds.includes(pending.id)) return state;
  if (!["missing_gps", "confirm_location_candidate"].includes(pending.type)) return state;
  return {
    ...state,
    pendingItems: state.pendingItems.map((item) => (item.id === pending.id ? applyMissingInfoProposal(item, proposal, { now }) : item)),
  };
}

export function applyMissingInfoProposalResultsState(state, batchId, results, { now } = {}) {
  const batch = state.importBatches.find((item) => item.id === batchId);
  if (!batch || batch.status !== "pending_confirmation") return state;
  const proposalByPendingId = new Map(results.map((item) => [item.pendingId, item.proposal]));
  return {
    ...state,
    pendingItems: state.pendingItems.map((item) => {
      const proposal = proposalByPendingId.get(item.id);
      if (!proposal || !batch.pendingItemIds.includes(item.id) || item.status !== "open") return item;
      if (!["missing_gps", "confirm_location_candidate"].includes(item.type)) return item;
      return applyMissingInfoProposal(item, proposal, { now });
    }),
  };
}

export function timeDistanceMs(left, right) {
  if (!left || !right) return Number.MAX_SAFE_INTEGER;
  return Math.abs(new Date(left).getTime() - new Date(right).getTime());
}

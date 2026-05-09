import { safeArray } from "./arrays.mjs";
import { isUsableLocation } from "./geo.mjs";

export function toAiEvidence(ai, { makeId, analyzedAt = new Date().toISOString() } = {}) {
  return {
    provider: ai.provider,
    promptId: ai.promptId ?? "photo-analysis",
    promptVersion: ai.promptVersion ?? "1.0.0",
    analyzedAt,
    title: ai.title,
    caption: ai.caption,
    tags: ai.tags,
    visiblePlaceNames: safeArray(ai.visiblePlaceNames),
    locationCandidates: safeArray(ai.locationCandidates).map((candidate) => ({
      id: candidate.id ?? makeId?.("candidate") ?? `candidate-${Date.now().toString(36)}`,
      name: candidate.name,
      country: candidate.country,
      city: candidate.city,
      point: candidate.point ?? (Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng) ? { lat: candidate.lat, lng: candidate.lng } : undefined),
      confidence: candidate.confidence,
      source: candidate.source ?? "ai_vision",
      precision: candidate.precision,
      reason: candidate.reason,
    })),
    uncertainties: safeArray(ai.uncertainties),
    fallbackReason: ai.fallbackReason,
  };
}

export function resolveImportedLocation({ location, aiEvidence, pendingReason, updatedAt = new Date().toISOString() }) {
  if (isUsableLocation(location)) {
    return {
      status: "confirmed",
      effectivePoint: location,
      source: "exif",
      candidates: aiEvidence.locationCandidates,
      requiresUserAction: false,
      updatedAt,
    };
  }
  const candidate = aiEvidence.locationCandidates.find((item) => item.point && item.confidence >= 0.55);
  if (candidate) {
    return {
      status: "suggested",
      effectiveName: candidate.name,
      effectivePoint: candidate.point,
      confidence: candidate.confidence,
      source: candidate.source,
      candidateId: candidate.id,
      candidates: aiEvidence.locationCandidates,
      requiresUserAction: true,
      updatedAt,
    };
  }
  return {
    status: pendingReason === "missing_gps" ? "missing" : "suggested",
    candidates: aiEvidence.locationCandidates,
    requiresUserAction: Boolean(pendingReason),
    updatedAt,
  };
}

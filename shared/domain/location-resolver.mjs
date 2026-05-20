import { safeArray } from "./arrays.mjs";
import { normalizeCountryDescription } from "./country-normalizer.mjs";
import { isUsableLocation } from "./geo.mjs";

export function toAiEvidence(ai, { makeId, analyzedAt = new Date().toISOString() } = {}) {
  return {
    provider: ai.provider,
    model: ai.model,
    promptId: ai.promptId ?? "photo-analysis",
    promptVersion: ai.promptVersion ?? "1.0.0",
    analyzedAt,
    title: ai.title,
    caption: ai.caption,
    tags: ai.tags,
    visiblePlaceNames: safeArray(ai.visiblePlaceNames),
    locationCandidates: safeArray(ai.locationCandidates).map((candidate) => {
      const country = normalizeCountryDescription(candidate.country, candidate.localizedCountryNames);
      return {
        id: candidate.id ?? makeId?.("candidate") ?? `candidate-${Date.now().toString(36)}`,
        name: candidate.name,
        country: country.country ?? candidate.country,
        localizedCountryNames: country.countryNames ?? candidate.localizedCountryNames,
        city: candidate.city,
        confidence: candidate.confidence,
        source: candidate.source ?? "ai_vision",
        precision: candidate.precision,
        reason: candidate.reason,
      };
    }),
    uncertainties: safeArray(ai.uncertainties),
    fallbackReason: ai.fallbackReason,
  };
}

export function mergeLocationCandidates(...candidateGroups) {
  const seen = new Set();
  const candidates = [];
  for (const candidate of candidateGroups.flat().filter(Boolean)) {
    const key = [
      String(candidate.name ?? "").trim().toLowerCase(),
      String(candidate.country ?? "").trim().toLowerCase(),
      String(candidate.city ?? "").trim().toLowerCase(),
      candidate.point ? `${Number(candidate.point.lat).toFixed(4)},${Number(candidate.point.lng).toFixed(4)}` : "",
      candidate.source ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates.sort((left, right) => {
    const sourceRank = (source) => (source === "geocode" ? 3 : source === "manual" ? 2 : source === "ai_vision" ? 1 : 0);
    return sourceRank(right.source) - sourceRank(left.source) || Number(right.confidence ?? 0) - Number(left.confidence ?? 0);
  });
}

export function resolveImportedLocation({ location, aiEvidence, pendingReason, updatedAt = new Date().toISOString() }) {
  const locationCandidates = safeArray(aiEvidence?.locationCandidates);
  if (isUsableLocation(location)) {
    return {
      status: "confirmed",
      effectivePoint: location,
      source: "exif",
      candidates: locationCandidates,
      requiresUserAction: false,
      updatedAt,
    };
  }
  const candidate = locationCandidates.find((item) => item.point && item.confidence >= 0.55);
  if (candidate) {
    return {
      status: "suggested",
      effectiveName: candidate.name,
      effectivePoint: candidate.point,
      confidence: candidate.confidence,
      source: candidate.source,
      candidateId: candidate.id,
      candidates: locationCandidates,
      requiresUserAction: true,
      updatedAt,
    };
  }
  return {
    status: pendingReason === "missing_gps" ? "missing" : "suggested",
    candidates: locationCandidates,
    requiresUserAction: Boolean(pendingReason),
    updatedAt,
  };
}

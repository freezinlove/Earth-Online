import { normalizeTags } from "../domain/text-normalizer.mjs";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeCandidate(candidate) {
  const lat = finiteNumber(candidate?.lat);
  const lng = finiteNumber(candidate?.lng);
  const confidence = Math.max(0, Math.min(1, finiteNumber(candidate?.confidence) ?? 0));
  return {
    name: String(candidate?.name ?? "").trim(),
    country: candidate?.country ? String(candidate.country).trim() : undefined,
    city: candidate?.city ? String(candidate.city).trim() : undefined,
    lat,
    lng,
    confidence,
    reason: String(candidate?.reason ?? "").trim(),
  };
}

export function validatePhotoAnalysisResult(parsed, preset) {
  if (!parsed || typeof parsed !== "object") throw new Error("AI photo analysis did not return an object");
  const caption = String(parsed.caption ?? "").trim();
  if (!caption || !Array.isArray(parsed.tags)) throw new Error("AI photo analysis returned unexpected content");
  const locationCandidates = Array.isArray(parsed.locationCandidates)
    ? parsed.locationCandidates
        .map(normalizeCandidate)
        .filter((candidate) => candidate.name && candidate.confidence > 0)
        .slice(0, 5)
    : [];
  return {
    title: String(parsed.title ?? "").trim().slice(0, 24) || undefined,
    tags: normalizeTags(parsed.tags, preset),
    caption,
    visiblePlaceNames: Array.isArray(parsed.visiblePlaceNames) ? parsed.visiblePlaceNames.map((item) => String(item).trim()).filter(Boolean).slice(0, 8) : [],
    locationCandidates,
    uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties.map((item) => String(item).trim()).filter(Boolean).slice(0, 8) : [],
  };
}

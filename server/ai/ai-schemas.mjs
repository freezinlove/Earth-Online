import { normalizeTags } from "../domain/text-normalizer.mjs";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clampConfidence(value) {
  return Math.max(0, Math.min(1, finiteNumber(value) ?? 0));
}

function normalizeCandidate(candidate) {
  const lat = finiteNumber(candidate?.lat);
  const lng = finiteNumber(candidate?.lng);
  const confidence = clampConfidence(candidate?.confidence);
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

function normalizePoint(point) {
  const lat = finiteNumber(point?.lat);
  const lng = finiteNumber(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return undefined;
  return { lat, lng };
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

export function validateMissingInfoInferenceResult(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return { action: "keep_pending", confidence: 0, reason: "AI 未返回可解析的二次推断结果。" };
  }
  const action = String(parsed.action ?? "");
  const confidence = clampConfidence(parsed.confidence ?? parsed.candidate?.confidence);
  const reason = String(parsed.reason ?? parsed.candidate?.reason ?? "").trim().slice(0, 240) || "AI 未提供明确理由。";

  if (action === "bind_photos_to_place") {
    return {
      action,
      targetPlaceId: String(parsed.targetPlaceId ?? "").trim(),
      confidence,
      reason,
    };
  }

  if (action === "create_place_from_candidate") {
    const candidate = parsed.candidate && typeof parsed.candidate === "object" ? parsed.candidate : {};
    const point = normalizePoint(candidate.point ?? candidate);
    return {
      action,
      candidate: {
        name: String(candidate.name ?? "").trim().slice(0, 80),
        point,
        city: candidate.city ? String(candidate.city).trim().slice(0, 80) : undefined,
        country: candidate.country ? String(candidate.country).trim().slice(0, 80) : undefined,
        confidence: clampConfidence(candidate.confidence),
        source: "ai_context_inference",
        precision: "estimated",
        reason: String(candidate.reason ?? reason).trim().slice(0, 240) || reason,
      },
    };
  }

  return {
    action: "keep_pending",
    confidence,
    reason,
  };
}

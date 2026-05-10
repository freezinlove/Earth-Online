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
  const rawCandidates = parsed.locationCandidate
    ? [parsed.locationCandidate]
    : Array.isArray(parsed.locationCandidates)
      ? parsed.locationCandidates
      : [];
  const locationCandidates = rawCandidates
    .map(normalizeCandidate)
    .filter((candidate) => candidate.name && candidate.confidence > 0)
    .slice(0, 1);
  return {
    title: String(parsed.title ?? "").trim().slice(0, 24) || undefined,
    tags: normalizeTags(parsed.tags, preset),
    caption,
    visiblePlaceNames: [],
    locationCandidates,
    uncertainties: [],
  };
}

function normalizeRewrittenInitialAnalysis(value) {
  if (!value || typeof value !== "object") return undefined;
  const caption = String(value.caption ?? "").trim();
  const tags = Array.isArray(value.tags) ? normalizeTags(value.tags, undefined) : [];
  const locationCandidate = normalizeCandidate(value.locationCandidate ?? value.locationCandidates?.[0]);
  if (!caption || tags.length === 0 || !locationCandidate.name || locationCandidate.confidence <= 0) return undefined;
  return {
    title: String(value.title ?? "").trim().slice(0, 24) || undefined,
    tags,
    caption,
    locationCandidate,
  };
}

function normalizeInferenceTargetCandidate(candidate, fallbackReason) {
  const raw = candidate && typeof candidate === "object" ? candidate : {};
  const point = normalizePoint(raw.point ?? raw);
  return {
    name: String(raw.name ?? "").trim().slice(0, 80),
    point,
    city: raw.city ? String(raw.city).trim().slice(0, 80) : undefined,
    country: raw.country ? String(raw.country).trim().slice(0, 80) : undefined,
    confidence: clampConfidence(raw.confidence),
    source: "ai_context_inference",
    precision: "estimated",
    reason: String(raw.reason ?? fallbackReason).trim().slice(0, 240) || fallbackReason,
  };
}

export function validateMissingInfoInferenceResult(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return { action: "keep_pending", confidence: 0, reason: "AI 未返回可解析的二次推断结果。" };
  }
  const action = String(parsed.action ?? "");
  const confidence = clampConfidence(parsed.confidence ?? parsed.candidate?.confidence);
  const reason = String(parsed.reason ?? parsed.candidate?.reason ?? "").trim().slice(0, 240) || "AI 未提供明确理由。";
  const rewriteInitialAnalysis = Boolean(parsed.rewriteInitialAnalysis);
  const rewrittenInitialAnalysis = rewriteInitialAnalysis ? normalizeRewrittenInitialAnalysis(parsed.rewrittenInitialAnalysis) : undefined;

  if (action === "bind_photos_to_place") {
    return {
      action,
      targetPlaceId: String(parsed.target?.placeId ?? parsed.targetPlaceId ?? "").trim(),
      confidence,
      reason,
      rewriteInitialAnalysis,
      rewrittenInitialAnalysis,
    };
  }

  if (action === "create_place_from_candidate") {
    return {
      action,
      candidate: normalizeInferenceTargetCandidate(parsed.target?.locationCandidate ?? parsed.candidate, reason),
      rewriteInitialAnalysis: true,
      rewrittenInitialAnalysis: rewrittenInitialAnalysis ?? normalizeRewrittenInitialAnalysis({
        ...parsed.rewrittenInitialAnalysis,
        locationCandidate: parsed.rewrittenInitialAnalysis?.locationCandidate ?? parsed.target?.locationCandidate ?? parsed.candidate,
      }),
    };
  }

  return {
    action: "keep_pending",
    confidence,
    reason,
    rewriteInitialAnalysis: false,
    rewrittenInitialAnalysis: undefined,
  };
}

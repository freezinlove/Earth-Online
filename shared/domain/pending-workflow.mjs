import { haversineKm } from "./geo.mjs";
import { cleanPlaceName, isWeakPlaceName } from "./place-name-selector.mjs";

const DEFAULT_PLACE_MERGE_RADIUS_KM = 25;
const SAME_CITY_PLACE_MERGE_RADIUS_KM = 25;
const SAME_NAME_PLACE_MERGE_RADIUS_KM = 25;

function markPending(state, id, status) {
  return {
    ...state,
    pendingItems: state.pendingItems.map((item) => (item.id === id ? { ...item, status } : item)),
  };
}

function clearMissingExifStatus(photo) {
  return {
    ...(photo.exifStatus ?? {}),
    time: photo.exifStatus?.time ?? (photo.capturedAt ? "fallback" : "missing"),
    gps: photo.exifStatus?.gps === "missing" ? "fallback" : (photo.exifStatus?.gps ?? (photo.location ? "fallback" : "missing")),
  };
}

function candidatePoint(candidate) {
  if (!candidate) return undefined;
  if (candidate.point) return candidate.point;
  if (Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng)) return { lat: candidate.lat, lng: candidate.lng };
  return undefined;
}

function rewrittenCandidate(candidate, fallback = {}) {
  if (!candidate?.name) return undefined;
  return {
    id: candidate.id ?? fallback.id,
    name: candidate.name,
    country: fallback.country ?? candidate.country,
    localizedCountryNames: fallback.localizedCountryNames ?? candidate.localizedCountryNames,
    city: fallback.city ?? candidate.city,
    localizedCityNames: fallback.localizedCityNames ?? candidate.localizedCityNames,
    point: candidatePoint(candidate) ?? fallback.point,
    confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : Number(fallback.confidence ?? 0.65),
    source: "ai_context_inference",
    precision: "estimated",
    reason: fallback.reason ?? "基于上下文推断修正了初次地点判断。",
  };
}

function applyRewrittenInitialAnalysis(photo, rewrite, fallbackCandidate) {
  if (!rewrite) return photo;
  const candidate = rewrittenCandidate(rewrite.locationCandidate, fallbackCandidate);
  const locationCandidates = candidate ? [candidate] : (photo.ai?.locationCandidates ?? []);
  return {
    ...photo,
    title: rewrite.title ?? photo.title,
    tags: Array.isArray(rewrite.tags) && rewrite.tags.length ? rewrite.tags : photo.tags,
    aiCaption: rewrite.caption ?? photo.aiCaption,
    ai: photo.ai
      ? {
          ...photo.ai,
          title: rewrite.title ?? photo.ai.title,
          caption: rewrite.caption ?? photo.ai.caption,
          tags: Array.isArray(rewrite.tags) && rewrite.tags.length ? rewrite.tags : photo.ai.tags,
          visiblePlaceNames: [],
          locationCandidates,
          uncertainties: [],
        }
      : photo.ai,
  };
}

function confirmLocationCandidate(state, proposal) {
  const photoIds = new Set(proposal.photoIds ?? []);
  return {
    ...state,
    photos: state.photos.map((photo) => {
      if (!photoIds.has(photo.id)) return photo;
      const candidates = photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [];
      const candidate = candidates.find((item) => item.id === proposal.candidateId);
      if (!candidate?.point) return photo;
      return {
        ...photo,
        location: candidate.point,
        pendingReason: undefined,
        exifStatus: clearMissingExifStatus({ ...photo, location: candidate.point }),
        locationResolution: {
          ...(photo.locationResolution ?? {}),
          status: "confirmed",
          effectiveName: candidate.name,
          effectivePoint: candidate.point,
          confidence: candidate.confidence,
          source: candidate.source,
          candidateId: candidate.id,
          candidates,
          requiresUserAction: false,
          updatedAt: new Date().toISOString(),
        },
      };
    }),
  };
}

function bindPhotosToPlace(state, proposal) {
  const photoIds = new Set(proposal.photoIds ?? []);
  const place = state.placeNodes.find((item) => item.id === proposal.placeId);
  if (!place) return state;
  return {
    ...state,
    photos: state.photos.map((photo) =>
      photoIds.has(photo.id)
        ? (() => {
            const rewritten = applyRewrittenInitialAnalysis(photo, proposal.rewrittenInitialAnalysis, {
              name: place.displayName ?? place.name,
              country: place.country,
              city: place.city,
              point: place.center,
              confidence: proposal.confidence,
            });
            return {
              ...rewritten,
              tripId: place.tripId,
              placeNodeId: place.id,
              location: place.center,
              pendingReason: undefined,
              exifStatus: clearMissingExifStatus({ ...rewritten, location: place.center }),
              locationResolution: {
                ...(rewritten.locationResolution ?? {}),
                status: "confirmed",
                effectiveName: place.displayName ?? place.name,
                effectivePoint: place.center,
                confidence: proposal.confidence ?? rewritten.locationResolution?.confidence,
                source: "existing_trip_context",
                requiresUserAction: false,
                updatedAt: new Date().toISOString(),
                candidates: rewritten.ai?.locationCandidates ?? rewritten.locationResolution?.candidates ?? [],
              },
            };
          })()
        : photo,
    ),
    placeNodes: state.placeNodes.map((item) => ({
      ...item,
      photoIds: item.id === place.id ? Array.from(new Set([...item.photoIds, ...photoIds])) : item.photoIds.filter((id) => !photoIds.has(id)),
      pending: item.id === place.id ? false : item.pending,
    })),
  };
}

function cityGeocodedCandidate(candidate, { forwardGeocode } = {}) {
  if (!candidate?.name && !candidate?.city) return undefined;
  if (candidate?.name && isWeakPlaceName(candidate.name)) return undefined;
  const cityQuery = candidate.city || candidate.name;
  const fallback = forwardGeocode?.({ name: candidate.name, city: cityQuery, country: candidate.country })?.[0];
  if (!fallback?.point) return undefined;
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
    reason: candidate.reason || `Local gazetteer coordinates were added from ${fallback.name}.`,
  };
}

function findMergeableExistingPlace(state, tripId, candidate, point, candidatePlaceId) {
  const candidateName = cleanPlaceName(candidate?.name);
  const candidateCity = cleanPlaceName(candidate?.city);
  const candidateCountry = cleanPlaceName(candidate?.country);
  return state.placeNodes
    .filter((place) => place.tripId === tripId && place.id !== candidatePlaceId && place.center)
    .map((place) => {
      const distance = haversineKm(point, place.center);
      const placeName = cleanPlaceName(place.displayName ?? place.name);
      const placeCity = cleanPlaceName(place.city);
      const placeCountry = cleanPlaceName(place.country);
      const sameCountry = !candidateCountry || !placeCountry || candidateCountry === placeCountry;
      const sameCity = Boolean(candidateCity && placeCity && candidateCity === placeCity);
      const sameName = Boolean(candidateName && placeName && (candidateName === placeName || candidateName.includes(placeName) || placeName.includes(candidateName)));
      const threshold = sameName ? SAME_NAME_PLACE_MERGE_RADIUS_KM : sameCity ? SAME_CITY_PLACE_MERGE_RADIUS_KM : DEFAULT_PLACE_MERGE_RADIUS_KM;
      if (!sameCountry || distance > threshold) return undefined;
      return {
        place,
        score: distance - (sameName ? 20 : 0) - (sameCity ? 8 : 0) - (sameCountry ? 1 : 0),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.score - right.score)[0]?.place;
}

function createPlaceFromCandidate(state, proposal, options = {}) {
  const candidate = proposal.candidate;
  const geocoded = cityGeocodedCandidate(candidate, options);
  const point = geocoded?.point;
  if (!proposal.tripId || !point) return state;
  const photoIds = new Set(proposal.photoIds ?? []);
  const candidateWithPoint = { ...candidate, ...geocoded, point };
  const existingPlace = findMergeableExistingPlace(state, proposal.tripId, candidateWithPoint, point, proposal.placeId);
  if (existingPlace) {
    return bindPhotosToPlace(state, {
      action: "bind_photos_to_place",
      photoIds: Array.from(photoIds),
      placeId: existingPlace.id,
      confidence: candidateWithPoint.confidence,
      reason: candidateWithPoint.reason,
      rewrittenInitialAnalysis: proposal.rewrittenInitialAnalysis,
    });
  }
  const placeId = proposal.placeId ?? `place-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const relatedPhotos = state.photos.filter((photo) => photoIds.has(photo.id));
  const dates = relatedPhotos.map((photo) => photo.capturedAt).filter(Boolean).sort();
  const place = {
    id: placeId,
    tripId: proposal.tripId,
    name: candidate.name ?? "AI 建议地点",
    displayName: candidate.name ?? "AI 建议地点",
    city: geocoded.city ?? candidate.city,
    cityNames: geocoded.localizedCityNames,
    country: geocoded.country ?? candidate.country,
    countryNames: geocoded.localizedCountryNames,
    center: point,
    coordinatePrecision: geocoded.precision ?? "estimated",
    photoIds: Array.from(photoIds),
    timeRange: { start: dates[0] ?? new Date().toISOString(), end: dates.at(-1) ?? dates[0] ?? new Date().toISOString() },
    pending: false,
  };
  return {
    ...state,
    photos: state.photos.map((photo) =>
      photoIds.has(photo.id)
        ? (() => {
            const rewritten = applyRewrittenInitialAnalysis(photo, proposal.rewrittenInitialAnalysis, candidateWithPoint);
            return {
              ...rewritten,
              tripId: proposal.tripId,
              placeNodeId: place.id,
              location: point,
              pendingReason: undefined,
              exifStatus: clearMissingExifStatus({ ...rewritten, location: point }),
              locationResolution: {
                ...(rewritten.locationResolution ?? {}),
                status: "confirmed",
                effectiveName: place.name,
                effectivePoint: point,
                confidence: candidateWithPoint.confidence,
                source: candidateWithPoint.source ?? "geocode",
                precision: candidateWithPoint.precision ?? "estimated",
                candidateId: candidate.id,
                candidates: rewritten.ai?.locationCandidates ?? rewritten.locationResolution?.candidates ?? [],
                requiresUserAction: false,
                updatedAt: new Date().toISOString(),
              },
            };
          })()
        : photo,
    ),
    placeNodes: [...state.placeNodes, place],
  };
}

function confirmTripAssignment(state, proposal) {
  const photoIds = new Set(proposal.photoIds ?? []);
  return {
    ...state,
    photos: state.photos.map((photo) => (photoIds.has(photo.id) ? { ...photo, tripId: proposal.tripId ?? photo.tripId } : photo)),
  };
}

function mergeTrips(state, proposal) {
  const targetTripId = proposal.targetTripId;
  const sourceTripIds = new Set(proposal.sourceTripIds ?? []);
  if (!targetTripId || sourceTripIds.size === 0) return state;
  return {
    ...state,
    photos: state.photos.map((photo) => (sourceTripIds.has(photo.tripId) ? { ...photo, tripId: targetTripId } : photo)),
    placeNodes: state.placeNodes.map((place) => (sourceTripIds.has(place.tripId) ? { ...place, tripId: targetTripId } : place)),
    routes: state.routes.filter((route) => !sourceTripIds.has(route.tripId)),
    trips: state.trips.filter((trip) => !sourceTripIds.has(trip.id)),
  };
}

function applyProposal(state, proposal, options = {}) {
  if (!proposal?.action) return state;
  if (proposal.action === "confirm_location_candidate") return confirmLocationCandidate(state, proposal);
  if (proposal.action === "bind_photos_to_place") return bindPhotosToPlace(state, proposal);
  if (proposal.action === "create_place_from_candidate") return createPlaceFromCandidate(state, proposal, options);
  if (proposal.action === "confirm_trip_assignment") return confirmTripAssignment(state, proposal);
  if (proposal.action === "merge_trips") return mergeTrips(state, proposal);
  if (proposal.action === "keep_pending") return state;
  if (proposal.action === "resolve_ai_processing_failed") return state;
  return state;
}

export function applyPendingDecision(state, id, { accepted, forwardGeocode } = {}) {
  const pending = state.pendingItems.find((item) => item.id === id);
  if (!pending) return state;
  if (!accepted) return markPending(state, id, "ignored");
  const applied = applyProposal(state, pending.proposal, { forwardGeocode });
  if (pending.proposal?.action === "create_place_from_candidate" && applied === state) return state;
  if (["missing_gps", "missing_time", "confirm_location_candidate"].includes(pending.type)) {
    const relatedPhotoIds = new Set(pending.relatedPhotoIds ?? []);
    return {
      ...applied,
      pendingItems: applied.pendingItems.map((item) =>
        item.id === id ||
        (item.status === "open" &&
          ["missing_gps", "missing_time", "confirm_location_candidate"].includes(item.type) &&
          (item.relatedPhotoIds ?? []).some((photoId) => relatedPhotoIds.has(photoId)))
          ? { ...item, status: "accepted" }
          : item,
      ),
    };
  }
  return markPending(applied, id, "accepted");
}

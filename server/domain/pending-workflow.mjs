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
        ? {
            ...photo,
            tripId: place.tripId,
            placeNodeId: place.id,
            location: place.center,
            pendingReason: undefined,
            exifStatus: clearMissingExifStatus({ ...photo, location: place.center }),
            locationResolution: {
              ...(photo.locationResolution ?? {}),
              status: "confirmed",
              effectiveName: place.displayName ?? place.name,
              effectivePoint: place.center,
              confidence: proposal.confidence ?? photo.locationResolution?.confidence,
              source: "existing_trip_context",
              requiresUserAction: false,
              updatedAt: new Date().toISOString(),
              candidates: photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [],
            },
          }
        : photo,
    ),
    placeNodes: state.placeNodes.map((item) => ({
      ...item,
      photoIds: item.id === place.id ? Array.from(new Set([...item.photoIds, ...photoIds])) : item.photoIds.filter((id) => !photoIds.has(id)),
      pending: item.id === place.id ? false : item.pending,
    })),
  };
}

function createPlaceFromCandidate(state, proposal) {
  const candidate = proposal.candidate;
  const point = candidate?.point ?? (Number.isFinite(candidate?.lat) && Number.isFinite(candidate?.lng) ? { lat: candidate.lat, lng: candidate.lng } : undefined);
  if (!proposal.tripId || !point) return state;
  const photoIds = new Set(proposal.photoIds ?? []);
  const placeId = proposal.placeId ?? `place-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const relatedPhotos = state.photos.filter((photo) => photoIds.has(photo.id));
  const dates = relatedPhotos.map((photo) => photo.capturedAt).filter(Boolean).sort();
  const place = {
    id: placeId,
    tripId: proposal.tripId,
    name: candidate.name ?? "AI 建议地点",
    displayName: candidate.name ?? "AI 建议地点",
    center: point,
    coordinatePrecision: candidate.precision ?? "estimated",
    photoIds: Array.from(photoIds),
    timeRange: { start: dates[0] ?? new Date().toISOString(), end: dates.at(-1) ?? dates[0] ?? new Date().toISOString() },
    pending: false,
  };
  return {
    ...state,
    photos: state.photos.map((photo) =>
      photoIds.has(photo.id)
        ? {
            ...photo,
            tripId: proposal.tripId,
            placeNodeId: place.id,
            location: point,
            pendingReason: undefined,
            exifStatus: clearMissingExifStatus({ ...photo, location: point }),
            locationResolution: {
              ...(photo.locationResolution ?? {}),
              status: "confirmed",
              effectiveName: place.name,
              effectivePoint: point,
              confidence: candidate.confidence,
              source: candidate.source ?? "ai_vision",
              precision: candidate.precision ?? "estimated",
              candidateId: candidate.id,
              candidates: photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [],
              requiresUserAction: false,
              updatedAt: new Date().toISOString(),
            },
          }
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

function applyProposal(state, proposal) {
  if (!proposal?.action) return state;
  if (proposal.action === "confirm_location_candidate") return confirmLocationCandidate(state, proposal);
  if (proposal.action === "bind_photos_to_place") return bindPhotosToPlace(state, proposal);
  if (proposal.action === "create_place_from_candidate") return createPlaceFromCandidate(state, proposal);
  if (proposal.action === "confirm_trip_assignment") return confirmTripAssignment(state, proposal);
  if (proposal.action === "merge_trips") return mergeTrips(state, proposal);
  if (proposal.action === "keep_pending") return state;
  if (proposal.action === "resolve_ai_processing_failed") return state;
  return state;
}

export function applyPendingDecision(state, id, { accepted }) {
  const pending = state.pendingItems.find((item) => item.id === id);
  if (!pending) return state;
  if (!accepted) return markPending(state, id, "ignored");
  const applied = applyProposal(state, pending.proposal);
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

export function manualPlaceNames(name) {
  return { zh: name, en: name, local: name };
}

export function visiblePlaceName(place) {
  return place.userEdits?.name ?? place.displayName ?? place.name;
}

export function clearManualExifStatus(photo, overrides = {}) {
  return {
    ...(photo.exifStatus ?? {}),
    time: photo.exifStatus?.time ?? (photo.capturedAt ? "read" : "missing"),
    gps: overrides.gps ?? photo.exifStatus?.gps ?? (photo.location ? "fallback" : "missing"),
  };
}

export function manualLocationCandidate({ name, point, geo, makeId }) {
  return {
    id: makeId("candidate-manual"),
    name,
    localizedNames: { zh: name, en: name, local: name },
    country: geo.country,
    localizedCountryNames: geo.countryNames,
    city: geo.city ?? name,
    localizedCityNames: geo.cityNames,
    point,
    confidence: 1,
    source: "manual",
    precision: "confirmed",
    reason: "用户手动在地球上标记地点，并由本地地名库反查国家/城市。",
  };
}

export function applyManualPlaceAssignment(photo, place, { now, source, reason, precision, candidate }) {
  const previous = photo.manualPlaceAssignment;
  const originalPlaceNodeId = previous?.originalPlaceNodeId ?? photo.placeNodeId;
  const originalLocation = previous?.originalLocation ?? photo.location;
  const originalLocationResolution = previous?.originalLocationResolution ?? photo.locationResolution;
  const originalExifStatus = previous?.originalExifStatus ?? photo.exifStatus;
  const returningToOriginalGpsPlace = Boolean(previous?.originalPlaceNodeId && previous.originalPlaceNodeId === place.id && previous.originalLocation);
  const alreadyInPlaceWithoutOverride = !previous && photo.placeNodeId === place.id;

  if (returningToOriginalGpsPlace) {
    return {
      ...photo,
      tripId: place.tripId,
      placeNodeId: place.id,
      location: previous.originalLocation,
      aiFailure: undefined,
      pendingReason: undefined,
      exifStatus: previous.originalExifStatus ?? clearManualExifStatus({ ...photo, location: previous.originalLocation }),
      locationResolution: previous.originalLocationResolution ?? photo.locationResolution,
      manualPlaceAssignment: undefined,
    };
  }

  if (alreadyInPlaceWithoutOverride) {
    return {
      ...photo,
      tripId: place.tripId,
      placeNodeId: place.id,
      aiFailure: undefined,
      pendingReason: undefined,
      locationResolution: photo.locationResolution
        ? {
            ...photo.locationResolution,
            status: "confirmed",
            requiresUserAction: false,
            updatedAt: now,
          }
        : photo.locationResolution,
    };
  }

  const candidates = candidate
    ? [candidate, ...(photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])]
    : photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [];

  return {
    ...photo,
    tripId: place.tripId,
    placeNodeId: place.id,
    location: place.center,
    aiFailure: undefined,
    pendingReason: undefined,
    exifStatus: clearManualExifStatus(photo, { gps: "fallback" }),
    manualPlaceAssignment: {
      placeId: place.id,
      originalPlaceNodeId,
      originalLocation,
      originalLocationResolution,
      originalExifStatus,
      updatedAt: now,
    },
    locationResolution: {
      ...(photo.locationResolution ?? {}),
      status: "confirmed",
      effectiveName: visiblePlaceName(place),
      effectivePoint: place.center,
      confidence: 1,
      source,
      precision,
      candidates,
      requiresUserAction: false,
      updatedAt: now,
      reason,
    },
  };
}

export function archivePhotoUnlocated(photo, { now }) {
  return {
    ...photo,
    placeNodeId: undefined,
    location: undefined,
    aiFailure: undefined,
    pendingReason: undefined,
    exifStatus: clearManualExifStatus(photo, { gps: "missing" }),
    locationResolution: {
      ...(photo.locationResolution ?? {}),
      status: "rejected",
      effectiveName: undefined,
      effectivePoint: undefined,
      confidence: undefined,
      source: "manual_archived_unlocated",
      candidates: photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [],
      requiresUserAction: false,
      updatedAt: now,
    },
  };
}

export function acceptRelatedMissingPendingItems(pendingItems, pending, photoIds) {
  const relatedPhotoIds = new Set(photoIds);
  return pendingItems.map((item) =>
    item.id === pending.id ||
    (item.status === "open" &&
      ["missing_gps", "missing_time", "confirm_location_candidate", "ai_processing_failed"].includes(item.type) &&
      (item.relatedPhotoIds ?? []).some((photoId) => relatedPhotoIds.has(photoId)))
      ? { ...item, status: "accepted" }
      : item,
  );
}

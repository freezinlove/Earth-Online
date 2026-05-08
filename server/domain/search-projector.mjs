export function buildSearchDocuments(state) {
  return state.photos.map((photo) => {
    const trip = state.trips.find((item) => item.id === photo.tripId);
    const place = state.placeNodes.find((item) => item.id === photo.placeNodeId);
    const ai = photo.ai;
    const locationNames = [
      place?.name,
      place?.displayName,
      photo.locationResolution?.effectiveName,
      ...(ai?.visiblePlaceNames ?? []),
      ...(ai?.locationCandidates ?? []).map((candidate) => candidate.name),
    ].filter(Boolean);
    return {
      id: `search-${photo.id}`,
      photoId: photo.id,
      tripId: photo.tripId,
      placeNodeId: photo.placeNodeId,
      capturedAt: photo.capturedAt,
      tags: photo.tags ?? [],
      locationNames: Array.from(new Set(locationNames)),
      text: [
        photo.title,
        photo.fileName,
        photo.aiCaption,
        photo.tags?.join(" "),
        trip?.title,
        trip?.cities?.join(" "),
        trip?.countries?.join(" "),
        place?.name,
        place?.displayName,
        photo.locationResolution?.effectiveName,
        ...(ai?.visiblePlaceNames ?? []),
        ...(ai?.locationCandidates ?? []).map((candidate) => `${candidate.name} ${candidate.country ?? ""} ${candidate.city ?? ""}`),
        photo.capturedAt,
      ]
        .filter(Boolean)
        .join(" "),
    };
  });
}

import { inferPreset } from "./geo.mjs";

export function buildSearchDocuments(state) {
  return state.photos.map((photo) => {
    const place = state.placeNodes.find((item) => item.id === photo.placeNodeId);
    const ai = photo.ai;
    const preset = inferPreset(
      [place?.name, place?.displayName, photo.locationResolution?.effectiveName, photo.title].filter(Boolean).join(" "),
      place?.center ?? photo.location,
    );
    const locationCandidates = [
      ...(photo.locationResolution?.candidates ?? []),
      ...(ai?.locationCandidates ?? []),
    ];
    const locationNames = [
      place?.name,
      place?.names?.zh,
      place?.names?.en,
      place?.names?.local,
      place?.displayName,
      place?.country,
      place?.countryNames?.zh,
      place?.countryNames?.en,
      place?.countryNames?.local,
      photo.locationResolution?.effectiveName,
      ...(ai?.visiblePlaceNames ?? []),
      ...(ai?.locationCandidates ?? []).map((candidate) => candidate.name),
      ...locationCandidates.flatMap((candidate) => [
        candidate.localizedNames?.zh,
        candidate.localizedNames?.en,
        candidate.localizedNames?.local,
        candidate.localizedCountryNames?.zh,
        candidate.localizedCountryNames?.en,
        candidate.localizedCountryNames?.local,
      ]),
    ].filter(Boolean);
    const geoKeywords = [
      place?.name,
      place?.names?.zh,
      place?.names?.en,
      place?.names?.local,
      place?.displayName,
      place?.country,
      place?.countryNames?.zh,
      place?.countryNames?.en,
      place?.countryNames?.local,
      preset.country,
      preset.city,
      photo.locationResolution?.effectiveName,
      ...(ai?.visiblePlaceNames ?? []),
      ...locationCandidates.flatMap((candidate) => [
        candidate.name,
        candidate.country,
        candidate.city,
        candidate.localizedNames?.zh,
        candidate.localizedNames?.en,
        candidate.localizedNames?.local,
        candidate.localizedCountryNames?.zh,
        candidate.localizedCountryNames?.en,
        candidate.localizedCountryNames?.local,
      ]),
    ].filter(Boolean);
    return {
      id: `search-${photo.id}`,
      photoId: photo.id,
      tripId: photo.tripId,
      placeNodeId: photo.placeNodeId,
      capturedAt: photo.capturedAt,
      tags: photo.tags ?? [],
      locationNames: Array.from(new Set(locationNames)),
      geoKeywords: Array.from(new Set(geoKeywords)),
      titleText: photo.title ?? "",
      tagText: (photo.tags ?? []).join(" "),
      captionText: photo.aiCaption ?? ai?.caption ?? "",
    };
  });
}

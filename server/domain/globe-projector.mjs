import { centerOf, unique } from "./projection-utils.mjs";
import { normalizeCountryDescription, normalizeCountryName } from "./country-normalizer.mjs";
import { inferPreset } from "./geo.mjs";
import { countryCapitalPoint } from "./local-geocoder.mjs";

export function buildGlobeMarkers(state) {
  const markers = [];
  for (const trip of state.trips) {
    const places = state.placeNodes.filter((place) => place.tripId === trip.id && place.center);
    const photos = state.photos.filter((photo) => photo.tripId === trip.id);
    const countryGroups = new Map();

    for (const place of places) {
      const country = inferPlaceCountry(place, photos, trip) ?? "未知国家";
      const group = countryGroups.get(country) ?? { country, countryNames: inferPlaceCountryNames(place, country), places: [], photoIds: [] };
      group.places.push(place);
      group.photoIds.push(...place.photoIds);
      if (!group.countryNames) group.countryNames = inferPlaceCountryNames(place, country);
      countryGroups.set(country, group);
    }

    for (const group of countryGroups.values()) {
      const placeCenters = group.places.map((place) => place.center);
      const timeRange = groupTimeRange(group.places);
      markers.push({
        id: `country-${trip.id}-${group.country}`,
        kind: "country",
        label: group.country,
        labelNames: group.countryNames,
        countryName: group.country,
        countryNames: group.countryNames,
        center: countryCapitalPoint(group.country) ?? centerOf(placeCenters),
        count: unique(group.photoIds).length,
        photoIds: unique(group.photoIds),
        placeIds: group.places.map((place) => place.id),
        tripId: trip.id,
        startTime: timeRange.start,
        endTime: timeRange.end,
        status: group.places.some((place) => place.pending) ? "suggested" : "confirmed",
      });
    }

    for (const place of places) {
      markers.push({
        id: `place-${place.id}`,
        kind: "place",
        label: place.name,
        labelNames: place.names,
        center: place.center,
        count: place.photoIds.length,
        photoIds: place.photoIds,
        placeIds: [place.id],
        tripId: trip.id,
        countryName: inferPlaceCountry(place, photos, trip),
        countryNames: inferPlaceCountryNames(place, inferPlaceCountry(place, photos, trip)),
        startTime: place.timeRange?.start,
        endTime: place.timeRange?.end,
        status: place.pending ? "suggested" : "confirmed",
      });
    }
  }
  return markers.filter((marker) => marker.center);
}

function groupTimeRange(places) {
  const starts = places.map((place) => place.timeRange?.start).filter(Boolean).sort();
  const ends = places.map((place) => place.timeRange?.end).filter(Boolean).sort();
  return {
    start: starts[0],
    end: ends.at(-1),
  };
}

function inferPlaceCountryNames(place, fallback) {
  return normalizeCountryDescription(fallback ?? place.country, place.countryNames).countryNames;
}

function inferPlaceCountry(place, photos, trip) {
  if (place.country && place.country !== "待确认") return normalizeCountryName(place.country);
  const placePhotos = photos.filter((photo) => place.photoIds?.includes(photo.id));
  const candidateCountry = strongestCandidateCountry(placePhotos, place.center);
  if (candidateCountry) return candidateCountry;
  const preset = inferPreset(place.name || place.displayName, place.center);
  if (preset.country && preset.country !== "待确认") return normalizeCountryName(preset.country);
  const text = [
    place.name,
    place.displayName,
    ...placePhotos.flatMap((photo) => [
      photo.userEdits?.title ?? photo.title,
      photo.fileName,
      photo.userEdits?.caption ?? photo.aiCaption,
      ...(photo.userEdits?.tags ?? photo.tags ?? []),
      photo.locationResolution?.effectiveName,
    ]),
  ]
    .filter(Boolean)
    .join(" ");
  const direct = trip.countries?.find((country) => text.includes(country));
  if (direct) return normalizeCountryName(direct);
  return normalizeCountryName(trip.countries?.[0]) ?? "未知国家";
}

function strongestCandidateCountry(photos, center) {
  const country = photos
    .flatMap((photo) => photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])
    .filter((candidate) => candidate?.country && (!candidate.point || distanceKm(candidate.point, center) <= 35))
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0]?.country;
  return normalizeCountryName(country);
}

function distanceKm(start, end) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(end.lat - start.lat);
  const dLng = toRad(end.lng - start.lng);
  const lat1 = toRad(start.lat);
  const lat2 = toRad(end.lat);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

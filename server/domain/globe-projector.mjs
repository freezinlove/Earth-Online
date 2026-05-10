import { centerOf, unique } from "./projection-utils.mjs";
import { inferPreset } from "./geo.mjs";

const countryEnByZh = {
  中国: "China",
  捷克: "Czechia",
  奥地利: "Austria",
  德国: "Germany",
  匈牙利: "Hungary",
  挪威: "Norway",
  瑞士: "Switzerland",
  日本: "Japan",
  法国: "France",
  意大利: "Italy",
  英国: "United Kingdom",
  美国: "United States",
  瑞典: "Sweden",
};

export function buildGlobeMarkers(state) {
  const markers = [];
  for (const trip of state.trips) {
    const places = state.placeNodes.filter((place) => place.tripId === trip.id && place.center);
    const photos = state.photos.filter((photo) => photo.tripId === trip.id);
    const countryGroups = new Map();

    for (const place of places) {
      const country = inferPlaceCountry(place, photos, trip);
      const group = countryGroups.get(country) ?? { country, countryNames: inferPlaceCountryNames(place, country), places: [], photoIds: [] };
      group.places.push(place);
      group.photoIds.push(...place.photoIds);
      if (!group.countryNames) group.countryNames = inferPlaceCountryNames(place, country);
      countryGroups.set(country, group);
    }

    for (const group of countryGroups.values()) {
      markers.push({
        id: `country-${trip.id}-${group.country}`,
        kind: "country",
        label: group.country,
        labelNames: group.countryNames,
        countryName: group.country,
        countryNames: group.countryNames,
        center: centerOf(group.places.map((place) => place.center)),
        count: unique(group.photoIds).length,
        photoIds: unique(group.photoIds),
        placeIds: group.places.map((place) => place.id),
        tripId: trip.id,
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

function inferPlaceCountryNames(place, fallback) {
  if (place.countryNames) {
    return {
      ...place.countryNames,
      en: /[\u4e00-\u9fff]/u.test(place.countryNames.en ?? "") ? countryEnByZh[place.countryNames.zh ?? fallback] ?? place.countryNames.en : place.countryNames.en,
    };
  }
  return fallback ? { zh: fallback, en: countryEnByZh[fallback] ?? fallback, local: fallback } : undefined;
}

function inferPlaceCountry(place, photos, trip) {
  if (place.country && place.country !== "待确认") return place.country;
  const placePhotos = photos.filter((photo) => place.photoIds?.includes(photo.id));
  const candidateCountry = strongestCandidateCountry(placePhotos, place.center);
  if (candidateCountry) return candidateCountry;
  const preset = inferPreset(place.name || place.displayName, place.center);
  if (preset.country && preset.country !== "待确认") return preset.country;
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
  if (direct) return direct;
  return trip.countries?.[0] ?? "未知国家";
}

function strongestCandidateCountry(photos, center) {
  return photos
    .flatMap((photo) => photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])
    .filter((candidate) => candidate?.country && (!candidate.point || distanceKm(candidate.point, center) <= 35))
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0]?.country;
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

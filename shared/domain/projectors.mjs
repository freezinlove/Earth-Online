import { centerOf, dateKey, sortByDate, unique } from "./projection-utils.mjs";
import { normalizeCountryDescription, normalizeCountryName } from "./country-normalizer.mjs";
import { inferPreset } from "./geo.mjs";

function shortTimelineSourceLabel(title) {
  return String(title ?? "").replace(/^20\d{2}\s*/, "");
}

export function buildTimelineSegments(trips, placeNodes = []) {
  const tripSegments = trips
    .slice()
    .sort((a, b) => a.dateRange.start.localeCompare(b.dateRange.start))
    .map((trip) => ({
      id: `segment-${trip.id}`,
      label: trip.title,
      shortLabel: shortTimelineSourceLabel(trip.title),
      start: trip.dateRange.start,
      end: trip.dateRange.end,
      granularity: "day",
      relatedType: "trip",
      relatedId: trip.id,
      photoCount: trip.photoCount,
    }));
  const placeSegments = placeNodes
    .slice()
    .sort((a, b) => String(a.timeRange?.start ?? "").localeCompare(String(b.timeRange?.start ?? "")))
    .map((place) => ({
      id: `segment-${place.id}`,
      label: place.name,
      labelNames: place.names,
      shortLabel: shortTimelineSourceLabel(place.name),
      shortLabelNames: place.names
        ? {
            zh: shortTimelineSourceLabel(place.names.zh ?? place.name),
            en: shortTimelineSourceLabel(place.names.en ?? place.name),
            local: shortTimelineSourceLabel(place.names.local ?? place.name),
          }
        : undefined,
      start: place.timeRange?.start,
      end: place.timeRange?.end,
      granularity: "photo",
      relatedType: "place",
      relatedId: place.id,
      photoCount: place.photoIds?.length ?? 0,
      status: place.pending ? "suggested" : "confirmed",
    }));
  return [...tripSegments, ...placeSegments];
}

export function buildSearchDocuments(state) {
  return state.photos.map((photo) => {
    const place = state.placeNodes.find((item) => item.id === photo.placeNodeId);
    const ai = photo.ai;
    const preset = inferPreset(
      [place?.name, place?.displayName, photo.locationResolution?.effectiveName, photo.title].filter(Boolean).join(" "),
      place?.center ?? photo.location,
    );
    const locationCandidates = [...(photo.locationResolution?.candidates ?? []), ...(ai?.locationCandidates ?? [])];
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
      ...(ai?.locationCandidates ?? []).flatMap((candidate) => [candidate.name, candidate.city, candidate.country]),
      ...locationCandidates.flatMap((candidate) => [candidate.name, candidate.city, candidate.country]),
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
      tags: photo.userEdits?.tags ?? photo.tags ?? [],
      locationNames: Array.from(new Set(locationNames)),
      geoKeywords: Array.from(new Set(geoKeywords)),
      titleText: photo.userEdits?.title ?? photo.title ?? "",
      tagText: (photo.userEdits?.tags ?? photo.tags ?? []).join(" "),
      captionText: photo.userEdits?.caption ?? photo.aiCaption ?? ai?.caption ?? "",
    };
  });
}

export function buildDossierGroups(state) {
  return state.trips.map((trip) => {
    const photos = state.photos
      .filter((photo) => photo.tripId === trip.id)
      .slice()
      .sort((left, right) => sortByDate(left.capturedAt, right.capturedAt));
    const places = state.placeNodes.filter((place) => place.tripId === trip.id);
    const placeById = new Map(places.map((place) => [place.id, place]));
    const photoById = new Map(photos.map((photo) => [photo.id, photo]));
    const days = new Map();

    for (const photo of photos) {
      const day = dateKey(photo.capturedAt);
      const place = photo.placeNodeId ? placeById.get(photo.placeNodeId) : undefined;
      const groupKey = `${day}::${place?.id ?? "unbound"}`;
      const group = days.get(groupKey) ?? { day, start: photo.capturedAt, photoIds: [], placeIds: [], country: undefined, status: "confirmed" };
      group.photoIds.push(photo.id);
      if (place) group.placeIds.push(place.id);
      if (!group.start || (photo.capturedAt && photo.capturedAt < group.start)) group.start = photo.capturedAt;
      if (photo.pendingReason || photo.locationResolution?.status === "suggested" || place?.pending) group.status = "suggested";
      if (photo.locationResolution?.status === "missing") group.status = "missing";
      days.set(groupKey, group);
    }

    return {
      tripId: trip.id,
      countries: buildCountryGroups(
        Array.from(days.values())
          .sort((left, right) => sortByDate(left.start ?? left.day, right.start ?? right.day))
          .map((day) => ({
            ...day,
            ...inferDayCountryDescription(day, photoById, placeById, trip),
          })),
      ),
    };
  });
}

function buildCountryGroups(days) {
  const groups = [];
  for (const day of days) {
    const country = normalizeCountryName(day.country) ?? "未标国家";
    const current = groups.at(-1);
    const normalizedDay = {
      ...day,
      country,
      countryNames: normalizeCountryDescription(country, day.countryNames).countryNames ?? namesFromFallback(country),
      photoIds: unique(day.photoIds),
      placeIds: unique(day.placeIds),
    };
    delete normalizedDay.start;
    if (current?.country === country) current.days.push(normalizedDay);
    else groups.push({ country, countryNames: normalizedDay.countryNames, days: [normalizedDay] });
  }
  return groups;
}

function namesFromFallback(value) {
  return normalizeCountryDescription(value).countryNames;
}

function inferDayCountryDescription(day, photoById, placeById, trip) {
  const placeCountries = unique(day.placeIds)
    .map((id) => placeById.get(id))
    .filter((place) => place?.country && place.country !== "待确认");
  if (placeCountries.length) {
    const country = normalizeCountryName(mostCommon(placeCountries.map((place) => place.country)));
    const place = placeCountries.find((item) => normalizeCountryName(item.country) === country);
    return { country, countryNames: normalizeCountryDescription(country, place?.countryNames).countryNames };
  }

  const candidateCountries = day.photoIds
    .map((id) => photoById.get(id))
    .filter(Boolean)
    .map((photo) => strongestCandidateCountryDescription(photo))
    .filter((item) => item.country);
  if (candidateCountries.length) {
    const country = normalizeCountryName(mostCommon(candidateCountries.map((item) => item.country)));
    const candidate = candidateCountries.find((item) => normalizeCountryName(item.country) === country);
    return { country, countryNames: normalizeCountryDescription(country, candidate?.countryNames).countryNames };
  }

  const fallbackPhoto = photoById.get(day.photoIds[0]);
  const country = fallbackPhoto ? inferPhotoCountry(fallbackPhoto, undefined, trip) : trip.countries?.[0];
  return { country, countryNames: namesFromFallback(country) };
}

function inferPhotoCountry(photo, place, trip) {
  if (place?.country && place.country !== "待确认") return normalizeCountryName(place.country);
  const candidateCountry = strongestCandidateCountry(photo, place);
  if (candidateCountry) return candidateCountry;
  const text = [
    place?.name,
    place?.displayName,
    photo.locationResolution?.effectiveName,
    photo.userEdits?.title ?? photo.title,
    photo.fileName,
    photo.userEdits?.caption ?? photo.aiCaption,
    ...(photo.userEdits?.tags ?? photo.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  const direct = trip.countries?.find((country) => text.includes(country));
  if (direct) return normalizeCountryName(direct);
  return normalizeCountryName(trip.countries?.[0]);
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0];
}

function strongestCandidateCountry(photo, place) {
  const candidates = photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [];
  const country = candidates
    .filter((candidate) => candidate?.country && (!candidate.point || !place?.center || distanceKm(candidate.point, place.center) <= 35))
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0]?.country;
  return normalizeCountryName(country);
}

function strongestCandidateCountryDescription(photo, place) {
  const candidate = (photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])
    .filter((item) => item?.country && (!item.point || !place?.center || distanceKm(item.point, place.center) <= 35))
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0];
  const country = normalizeCountryName(candidate?.country);
  return {
    country,
    countryNames: normalizeCountryDescription(country, candidate?.localizedCountryNames).countryNames,
  };
}

export function buildGlobeMarkers(state, { countryCapitalPoint } = {}) {
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
        center: countryCapitalPoint?.(group.country) ?? centerOf(placeCenters),
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
  const candidateCountry = strongestPlaceCandidateCountry(placePhotos, place.center);
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

function strongestPlaceCandidateCountry(photos, center) {
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

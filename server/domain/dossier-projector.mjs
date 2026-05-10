import { dateKey, sortByDate, unique } from "./projection-utils.mjs";

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
    const country = day.country ?? "未标国家";
    const current = groups.at(-1);
    const normalizedDay = {
      ...day,
      country,
      countryNames: day.countryNames ?? namesFromFallback(country),
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
  return value ? { zh: value, en: countryEnByZh[value] ?? value, local: value } : undefined;
}

function inferDayCountryDescription(day, photoById, placeById, trip) {
  const placeCountries = unique(day.placeIds)
    .map((id) => placeById.get(id))
    .filter((place) => place?.country && place.country !== "待确认");
  if (placeCountries.length) {
    const country = mostCommon(placeCountries.map((place) => place.country));
    const place = placeCountries.find((item) => item.country === country);
    return { country, countryNames: place?.countryNames ?? namesFromFallback(country) };
  }

  const candidateCountries = day.photoIds
    .map((id) => photoById.get(id))
    .filter(Boolean)
    .map((photo) => strongestCandidateCountryDescription(photo))
    .filter((item) => item.country);
  if (candidateCountries.length) {
    const country = mostCommon(candidateCountries.map((item) => item.country));
    const candidate = candidateCountries.find((item) => item.country === country);
    return { country, countryNames: candidate?.countryNames ?? namesFromFallback(country) };
  }

  const fallbackPhoto = photoById.get(day.photoIds[0]);
  const country = fallbackPhoto ? inferPhotoCountry(fallbackPhoto, undefined, trip) : trip.countries?.[0];
  return { country, countryNames: namesFromFallback(country) };
}

function inferPhotoCountry(photo, place, trip) {
  if (place?.country && place.country !== "待确认") return place.country;
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
  if (direct) return direct;
  return trip.countries?.[0];
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0];
}

function strongestCandidateCountry(photo, place) {
  const candidates = photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [];
  return candidates
    .filter((candidate) => candidate?.country && (!candidate.point || !place?.center || distanceKm(candidate.point, place.center) <= 35))
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0]?.country;
}

function strongestCandidateCountryDescription(photo, place) {
  const candidate = (photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])
    .filter((item) => item?.country && (!item.point || !place?.center || distanceKm(item.point, place.center) <= 35))
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0];
  return {
    country: candidate?.country,
    countryNames: candidate?.localizedCountryNames ?? namesFromFallback(candidate?.country),
  };
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

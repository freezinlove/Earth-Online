import { safeArray } from "./arrays.mjs";
import { multiCityCountryLabel, normalizeCountryDescription, uniqueNormalizedCountries } from "./country-normalizer.mjs";
import { isUsableLocation } from "./geo.mjs";
import { hasAiProcessingFailure } from "./photo-status.mjs";

function reconcileResolvedAiFailurePendingItems(pendingItems, photos) {
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  return pendingItems.map((item) => {
    if (item?.type !== "ai_processing_failed" || item.status !== "open") return item;
    const relatedPhotos = safeArray(item.relatedPhotoIds).map((id) => photosById.get(id)).filter(Boolean);
    if (!relatedPhotos.length || relatedPhotos.some(hasAiProcessingFailure)) return item;
    return {
      ...item,
      status: "accepted",
      reason: item.reason ? `${item.reason}（已检测到照片 AI 结果恢复，自动关闭此失败项。）` : "已检测到照片 AI 结果恢复，自动关闭此失败项。",
    };
  });
}

export function normalizeState(state, { reverseGeocode } = {}) {
  const photos = safeArray(state?.photos).map(normalizePhotoCountries);
  const placeNodes = safeArray(state?.placeNodes).map((place) => normalizePlaceCountry(place, { reverseGeocode }));
  const pendingItems = reconcileResolvedAiFailurePendingItems(safeArray(state?.pendingItems), photos);
  const trips = safeArray(state?.trips).map((trip) => normalizeTrip(trip, photos, placeNodes));
  return {
    trips,
    photos,
    placeNodes,
    routes: safeArray(state?.routes),
    importBatches: safeArray(state?.importBatches),
    pendingItems,
  };
}

function normalizePhotoCountries(photo) {
  const normalizeCandidate = (candidate) => {
    if (!candidate) return candidate;
    const country = normalizeCountryDescription(candidate.country, candidate.localizedCountryNames);
    return {
      ...candidate,
      country: country.country ?? candidate.country,
      localizedCountryNames: country.countryNames ?? candidate.localizedCountryNames,
    };
  };

  return {
    ...photo,
    ai: photo.ai
      ? {
          ...photo.ai,
          locationCandidates: safeArray(photo.ai.locationCandidates).map(normalizeCandidate),
        }
      : photo.ai,
    locationResolution: photo.locationResolution
      ? {
          ...photo.locationResolution,
          candidates: safeArray(photo.locationResolution.candidates).map(normalizeCandidate),
        }
      : photo.locationResolution,
  };
}

function normalizePlaceCountry(place, { reverseGeocode } = {}) {
  const inferred = !place.country && isUsableLocation(place.center) ? reverseGeocode?.(place.center, { preferCity: true })?.[0] : undefined;
  const country = normalizeCountryDescription(place.country ?? inferred?.country, place.countryNames ?? inferred?.localizedCountryNames);
  return {
    ...place,
    country: country.country ?? place.country,
    countryNames: country.countryNames ?? place.countryNames,
    city: place.city ?? inferred?.city,
    cityNames: place.cityNames ?? inferred?.localizedCityNames,
  };
}

function normalizeTrip(trip, photos, placeNodes) {
  const tripPlaces = placeNodes.filter((place) => place.tripId === trip.id);
  const tripPhotos = photos.filter((photo) => photo.tripId === trip.id);
  const placeCountries = uniqueNormalizedCountries(tripPlaces.map((place) => place.country));
  const tripCountries = uniqueNormalizedCountries(trip.countries);
  const countries = placeCountries.length ? placeCountries : tripCountries;
  const title = normalizeGeneratedTripTitle(trip, countries);
  return {
    ...trip,
    title,
    countries,
    coverUrl: normalizeTripCoverUrl(trip.coverUrl, tripPhotos),
    photoCount: tripPhotos.length,
    placeNodeCount: tripPlaces.length,
  };
}

function normalizeTripCoverUrl(coverUrl, photos) {
  const current = String(coverUrl ?? "").trim();
  const candidates = photos.flatMap((photo) => [photo.thumbnailUrl, photo.storageUrl]).filter(Boolean);
  if (current && candidates.includes(current)) return current;
  return candidates[0] ?? current;
}

function normalizeGeneratedTripTitle(trip, countries) {
  if (trip.source !== "import") return trip.title;
  const title = String(trip.title ?? "");
  const zhMatch = title.match(/^(\d{4}-\d{2})\s+欧洲多城旅行(?:\s+\d+)?$/u);
  if (zhMatch) return `${zhMatch[1]} ${multiCityCountryLabel(countries, "zh")}旅行`;
  const enMatch = title.match(/^(\d{4}-\d{2})\s+Europe multi-city trip(?:\s+\d+)?$/iu);
  if (enMatch) return `${enMatch[1]} ${multiCityCountryLabel(countries, "en")} trip`;
  return title;
}

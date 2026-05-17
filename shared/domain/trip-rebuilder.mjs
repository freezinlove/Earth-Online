import { uniqueNormalizedCountries } from "./country-normalizer.mjs";
import { buildPlacesForGroup } from "./place-projector.mjs";
import { buildPhotoRoute } from "./route-projector.mjs";

export function rebuildTripsForPhotos(state, photoIds, { makeId, allowExistingPlaceMerge = false }) {
  const affectedTripIds = new Set(state.photos.filter((photo) => photoIds.has(photo.id) && photo.tripId).map((photo) => photo.tripId));
  for (const place of state.placeNodes) {
    if (place.photoIds?.some((id) => photoIds.has(id))) affectedTripIds.add(place.tripId);
  }
  return rebuildTrips(state, affectedTripIds, { makeId, allowExistingPlaceMerge });
}

export function rebuildTrips(state, affectedTripIds, { makeId, allowExistingPlaceMerge = false }) {
  if (affectedTripIds.size === 0) return state;

  let placeNodes = state.placeNodes.filter((place) => !affectedTripIds.has(place.tripId));
  let routes = state.routes.filter((route) => !affectedTripIds.has(route.tripId));
  const affectedPlaceIds = new Set(state.placeNodes.filter((place) => affectedTripIds.has(place.tripId)).map((place) => place.id));
  const photos = state.photos.map((photo) =>
    affectedTripIds.has(photo.tripId) && !affectedPlaceIds.has(photo.placeNodeId) ? { ...photo, placeNodeId: undefined } : { ...photo },
  );

  for (const tripId of affectedTripIds) {
    const tripPhotos = photos.filter((photo) => photo.tripId === tripId);
    const located = tripPhotos.filter((photo) => photo.location);
    if (!located.length) continue;
    const existingPlaces = state.placeNodes.filter((place) => place.tripId === tripId);
    const places = buildPlacesForGroup(tripPhotos, tripId, { makeId, existingPlaces, allowExistingPlaceMerge });
    placeNodes = placeNodes.concat(places);
    routes = routes.concat(buildPhotoRoute(tripId, located));
    for (const place of places) {
      for (const photoId of place.photoIds) {
        const photo = photos.find((item) => item.id === photoId);
        if (photo) photo.placeNodeId = place.id;
      }
    }
  }

  const trips = state.trips.map((trip) => {
    if (!affectedTripIds.has(trip.id)) return trip;
    const tripPlaces = placeNodes.filter((place) => place.tripId === trip.id);
    const countries = uniqueNormalizedCountries(tripPlaces.map((place) => place.country));
    const cities = Array.from(new Set(tripPlaces.map((place) => place.city).filter(Boolean)));
    return {
      ...trip,
      countries: countries.length ? countries : trip.countries,
      cities: cities.length ? cities : trip.cities,
    };
  });

  return { ...state, trips, photos, placeNodes, routes };
}

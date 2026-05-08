import { buildPlacesForGroup } from "./place-projector.mjs";
import { buildPhotoRoute } from "./route-projector.mjs";

export function rebuildTripsForPhotos(state, photoIds, { makeId }) {
  const affectedTripIds = new Set(state.photos.filter((photo) => photoIds.has(photo.id) && photo.tripId).map((photo) => photo.tripId));
  for (const place of state.placeNodes) {
    if (place.photoIds?.some((id) => photoIds.has(id))) affectedTripIds.add(place.tripId);
  }
  return rebuildTrips(state, affectedTripIds, { makeId });
}

export function rebuildTrips(state, affectedTripIds, { makeId }) {
  if (affectedTripIds.size === 0) return state;

  let placeNodes = state.placeNodes.filter((place) => !affectedTripIds.has(place.tripId));
  let routes = state.routes.filter((route) => !affectedTripIds.has(route.tripId));
  const photos = state.photos.map((photo) => (affectedTripIds.has(photo.tripId) ? { ...photo, placeNodeId: undefined } : photo));

  for (const tripId of affectedTripIds) {
    const tripPhotos = photos.filter((photo) => photo.tripId === tripId);
    const located = tripPhotos.filter((photo) => photo.location);
    if (!located.length) continue;
    const places = buildPlacesForGroup(tripPhotos, tripId, { makeId });
    placeNodes = placeNodes.concat(places);
    routes = routes.concat(buildPhotoRoute(tripId, located));
    for (const place of places) {
      for (const photoId of place.photoIds) {
        const photo = photos.find((item) => item.id === photoId);
        if (photo) photo.placeNodeId = place.id;
      }
    }
  }

  return { ...state, photos, placeNodes, routes };
}

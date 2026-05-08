import { safeArray } from "./arrays.mjs";

export function normalizeState(state) {
  const photos = safeArray(state.photos);
  const placeNodes = safeArray(state.placeNodes);
  const trips = safeArray(state.trips).map((trip) => ({
    ...trip,
    photoCount: photos.filter((photo) => photo.tripId === trip.id).length,
    placeNodeCount: placeNodes.filter((place) => place.tripId === trip.id).length,
  }));
  return {
    trips,
    photos,
    placeNodes,
    routes: safeArray(state.routes),
    importBatches: safeArray(state.importBatches),
    pendingItems: safeArray(state.pendingItems),
  };
}

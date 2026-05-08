import { haversineKm } from "./geo.mjs";

export function buildRoute(tripId, places) {
  return {
    id: `route-${tripId}`,
    tripId,
    points: places.map((place) => place.center).filter(Boolean),
    status: places.length > 1 ? "auto_generated" : "incomplete",
  };
}

export function buildPhotoRoute(tripId, photos) {
  const points = photos
    .filter((photo) => photo.location)
    .sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""))
    .map((photo) => photo.location);
  const deduped = [];
  for (const point of points) {
    const previous = deduped.at(-1);
    if (!previous || haversineKm(previous, point) > 0.08) deduped.push(point);
  }
  return {
    id: `route-${tripId}`,
    tripId,
    points: deduped,
    status: deduped.length > 1 ? "auto_generated" : "incomplete",
  };
}

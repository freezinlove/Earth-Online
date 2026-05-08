import { shortTimelineSourceLabel } from "./text-normalizer.mjs";

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
      shortLabel: shortTimelineSourceLabel(place.name),
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

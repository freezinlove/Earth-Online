import type { PlaceNode, TimelineSegment, Trip } from "@/domain/models";

export type TimelineLevel = "global" | "trip";

export type TimeIncisionSegment = {
  id: string;
  kind: "trip" | "place";
  start: string;
  end: string;
  relatedId: string;
  active: boolean;
  label: string;
};

export type TimeIncisionDomain = {
  min: number;
  max: number;
};

export function timeValue(date?: string) {
  const value = date ? new Date(date).getTime() : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

export function formatCompactDateRange(start: string, end: string) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const format = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" });
  const year = Number.isFinite(startDate.getTime()) ? startDate.getFullYear() : "";
  return `${year}.${format.format(startDate).replace("/", ".")}-${format.format(endDate).replace("/", ".")}`;
}

export function percentInDomain(value: number, domain: TimeIncisionDomain) {
  if (domain.max <= domain.min) return 0;
  return Math.max(0, Math.min(100, ((value - domain.min) / (domain.max - domain.min)) * 100));
}

export function segmentBounds(segment: TimeIncisionSegment, domain: TimeIncisionDomain) {
  const start = Math.max(timeValue(segment.start), domain.min);
  const end = Math.min(Math.max(timeValue(segment.end), start), domain.max);
  const left = percentInDomain(start, domain);
  const right = percentInDomain(end, domain);
  return {
    left,
    width: Math.max(0.75, right - left),
  };
}

export function buildGlobalDomain(trips: Trip[], now = new Date()) {
  const firstTripStart = trips.reduce((earliest, trip) => {
    const start = timeValue(trip.dateRange.start);
    return start > 0 && start < earliest ? start : earliest;
  }, Number.POSITIVE_INFINITY);

  const min = Number.isFinite(firstTripStart) ? firstTripStart : now.getTime();
  const max = Math.max(now.getTime(), min + 86400000);
  return { min, max };
}

export function buildTripDomain(trip?: Trip) {
  const min = timeValue(trip?.dateRange.start);
  const end = timeValue(trip?.dateRange.end);
  const max = Math.max(end, min + 86400000);
  return { min, max };
}

export function buildTripSegments(segments: TimelineSegment[], selectedTripId: string): TimeIncisionSegment[] {
  return segments
    .filter((segment) => segment.relatedType === "trip")
    .map((segment) => ({
      id: segment.id,
      kind: "trip" as const,
      start: segment.start,
      end: segment.end,
      relatedId: segment.relatedId,
      active: segment.relatedId === selectedTripId,
      label: segment.label,
    }));
}

export function buildPlaceSegments(places: PlaceNode[], selectedPlaceId?: string): TimeIncisionSegment[] {
  return places
    .slice()
    .sort((a, b) => a.timeRange.start.localeCompare(b.timeRange.start))
    .map((place) => ({
      id: `time-place-${place.id}`,
      kind: "place" as const,
      start: place.timeRange.start,
      end: place.timeRange.end,
      relatedId: place.id,
      active: place.id === selectedPlaceId,
      label: place.name,
    }));
}

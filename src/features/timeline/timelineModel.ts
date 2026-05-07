import type { PlaceNode, TimelineSegment, Trip } from "@/domain/models";
import type { TravelMarker } from "@/features/earth/EarthStage";

export type TimelineLevel = "global" | "trip";

export type TimeIncisionSegment = {
  id: string;
  kind: "trip" | "place";
  start: string;
  end: string;
  relatedId: string;
  active: boolean;
  label: string;
  shortLabel: string;
};

export type TimeIncisionDomain = {
  min: number;
  max: number;
};

export type TimeIncisionTick = {
  id: string;
  kind: "major" | "minor";
  value: number;
  label?: string;
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

function cleanTimelineLabel(label: string, kind: "trip" | "place") {
  return label
    .replace(/20\d{2}/g, "")
    .replace(/[-–—_/.\s]*(0?[1-9]|1[0-2])(?=\D|$)/g, "")
    .replace(/[·_｜|]/g, " ")
    .replace(/待确认地点|待确认|未命名地点|临时地点|未知地点|地点\s*\d*/g, "")
    .replace(kind === "trip" ? /多国|多城|旅行|之旅|自驾|档案|路线|回忆/g : /旅行|之旅|档案|路线|回忆/g, "")
    .replace(kind === "place" ? /街景|山景|夜景|风景|湖景|河景|随拍|路边|附近|黄昏|清晨/g : /()/g, "")
    .replace(/[()[\]{}【】「」『』]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export function shortTimelineLabel(label: string, kind: "trip" | "place") {
  const value = cleanTimelineLabel(label, kind);
  if (!value) return "";
  const max = kind === "trip" ? 6 : 5;
  return value.length > max ? value.slice(0, max) : value;
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
      shortLabel: shortTimelineLabel(segment.label, "trip"),
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
      shortLabel: shortTimelineLabel(place.name, "place"),
    }));
}

export function buildPlaceSegmentsFromMarkers(markers: TravelMarker[], selectedPlaceId?: string): TimeIncisionSegment[] {
  return markers
    .filter((marker) => marker.kind === "place" && marker.startTime)
    .slice()
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))
    .map((marker) => {
      const relatedId = marker.placeIds?.[0] ?? marker.id;
      const active = selectedPlaceId ? Boolean(marker.placeIds?.includes(selectedPlaceId)) : false;
      const start = marker.startTime ?? marker.endTime ?? "";
      const end = marker.endTime ?? marker.startTime ?? "";
      return {
        id: `time-marker-${marker.id}`,
        kind: "place" as const,
        start,
        end,
        relatedId,
        active,
        label: marker.label,
        shortLabel: shortTimelineLabel(marker.label, "place"),
      };
    });
}

function monthStart(year: number, monthIndex: number) {
  return new Date(year, monthIndex, 1);
}

function addMonth(date: Date) {
  return monthStart(date.getFullYear(), date.getMonth() + 1);
}

export function buildGlobalTicks(domain: TimeIncisionDomain): TimeIncisionTick[] {
  const ticks: TimeIncisionTick[] = [];
  const start = new Date(domain.min);
  const end = new Date(domain.max);
  let cursor = monthStart(start.getFullYear(), start.getMonth());

  while (cursor.getTime() <= end.getTime()) {
    const value = cursor.getTime();
    const isYear = cursor.getMonth() === 0;
    ticks.push({
      id: `global-${cursor.getFullYear()}-${cursor.getMonth()}`,
      kind: isYear ? "major" : "minor",
      value,
      label: isYear ? String(cursor.getFullYear()) : undefined,
    });
    cursor = addMonth(cursor);
  }

  const firstYear = new Date(domain.min).getFullYear();
  if (!ticks.some((tick) => tick.kind === "major" && tick.label === String(firstYear))) {
    ticks.unshift({ id: `global-start-${firstYear}`, kind: "major", value: domain.min, label: String(firstYear) });
  }

  return ticks;
}

export function buildTripTicks(domain: TimeIncisionDomain): TimeIncisionTick[] {
  const ticks: TimeIncisionTick[] = [];
  const start = new Date(domain.min);
  const end = new Date(domain.max);
  let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const shownMonths = new Set<string>();

  while (cursor.getTime() <= end.getTime()) {
    const value = cursor.getTime();
    const monthLabel = String(cursor.getMonth() + 1).padStart(2, "0");
    const monthKey = `${cursor.getFullYear()}-${cursor.getMonth()}`;
    const isMonthStart = cursor.getDate() === 1 || !shownMonths.has(monthKey);
    if (isMonthStart) shownMonths.add(monthKey);
    ticks.push({
      id: `trip-${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`,
      kind: isMonthStart ? "major" : "minor",
      value,
      label: isMonthStart ? monthLabel : undefined,
    });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }

  return ticks;
}

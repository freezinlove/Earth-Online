import type { GlobeMarker, LocalizedNames, Photo, PlaceNode, SearchDocument, TimelineSegment, Trip } from "@/domain/models";
import { countryLabel as localizedCountryLabel, markerLabel as localizedMarkerLabel, placeLabel as localizedPlaceLabel, timelineSegmentLabel } from "@/domain/geoLabels";
import type { Locale } from "@/store/appStore";

export function placeLabel(place?: Pick<PlaceNode, "name" | "names" | "displayName" | "userEdits">, locale: Locale = "zh") {
  return localizedPlaceLabel(place, locale);
}

export function markerLabel(marker: Pick<GlobeMarker, "label" | "labelNames">, locale: Locale = "zh") {
  return localizedMarkerLabel(marker, locale);
}

export function timelineLabel(segment: Pick<TimelineSegment, "label" | "labelNames">, locale: Locale = "zh") {
  return timelineSegmentLabel(segment, locale);
}

export function countryLabel(value?: string, fallback?: string, locale?: Locale): string;
export function countryLabel(value?: LocalizedNames, fallback?: string, locale?: Locale): string;
export function countryLabel(value?: string | LocalizedNames, fallback?: string, locale: Locale = "zh") {
  if (typeof value === "object") return localizedCountryLabel(value, fallback, locale);
  return localizedCountryLabel(value ? { zh: value } : undefined, fallback, locale);
}

export function tripLabel(trip?: Pick<Trip, "title">) {
  return trip?.title ?? "未命名旅行";
}

export function photoLabel(photo?: Pick<Photo, "fileName" | "title" | "userEdits">) {
  return photo?.userEdits?.title ?? photo?.title ?? photo?.fileName ?? "未命名照片";
}

export function photoAltText(photo?: Pick<Photo, "aiCaption" | "fileName" | "title" | "userEdits">) {
  return photo?.userEdits?.title ?? photo?.title ?? photo?.userEdits?.caption ?? photo?.aiCaption ?? photo?.fileName ?? "旅行照片";
}

export function searchLocationLabels(document?: Pick<SearchDocument, "locationNames">) {
  return document?.locationNames ?? [];
}

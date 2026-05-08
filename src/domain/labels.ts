import type { GlobeMarker, Photo, PlaceNode, SearchDocument, TimelineSegment, Trip } from "@/domain/models";

export function placeLabel(place?: Pick<PlaceNode, "name">) {
  return place?.name ?? "未标地点";
}

export function markerLabel(marker: Pick<GlobeMarker, "label">) {
  return marker.label;
}

export function timelineLabel(segment: Pick<TimelineSegment, "label">) {
  return segment.label;
}

export function countryLabel(value?: string) {
  return value || "未标国家";
}

export function tripLabel(trip?: Pick<Trip, "title">) {
  return trip?.title ?? "未命名旅行";
}

export function photoLabel(photo?: Pick<Photo, "fileName" | "title">) {
  return photo?.title ?? photo?.fileName ?? "未命名照片";
}

export function photoAltText(photo?: Pick<Photo, "aiCaption" | "fileName" | "title">) {
  return photo?.title ?? photo?.aiCaption ?? photo?.fileName ?? "旅行照片";
}

export function searchLocationLabels(document?: Pick<SearchDocument, "locationNames">) {
  return document?.locationNames ?? [];
}

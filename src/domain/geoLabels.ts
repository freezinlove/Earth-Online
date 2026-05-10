import type { GlobeMarker, LocalizedNames, PlaceNode, TimelineSegment } from "@/domain/models";
import type { Locale } from "@/store/appStore";

const countryEnByZh: Record<string, string> = {
  中国: "China",
  捷克: "Czechia",
  奥地利: "Austria",
  德国: "Germany",
  匈牙利: "Hungary",
  挪威: "Norway",
  瑞士: "Switzerland",
  日本: "Japan",
  法国: "France",
  意大利: "Italy",
  英国: "United Kingdom",
  美国: "United States",
  瑞典: "Sweden",
};

function hasHan(value?: string) {
  return /[\u4e00-\u9fff]/u.test(value ?? "");
}

export function localizedName(names: LocalizedNames | undefined, fallback: string | undefined, locale: Locale) {
  const preferred = names?.[locale];
  if (preferred) return preferred;
  if (locale === "zh") return names?.en ?? names?.local ?? fallback ?? "未标地点";
  return names?.local ?? names?.zh ?? fallback ?? "Unmarked place";
}

export function placeLabel(place: Pick<PlaceNode, "name" | "names"> | undefined, locale: Locale) {
  return localizedName(place?.names, place?.name, locale);
}

export function countryLabel(names: LocalizedNames | undefined, fallback: string | undefined, locale: Locale) {
  if (locale === "en") {
    const preferred = names?.en;
    if (preferred && !hasHan(preferred)) return preferred;
    const mapped = countryEnByZh[names?.zh ?? fallback ?? ""];
    if (mapped) return mapped;
  }
  return localizedName(names, fallback, locale);
}

export function markerLabel(marker: Pick<GlobeMarker, "label" | "labelNames">, locale: Locale) {
  return localizedName(marker.labelNames, marker.label, locale);
}

export function timelineSegmentLabel(segment: Pick<TimelineSegment, "label" | "labelNames">, locale: Locale) {
  return localizedName(segment.labelNames, segment.label, locale);
}

export function timelineSegmentShortLabel(segment: Pick<TimelineSegment, "shortLabel" | "shortLabelNames" | "label" | "labelNames">, locale: Locale) {
  return localizedName(segment.shortLabelNames ?? segment.labelNames, segment.shortLabel ?? segment.label, locale);
}

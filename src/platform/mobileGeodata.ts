import type { AppSnapshot } from "@/services/apiClient";
import type { GeoPoint, LocationCandidate, TimelineSegment } from "@/domain/models";
import { forwardNativeGeonameRows, nativeCountryCapitalRows, nearbyNativeGeonameRows } from "@/platform/nativeGeodata";
import type { MobilePersistedState } from "@/platform/mobileStateStore";
import { normalizeCountryDescription } from "../../shared/domain/country-normalizer.mjs";
import { normalizeLocale } from "../../shared/domain/geo.mjs";
import { buildDossierGroups, buildGlobeMarkers, buildSearchDocuments, buildTimelineSegments } from "../../shared/domain/projectors.mjs";
import { countryCapitalPointFromRows, forwardGeocodeFromRows, forwardGeocodePlan, reverseGeocodeFromRows } from "../../shared/geodata/geocoder-core.mjs";

let nativeCapitalRowsCache: unknown[] | undefined;

async function getNativeCapitalRows() {
  if (nativeCapitalRowsCache) return nativeCapitalRowsCache;
  try {
    nativeCapitalRowsCache = await nativeCountryCapitalRows();
    return nativeCapitalRowsCache;
  } catch {
    return [];
  }
}

export async function projectMobileState(state: MobilePersistedState): Promise<AppSnapshot> {
  const capitalRows = await getNativeCapitalRows();
  const countryCapitalPoint = capitalRows.length ? (country: string) => countryCapitalPointFromRows(country, capitalRows) : undefined;
  return {
    ...state,
    timelineSegments: buildTimelineSegments(state.trips, state.placeNodes) as TimelineSegment[],
    globeMarkers: buildGlobeMarkers(state, { countryCapitalPoint }),
    dossierGroups: buildDossierGroups(state),
    searchDocuments: buildSearchDocuments(state),
  };
}

export async function geocodeMobileAiCandidate(candidate: LocationCandidate, { makeId, locale = "zh" }: { makeId: (prefix: string) => string; locale?: "zh" | "en" }) {
  if (!candidate?.name && !candidate?.city) return candidate;
  const plan = forwardGeocodePlan({ name: candidate.name, city: candidate.city || candidate.name, country: candidate.country });
  const rows = await forwardNativeGeonameRows(plan.queries).catch(() => []);
  const fallback = forwardGeocodeFromRows({ name: candidate.name, city: candidate.city || candidate.name, country: candidate.country }, rows, { makeId })[0];
  if (!fallback?.point) return candidate;
  return {
    ...candidate,
    point: fallback.point,
    city: candidate.city ?? fallback.city,
    country: candidate.country ?? fallback.country,
    localizedNames: candidate.localizedNames ?? fallback.localizedNames,
    localizedCountryNames: candidate.localizedCountryNames ?? fallback.localizedCountryNames,
    confidence: Math.max(Number(candidate.confidence ?? 0), Math.min(0.72, Number(fallback.confidence ?? 0.6))),
    source: "geocode" as const,
    precision: "estimated" as const,
    reason:
      normalizeLocale(locale) === "en"
        ? `${candidate.reason || "AI provided a place name."} Local gazetteer coordinates were added from ${fallback.name}.`
        : `${candidate.reason || "AI 给出了地点名。"} 已用本地地名库补入估计坐标：${fallback.name}。`,
  };
}

export async function reverseMobileCandidates(point: GeoPoint, { makeId, preferCity = false }: { makeId: (prefix: string) => string; preferCity?: boolean }) {
  const rows = await nearbyNativeGeonameRows(point).catch(() => []);
  return reverseGeocodeFromRows(point, rows, { makeId, preferCity }) as LocationCandidate[];
}

export async function manualMobileGeoDescription(point: GeoPoint, { makeId }: { makeId: (prefix: string) => string }) {
  const candidate = (await reverseMobileCandidates(point, { makeId, preferCity: true }))[0];
  const country = normalizeCountryDescription(candidate?.country, candidate?.localizedCountryNames);
  return {
    country: country.country,
    countryNames: country.countryNames,
    city: candidate?.city,
    cityNames: candidate?.localizedCityNames,
  };
}

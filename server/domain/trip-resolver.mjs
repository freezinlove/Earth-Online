import { daysBetweenRanges, toDateInput } from "./dates.mjs";
import { inferPreset, isUsableLocation } from "./geo.mjs";

export function groupImportedPhotos(photos) {
  const sorted = photos.slice().sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  const groups = [];
  for (const photo of sorted) {
    const previous = groups.at(-1)?.at(-1);
    if (!previous || !photo.capturedAt || !previous.capturedAt) {
      groups.push([photo]);
      continue;
    }
    const gapDays = (localTimeMs(photo.capturedAt) - localTimeMs(previous.capturedAt)) / 86400000;
    if (gapDays > 14) groups.push([photo]);
    else groups.at(-1).push(photo);
  }
  return groups.length ? groups : [photos];
}

function localTimeMs(value) {
  return new Date(String(value ?? "").replace(/Z$/i, "")).getTime();
}

export function dominantPresetsForPhotos(photos) {
  const geoItems = photos.flatMap(photoGeoItems);
  const cityCounts = new Map();
  const countryCounts = new Map();
  for (const item of geoItems) {
    if (item.city && !String(item.city).includes("待确认")) cityCounts.set(item.city, (cityCounts.get(item.city) ?? 0) + item.weight);
    if (item.country && item.country !== "待确认") countryCounts.set(item.country, (countryCounts.get(item.country) ?? 0) + item.weight);
  }
  const rankedCities = Array.from(cityCounts.entries()).sort((a, b) => b[1] - a[1]).map(([city]) => city);
  const rankedCountries = Array.from(countryCounts.entries()).sort((a, b) => b[1] - a[1]).map(([country]) => country);
  return {
    cities: rankedCities.length ? rankedCities.slice(0, 6) : ["待确认地点"],
    countries: rankedCountries.slice(0, 6),
  };
}

function photoGeoItems(photo) {
  const items = [];
  const candidates = photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [];
  for (const candidate of candidates) {
    if (!candidate?.country && !candidate?.city && !candidate?.name) continue;
    items.push({
      city: candidate.city || candidate.name,
      country: candidate.country,
      weight: Math.max(0.1, Number(candidate.confidence ?? 0.5)) * 2,
    });
  }
  if (photo.locationResolution?.effectiveName) {
    items.push({
      city: photo.locationResolution.effectiveName,
      country: candidates.find((candidate) => candidate.name === photo.locationResolution.effectiveName || candidate.city === photo.locationResolution.effectiveName)?.country,
      weight: photo.locationResolution.status === "confirmed" ? 2 : 1,
    });
  }
  if (isUsableLocation(photo.location)) {
    const preset = inferPreset(photo.fileName, photo.location);
    if (!preset.city.includes("待确认")) items.push({ city: preset.city, country: preset.country, weight: 1.5 });
  }
  return items;
}

export function findAdjacentTrip(state, group) {
  const dates = group.map((photo) => photo.capturedAt).filter(Boolean).sort();
  const groupStart = toDateInput(dates[0]);
  const groupEnd = toDateInput(dates.at(-1));
  return state.trips
    .filter((trip) => trip.source === "import")
    .map((trip) => ({ trip, gap: daysBetweenRanges(groupStart, groupEnd, trip.dateRange.start, trip.dateRange.end) }))
    .filter((item) => item.gap <= 14)
    .sort((a, b) => a.gap - b.gap)[0]?.trip;
}

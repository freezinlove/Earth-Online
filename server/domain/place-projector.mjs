import { haversineKm, inferPreset } from "./geo.mjs";
import { bestDisplayName, candidateLocalityKey, cleanPlaceName, collectLocationCandidates, isWeakPlaceName, selectPlaceDescription } from "./place-name-selector.mjs";

const DEFAULT_CLUSTER_RADIUS_KM = 2.5;
const SAME_CITY_CLUSTER_RADIUS_KM = 12;
const SAME_NAME_CLUSTER_RADIUS_KM = 25;
const MATURITY_PHOTO_THRESHOLD = 4;

export function buildPlacesForGroup(group, tripId, { makeId, existingPlaces = [], allowExistingPlaceMerge = false }) {
  const located = group
    .filter((photo) => photo.location)
    .sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  const clusters = [];
  for (const photo of located) {
    const context = photoPlaceContext(photo);
    const target = findExistingPlaceCluster(clusters, photo) ?? (allowExistingPlaceMerge || !photo.placeNodeId ? findMergeTarget(clusters, photo, context) : undefined);
    if (target) addPhotoToCluster(target, photo, context);
    else clusters.push(createCluster(photo, context));
  }

  const usedExistingPlaceIds = new Set();
  return clusters
    .sort((left, right) => (left.photos[0]?.capturedAt ?? "").localeCompare(right.photos[0]?.capturedAt ?? ""))
    .map((cluster) => {
      const center = cluster.center;
      const existing = findExistingPlaceForCluster(
        cluster,
        existingPlaces.filter((place) => !usedExistingPlaceIds.has(place.id)),
      );
      if (existing?.id) usedExistingPlaceIds.add(existing.id);
      const preserveName = shouldPreserveExistingName(existing, cluster.photos) ? existing.name : undefined;
      const description = selectPlaceDescription(cluster.photos, center, { preserveName });
      return {
        id: existing?.id ?? makeId("place"),
        tripId,
        name: description.name,
        names: existing && preserveName ? existing.names ?? description.names : description.names,
        displayName: existing && preserveName ? existing.displayName ?? bestDisplayName(cluster.photos, description.name) : bestDisplayName(cluster.photos, description.name),
        country: description.country,
        countryNames: existing && preserveName ? existing.countryNames ?? description.countryNames : description.countryNames,
        city: description.city,
        cityNames: existing && preserveName ? existing.cityNames ?? description.cityNames : description.cityNames,
        center,
        photoIds: cluster.photos.map((photo) => photo.id),
        timeRange: { start: cluster.photos[0]?.capturedAt, end: cluster.photos.at(-1)?.capturedAt },
        pending: cluster.photos.some((photo) => photo.pendingReason),
      };
    });
}

function createCluster(photo, context) {
  return {
    photos: [photo],
    center: { ...photo.location },
    context,
    placeNodeId: photo.placeNodeId,
  };
}

function addPhotoToCluster(cluster, photo, context) {
  cluster.photos.push(photo);
  const count = cluster.photos.length;
  cluster.center = {
    lat: (cluster.center.lat * (count - 1) + photo.location.lat) / count,
    lng: (cluster.center.lng * (count - 1) + photo.location.lng) / count,
  };
  cluster.context = mergeContext(cluster.context, context);
  cluster.placeNodeId = cluster.placeNodeId ?? photo.placeNodeId;
}

function findMergeTarget(clusters, photo, context) {
  let best;
  for (const cluster of clusters) {
    const distance = haversineKm(photo.location, cluster.center);
    const relation = contextRelation(cluster.context, context);
    const threshold = relation.sameName ? SAME_NAME_CLUSTER_RADIUS_KM : relation.sameCity ? SAME_CITY_CLUSTER_RADIUS_KM : DEFAULT_CLUSTER_RADIUS_KM;
    if (distance > threshold) continue;
    const score = distance - (relation.sameName ? 20 : 0) - (relation.sameCity ? 8 : 0) - (relation.sameCountry ? 1 : 0);
    if (!best || score < best.score) best = { cluster, score };
  }
  return best?.cluster;
}

function findExistingPlaceCluster(clusters, photo) {
  if (!photo.placeNodeId) return undefined;
  return clusters.find((cluster) => cluster.placeNodeId === photo.placeNodeId);
}

function photoPlaceContext(photo) {
  const candidates = collectLocationCandidates([photo])
    .filter((candidate) => !candidate.point || !photo.location || haversineKm(candidate.point, photo.location) <= 35)
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0));
  const preset = inferPreset(photo.fileName, photo.location);
  const cities = new Set();
  const countries = new Set();
  const names = new Set();
  const localityKeys = new Set();

  for (const candidate of candidates) {
    addClean(cities, candidate.city);
    addClean(names, candidate.name);
    addClean(names, candidate.city);
    const localityKey = candidateLocalityKey(candidate);
    if (localityKey) localityKeys.add(localityKey);
    if (candidate.country && candidate.country !== "待确认") countries.add(candidate.country);
  }
  if (!preset.city.includes("待确认")) {
    addClean(cities, preset.city);
    addClean(names, preset.city);
  }
  if (preset.country && preset.country !== "待确认") countries.add(preset.country);

  return {
    cities,
    countries,
    names,
    localityKeys,
  };
}

function mergeContext(left, right) {
  return {
    cities: new Set([...left.cities, ...right.cities]),
    countries: new Set([...left.countries, ...right.countries]),
    names: new Set([...left.names, ...right.names]),
    localityKeys: new Set([...left.localityKeys, ...right.localityKeys]),
  };
}

function contextRelation(left, right) {
  const sameCountry = intersects(left.countries, right.countries);
  const sameLocality = intersects(left.localityKeys, right.localityKeys);
  const sameCity = sameLocality || (compatibleCountry(left, right) && intersects(left.cities, right.cities));
  const sameName = compatibleCountry(left, right) && (intersects(left.names, right.names) || hasContainedName(left.names, right.names));
  return { sameCountry, sameCity, sameName };
}

function compatibleCountry(left, right) {
  return !left.countries.size || !right.countries.size || intersects(left.countries, right.countries);
}

function intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function hasContainedName(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return true;
    }
  }
  return false;
}

function addClean(target, value) {
  const clean = cleanPlaceName(value);
  if (clean && !clean.includes("待确认") && !clean.includes("某地")) target.add(clean);
}

function findExistingPlaceForCluster(cluster, existingPlaces) {
  const clusterPhotoIds = new Set(cluster.photos.map((photo) => photo.id));
  return existingPlaces
    .map((place) => ({
      place,
      overlap: (place.photoIds ?? []).filter((id) => clusterPhotoIds.has(id)).length,
      distance: place.center ? haversineKm(place.center, cluster.center) : Infinity,
      explicit: cluster.placeNodeId === place.id,
    }))
    .filter((item) => item.explicit || item.overlap > 0 || item.distance <= DEFAULT_CLUSTER_RADIUS_KM)
    .sort((left, right) => Number(right.explicit) - Number(left.explicit) || right.overlap - left.overlap || left.distance - right.distance)[0]?.place;
}

function shouldPreserveExistingName(existing, photos) {
  if (!existing) return false;
  if (String(existing.id).startsWith("manual-place")) return true;
  if (isWeakPlaceName(existing.name)) return false;
  const beforeCount = existing.photoIds?.length ?? 0;
  const afterCount = photos.length;
  const previousPhotoIds = new Set(existing.photoIds ?? []);
  const newlyBoundPhotos = photos.filter((photo) => !previousPhotoIds.has(photo.id));
  const existingPhotos = photos.filter((photo) => previousPhotoIds.has(photo.id));
  const hadGpsBefore = existingPhotos.some(hasReadGps);
  const gainsFirstGps = !hadGpsBefore && newlyBoundPhotos.some(hasReadGps);
  if (gainsFirstGps) return false;
  if (beforeCount < MATURITY_PHOTO_THRESHOLD && afterCount >= MATURITY_PHOTO_THRESHOLD) return false;
  return true;
}

function hasReadGps(photo) {
  return photo.exifStatus?.gps === "read" || photo.locationResolution?.source === "exif";
}

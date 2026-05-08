import { haversineKm, inferPreset } from "./geo.mjs";

const GENERIC_PLACE_SUFFIX = /地点\s*\d+$/u;
const SCENE_WORDS = ["街景", "山景", "夜景", "风景", "湖景", "河景", "随拍", "路边", "附近", "小憩", "自拍", "合影", "打卡", "候机", "时光", "暮色", "晨雾"];
const PLACE_WORDS = ["桥", "堡", "宫", "馆", "院", "街", "路", "河", "湖", "山", "机场", "酒店", "咖啡馆", "教堂", "广场", "Straße", "Street"];
const DEFAULT_CLUSTER_RADIUS_KM = 2.5;
const SAME_CITY_CLUSTER_RADIUS_KM = 12;
const SAME_NAME_CLUSTER_RADIUS_KM = 25;

export function buildPlacesForGroup(group, tripId, { makeId }) {
  const located = group
    .filter((photo) => photo.location)
    .sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  const clusters = [];
  for (const photo of located) {
    const context = photoPlaceContext(photo);
    const target = findMergeTarget(clusters, photo, context);
    if (target) addPhotoToCluster(target, photo, context);
    else clusters.push(createCluster(photo, context));
  }
  return clusters
    .sort((left, right) => (left.photos[0]?.capturedAt ?? "").localeCompare(right.photos[0]?.capturedAt ?? ""))
    .map((cluster, index) => {
      const center = cluster.center;
      const { name, displayName, country, city } = describeCluster(cluster.photos, center, index);
      return {
        id: makeId("place"),
        tripId,
        name,
        displayName,
        country,
        city,
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

function photoPlaceContext(photo) {
  const candidates = (photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])
    .filter(Boolean)
    .filter((candidate) => !candidate.point || !photo.location || haversineKm(candidate.point, photo.location) <= 35)
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0));
  const preset = inferPreset(photo.fileName, photo.location);
  const effectiveName = cleanPlaceName(photo.locationResolution?.effectiveName);
  const cities = new Set();
  const countries = new Set();
  const names = new Set();

  for (const candidate of candidates) {
    addClean(cities, candidate.city);
    addClean(names, candidate.name);
    addClean(names, candidate.city);
    if (candidate.country && candidate.country !== "待确认") countries.add(candidate.country);
  }
  addClean(cities, effectiveName);
  addClean(names, effectiveName);
  if (!preset.city.includes("待确认")) {
    addClean(cities, preset.city);
    addClean(names, preset.city);
  }
  if (preset.country && preset.country !== "待确认") countries.add(preset.country);

  for (const value of [
    photo.title,
    photo.locationResolution?.effectiveName,
    ...(photo.tags ?? []),
    ...(photo.ai?.visiblePlaceNames ?? []),
  ]) {
    addClean(names, stripSceneSuffix(cleanPlaceName(value)));
  }

  return {
    cities,
    countries,
    names,
  };
}

function mergeContext(left, right) {
  return {
    cities: new Set([...left.cities, ...right.cities]),
    countries: new Set([...left.countries, ...right.countries]),
    names: new Set([...left.names, ...right.names]),
  };
}

function contextRelation(left, right) {
  const sameCountry = intersects(left.countries, right.countries);
  const sameCity = compatibleCountry(left, right) && intersects(left.cities, right.cities);
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

export function describeCluster(photos, center, index = 0) {
  const candidates = photos
    .flatMap((photo) => photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])
    .filter(Boolean)
    .filter((candidate) => !candidate.point || haversineKm(candidate.point, center) <= 35)
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0));
  const candidate = candidates[0];
  const preset = inferPreset(photos[0]?.fileName, center);
  const city = candidate?.city || candidate?.name || bestEffectiveName(photos) || preset.city;
  const country = candidate?.country || preset.country;
  const name = bestPlaceName(photos, city, candidates) || cleanPlaceName(candidate?.name) || cleanPlaceName(city) || `${preset.city}地点 ${index + 1}`;
  const displayName = bestDisplayName(photos, name) || name;
  return {
    name,
    displayName,
    country,
    city: cleanPlaceName(city) || city,
  };
}

function bestEffectiveName(photos) {
  return photos.map((photo) => photo.locationResolution?.effectiveName).find(Boolean);
}

function bestPlaceName(photos, city, candidates) {
  const cleanCity = cleanPlaceName(city);
  const candidateNames = candidates.flatMap((candidate) => [candidate.name, candidate.city]).map(cleanPlaceName).filter(Boolean);
  const topConfidence = Number(candidates[0]?.confidence ?? 0);
  const specificCandidate = candidates
    .filter((candidate) => Number(candidate.confidence ?? 0) >= topConfidence - 0.05)
    .map((candidate) => cleanPlaceName(candidate.name))
    .find((value) => value && value !== cleanCity && value.length >= 3 && !value.includes("某地"));
  if (specificCandidate) return specificCandidate;

  const tagPlace = photos
    .flatMap((photo) => photo.tags ?? [])
    .map(cleanPlaceName)
    .map(stripSceneSuffix)
    .filter(Boolean)
    .find((value) => isUsablePlaceName(value, cleanCity, candidateNames));
  if (tagPlace) return tagPlace;

  const visiblePlace = photos
    .flatMap((photo) => photo.ai?.visiblePlaceNames ?? [])
    .map(cleanPlaceName)
    .map(stripSceneSuffix)
    .filter(Boolean)
    .find((value) => isUsablePlaceName(value, cleanCity, candidateNames));
  if (visiblePlace) return visiblePlace;

  const titlePlace = photos
    .map((photo) => photo.title)
    .map(cleanPlaceName)
    .map(stripSceneSuffix)
    .find((value) => isUsablePlaceName(value, cleanCity, candidateNames));
  if (titlePlace) return titlePlace;

  return cleanCity;
}

function bestDisplayName(photos, placeName) {
  const title = photos
    .map((photo) => photo.title)
    .map(cleanPlaceName)
    .find((value) => value && value.length >= 3 && !value.includes("地点"));
  if (title) return title;

  const tag = photos
    .flatMap((photo) => photo.tags ?? [])
    .map(cleanPlaceName)
    .find((value) => value && value.length >= 3 && !value.includes("地点"));
  return tag ?? placeName;
}

function isUsablePlaceName(value, city, candidateNames) {
  if (!value || value.length < 2 || value.includes("地点") || value.includes("某地")) return false;
  if (SCENE_WORDS.some((word) => value === word || value.endsWith(word))) return false;
  return [city, ...candidateNames].some((name) => name && value.includes(name)) || PLACE_WORDS.some((word) => value.includes(word));
}

function stripSceneSuffix(value) {
  let result = value;
  for (const word of SCENE_WORDS) {
    if (result.endsWith(word) && result.length > word.length + 1) result = result.slice(0, -word.length);
  }
  return result.trim();
}

function cleanPlaceName(value) {
  return String(value ?? "")
    .replace(GENERIC_PLACE_SUFFIX, "")
    .replace(/（.*?）/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

import { haversineKm, inferPreset } from "./geo.mjs";

const GENERIC_PLACE_SUFFIX = /地点\s*\d+$/u;
const SCENE_WORDS = ["街景", "山景", "夜景", "风景", "湖景", "河景", "随拍", "路边", "附近", "小憩", "自拍", "合影", "打卡", "候机", "时光", "暮色", "晨雾"];
const PLACE_WORDS = ["桥", "堡", "宫", "馆", "院", "街", "路", "河", "湖", "山", "机场", "酒店", "咖啡馆", "教堂", "广场", "Straße", "Street"];

export function buildPlacesForGroup(group, tripId, { makeId }) {
  const located = group
    .filter((photo) => photo.location)
    .sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  const clusters = [];
  for (const photo of located) {
    const last = clusters.at(-1);
    const previous = last?.photos.at(-1);
    const distance = previous?.location && photo.location ? haversineKm(previous.location, photo.location) : 0;
    if (!last || distance > 2.5 || last.photos.length >= 24) clusters.push({ photos: [photo] });
    else last.photos.push(photo);
  }
  return clusters.map((cluster, index) => {
    const center = cluster.photos.reduce((sum, photo) => ({ lat: sum.lat + photo.location.lat, lng: sum.lng + photo.location.lng }), { lat: 0, lng: 0 });
    center.lat /= cluster.photos.length;
    center.lng /= cluster.photos.length;
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

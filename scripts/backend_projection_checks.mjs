import assert from "node:assert/strict";
import { applyPendingDecision } from "../server/domain/pending-workflow.mjs";
import { validatePhotoAnalysisResult } from "../server/ai/ai-schemas.mjs";
import { forwardLocalGeocode } from "../server/domain/local-geocoder.mjs";
import { toAiEvidence } from "../server/domain/location-resolver.mjs";
import { buildPlacesForGroup } from "../server/domain/place-projector.mjs";
import { projectState } from "../server/domain/state-projector.mjs";

let sequence = 0;
function makeId(prefix) {
  sequence += 1;
  return `${prefix}-test-${sequence}`;
}

const sneakyAiCoordinate = validatePhotoAnalysisResult(
  {
    title: "Sneaky coordinate",
    tags: ["travel", "norway", "reine", "harbor", "mountain", "water"],
    caption: "A quiet harbor moment between mountains and water.",
    locationCandidate: { name: "Reine", city: "Reine", country: "Norway", lat: 1.23, lng: 4.56, confidence: 0.91 },
  },
  undefined,
  { locale: "en" },
);
const sneakyAiEvidence = toAiEvidence(sneakyAiCoordinate, { makeId });
assert.equal("lat" in sneakyAiCoordinate.locationCandidates[0], false);
assert.equal("lng" in sneakyAiCoordinate.locationCandidates[0], false);
assert.equal(Boolean(sneakyAiEvidence.locationCandidates[0].point), false);

const baseState = {
  trips: [
    {
      id: "trip-test",
      title: "2026-05 测试旅行",
      dateRange: { start: "2026-05-01", end: "2026-05-02" },
      countries: ["奥地利"],
      cities: ["哈尔施塔特"],
      coverUrl: "",
      photoCount: 0,
      placeNodeCount: 0,
      status: "pending",
      source: "import",
    },
  ],
  photos: [
    {
      id: "photo-test",
      fileName: "lake.jpg",
      thumbnailUrl: "/data/thumbs/lake.jpg",
      capturedAt: "2026-05-01T10:00:00Z",
      tripId: "trip-test",
      tags: ["哈尔施塔特湖畔", "湖景"],
      aiCaption: "湖畔小镇与山体。",
      pendingReason: "missing_gps",
      ai: {
        visiblePlaceNames: ["哈尔施塔特"],
        locationCandidates: [
          {
            id: "candidate-hallstatt",
            name: "哈尔施塔特",
            country: "奥地利",
            city: "哈尔施塔特",
            point: { lat: 47.5622, lng: 13.6493 },
            confidence: 0.82,
            source: "ai_vision",
            reason: "湖畔小镇特征匹配。",
          },
        ],
      },
      locationResolution: {
        status: "suggested",
        effectiveName: "哈尔施塔特",
        effectivePoint: { lat: 47.5622, lng: 13.6493 },
        confidence: 0.82,
        source: "ai_vision",
        candidateId: "candidate-hallstatt",
        candidates: [
          {
            id: "candidate-hallstatt",
            name: "哈尔施塔特",
            country: "奥地利",
            city: "哈尔施塔特",
            point: { lat: 47.5622, lng: 13.6493 },
            confidence: 0.82,
            source: "ai_vision",
            reason: "湖畔小镇特征匹配。",
          },
        ],
        requiresUserAction: true,
        updatedAt: "2026-05-01T11:00:00Z",
      },
    },
  ],
  placeNodes: [],
  routes: [],
  importBatches: [],
  pendingItems: [
    {
      id: "pending-location",
      type: "confirm_location_candidate",
      relatedPhotoIds: ["photo-test"],
      relatedTripId: "trip-test",
      suggestion: "AI 建议定位到哈尔施塔特。",
      reason: "缺 GPS 但 AI 给出候选。",
      status: "open",
      proposal: {
        action: "create_place_from_candidate",
        tripId: "trip-test",
        photoIds: ["photo-test"],
        candidate: {
          id: "candidate-hallstatt",
          name: "哈尔施塔特",
          country: "奥地利",
          city: "哈尔施塔特",
          point: { lat: 47.5622, lng: 13.6493 },
          confidence: 0.82,
          source: "ai_vision",
          reason: "湖畔小镇特征匹配。",
        },
      },
    },
  ],
};

const projectedBefore = projectState(baseState);
assert.equal(projectedBefore.timelineSegments.some((segment) => segment.relatedType === "trip"), true);
assert.equal(projectedBefore.dossierGroups[0].countries[0].days[0].status, "suggested");
assert.equal(projectedBefore.searchDocuments[0].locationNames.includes("哈尔施塔特"), true);

const accepted = applyPendingDecision(baseState, "pending-location", { accepted: true });
const projectedAfter = projectState(accepted);
assert.equal(projectedAfter.pendingItems[0].status, "accepted");
assert.equal(projectedAfter.photos[0].pendingReason, undefined);
assert.deepEqual(projectedAfter.photos[0].location, { lat: 47.56231, lng: 13.64912 });
assert.equal(projectedAfter.placeNodes.length, 1);
assert.equal(projectedAfter.globeMarkers.some((marker) => marker.kind === "place" && marker.label === "哈尔施塔特"), true);

const ignored = applyPendingDecision(baseState, "pending-location", { accepted: false });
assert.equal(projectState(ignored).pendingItems[0].status, "ignored");

const ungeocodableState = structuredClone(baseState);
ungeocodableState.pendingItems[0].proposal.candidate = {
  id: "candidate-invented",
  name: "Imaginary Viewpoint",
  country: "Norway",
  city: "Definitely Not A Real Gazetteer City",
  point: { lat: 65.094, lng: 13.1 },
  confidence: 0.82,
  source: "ai_vision",
  reason: "AI coordinate must not be enough to create a place.",
};
const ungeocodableAccepted = applyPendingDecision(ungeocodableState, "pending-location", { accepted: true });
assert.equal(ungeocodableAccepted.pendingItems[0].status, "open");
assert.equal(ungeocodableAccepted.placeNodes.length, 0);
assert.equal(ungeocodableAccepted.photos[0].location, undefined);

const berlinFallback = forwardLocalGeocode({ name: "柏林中央火车站", city: "柏林", country: "德国" })[0];
assert.equal(berlinFallback?.country, "德国");
assert.equal(berlinFallback?.localizedCountryNames?.en, "Germany");
assert.equal(Boolean(berlinFallback?.point), true);

const centralEuropePhotos = [
  {
    id: "photo-prague",
    fileName: "IMG_prague_charles_bridge.jpg",
    title: "布拉格查理大桥与城堡",
    thumbnailUrl: "/data/thumbs/prague.jpg",
    capturedAt: "2025-07-18T10:00:00Z",
    tripId: "trip-central-europe",
    location: { lat: 50.088, lng: 14.4208 },
    tags: ["布拉格查理大桥", "布拉格城堡"],
    aiCaption: "GPS位于布拉格附近，画面呈现查理大桥与城堡景观。",
    ai: {
      visiblePlaceNames: ["布拉格查理大桥", "布拉格城堡"],
      locationCandidates: [
        {
          id: "candidate-prague",
          name: "布拉格",
          country: "捷克",
          city: "布拉格",
          point: { lat: 50.088, lng: 14.4208 },
          confidence: 0.95,
          source: "ai_vision",
          reason: "查理大桥与城堡天际线。",
        },
      ],
    },
    locationResolution: {
      status: "confirmed",
      effectiveName: "布拉格",
      effectivePoint: { lat: 50.088, lng: 14.4208 },
      confidence: 0.95,
      source: "ai_vision",
      candidateId: "candidate-prague",
      candidates: [
        {
          id: "candidate-prague",
          name: "布拉格",
          country: "捷克",
          city: "布拉格",
          point: { lat: 50.088, lng: 14.4208 },
          confidence: 0.95,
          source: "ai_vision",
          reason: "查理大桥与城堡天际线。",
        },
      ],
      requiresUserAction: false,
      updatedAt: "2025-07-18T11:00:00Z",
    },
  },
  {
    id: "photo-hallstatt",
    fileName: "IMG_hallstatt_lake.jpg",
    title: "哈尔施塔特湖畔小镇",
    thumbnailUrl: "/data/thumbs/hallstatt.jpg",
    capturedAt: "2025-07-21T10:00:00Z",
    tripId: "trip-central-europe",
    location: { lat: 47.5622, lng: 13.6493 },
    tags: ["哈尔施塔特湖畔", "奥地利湖区"],
    aiCaption: "湖畔小镇与山体。",
    ai: {
      visiblePlaceNames: ["哈尔施塔特"],
      locationCandidates: [
        {
          id: "candidate-hallstatt-2",
          name: "哈尔施塔特",
          country: "奥地利",
          city: "哈尔施塔特",
          point: { lat: 47.5622, lng: 13.6493 },
          confidence: 0.9,
          source: "ai_vision",
          reason: "湖畔小镇特征匹配。",
        },
      ],
    },
    locationResolution: {
      status: "confirmed",
      effectiveName: "哈尔施塔特",
      effectivePoint: { lat: 47.5622, lng: 13.6493 },
      confidence: 0.9,
      source: "ai_vision",
      candidateId: "candidate-hallstatt-2",
      candidates: [
        {
          id: "candidate-hallstatt-2",
          name: "哈尔施塔特",
          country: "奥地利",
          city: "哈尔施塔特",
          point: { lat: 47.5622, lng: 13.6493 },
          confidence: 0.9,
          source: "ai_vision",
          reason: "湖畔小镇特征匹配。",
        },
      ],
      requiresUserAction: false,
      updatedAt: "2025-07-21T11:00:00Z",
    },
  },
];
const centralEuropePlaces = buildPlacesForGroup(centralEuropePhotos, "trip-central-europe", { makeId });
const centralEuropePhotosWithPlaces = centralEuropePhotos.map((photo) => ({
  ...photo,
  placeNodeId: centralEuropePlaces.find((place) => place.photoIds.includes(photo.id))?.id,
}));
const centralEuropeProjected = projectState({
  trips: [
    {
      id: "trip-central-europe",
      title: "2025-07 欧洲多城旅行",
      dateRange: { start: "2025-07-18", end: "2025-07-21" },
      countries: ["奥地利", "德国"],
      cities: ["布拉格", "哈尔施塔特"],
      coverUrl: "",
      photoCount: 2,
      placeNodeCount: centralEuropePlaces.length,
      status: "confirmed",
      source: "import",
    },
  ],
  photos: centralEuropePhotosWithPlaces,
  placeNodes: centralEuropePlaces,
  routes: [],
  importBatches: [],
  pendingItems: [],
});
const praguePlace = centralEuropeProjected.placeNodes.find((place) => place.name === "布拉格");
assert.equal(praguePlace?.country, "捷克");
assert.equal(praguePlace?.displayName, "布拉格查理大桥与城堡");
assert.equal(centralEuropeProjected.timelineSegments.find((segment) => segment.relatedId === praguePlace?.id)?.label, "布拉格");
assert.deepEqual(
  centralEuropeProjected.dossierGroups[0].countries.map((group) => group.country),
  ["捷克", "奥地利"],
);
assert.equal(centralEuropeProjected.globeMarkers.find((marker) => marker.kind === "place" && marker.label === "布拉格")?.countryName, "捷克");

const incrementalPlacePhotos = [
  {
    id: "photo-hallstatt-old",
    fileName: "hallstatt-waterfront-old.jpg",
    title: "哈尔施塔特湖畔",
    thumbnailUrl: "/data/thumbs/hallstatt-old.jpg",
    capturedAt: "2025-07-21T09:00:00Z",
    tripId: "trip-incremental",
    location: { lat: 47.5622, lng: 13.6493 },
    tags: ["哈尔施塔特湖畔"],
    locationResolution: {
      status: "confirmed",
      effectiveName: "哈尔施塔特",
      candidates: [
        {
          id: "candidate-hallstatt-old",
          name: "哈尔施塔特",
          country: "奥地利",
          city: "哈尔施塔特",
          point: { lat: 47.5622, lng: 13.6493 },
          confidence: 0.9,
        },
      ],
      requiresUserAction: false,
    },
  },
  {
    id: "photo-prague-bridge",
    fileName: "prague-charles-bridge.jpg",
    title: "布拉格查理大桥",
    thumbnailUrl: "/data/thumbs/prague-bridge.jpg",
    capturedAt: "2025-07-21T11:00:00Z",
    tripId: "trip-incremental",
    location: { lat: 50.0865, lng: 14.4114 },
    tags: ["布拉格查理大桥"],
    ai: { visiblePlaceNames: ["布拉格查理大桥"] },
    locationResolution: {
      status: "confirmed",
      effectiveName: "布拉格",
      candidates: [
        {
          id: "candidate-prague-bridge",
          name: "布拉格",
          country: "捷克",
          city: "布拉格",
          point: { lat: 50.0865, lng: 14.4114 },
          confidence: 0.92,
        },
      ],
      requiresUserAction: false,
    },
  },
  {
    id: "photo-hallstatt-new",
    fileName: "hallstatt-waterfront-new.jpg",
    title: "哈尔施塔特小镇街边",
    thumbnailUrl: "/data/thumbs/hallstatt-new.jpg",
    capturedAt: "2025-07-21T13:00:00Z",
    tripId: "trip-incremental",
    location: { lat: 47.563, lng: 13.648 },
    tags: ["哈尔施塔特"],
    locationResolution: {
      status: "confirmed",
      effectiveName: "哈尔施塔特湖畔",
      candidates: [
        {
          id: "candidate-hallstatt-new",
          name: "哈尔施塔特湖畔",
          country: "奥地利",
          city: "哈尔施塔特",
          point: { lat: 47.5628, lng: 13.6485 },
          confidence: 0.88,
        },
      ],
      requiresUserAction: false,
    },
  },
  {
    id: "photo-prague-castle",
    fileName: "prague-castle.jpg",
    title: "布拉格城堡",
    thumbnailUrl: "/data/thumbs/prague-castle.jpg",
    capturedAt: "2025-07-21T15:00:00Z",
    tripId: "trip-incremental",
    location: { lat: 50.0909, lng: 14.4005 },
    tags: ["布拉格城堡"],
    ai: { visiblePlaceNames: ["布拉格城堡"] },
    locationResolution: {
      status: "confirmed",
      effectiveName: "布拉格城堡",
      candidates: [
        {
          id: "candidate-prague-castle",
          name: "布拉格城堡",
          country: "捷克",
          city: "布拉格",
          point: { lat: 50.0909, lng: 14.4005 },
          confidence: 0.9,
        },
      ],
      requiresUserAction: false,
    },
  },
];
const incrementalPlaces = buildPlacesForGroup(incrementalPlacePhotos, "trip-incremental", { makeId });
const incrementalPhotosWithPlaces = incrementalPlacePhotos.map((photo) => ({
  ...photo,
  placeNodeId: incrementalPlaces.find((place) => place.photoIds.includes(photo.id))?.id,
}));
const incrementalProjected = projectState({
  trips: [
    {
      id: "trip-incremental",
      title: "2025-07 欧洲多城旅行",
      dateRange: { start: "2025-07-21", end: "2025-07-21" },
      countries: ["奥地利"],
      cities: ["哈尔施塔特"],
      coverUrl: "",
      photoCount: incrementalPlacePhotos.length,
      placeNodeCount: incrementalPlaces.length,
      status: "confirmed",
      source: "import",
    },
  ],
  photos: incrementalPhotosWithPlaces,
  placeNodes: incrementalPlaces,
  routes: [],
  importBatches: [],
  pendingItems: [],
});
const hallstattIncrementalPlaces = incrementalProjected.placeNodes.filter((place) => place.city === "哈尔施塔特");
const pragueIncrementalPlaces = incrementalProjected.placeNodes.filter((place) => place.country === "捷克");
assert.equal(hallstattIncrementalPlaces.length, 1);
assert.deepEqual(new Set(hallstattIncrementalPlaces[0].photoIds), new Set(["photo-hallstatt-old", "photo-hallstatt-new"]));
assert.equal(pragueIncrementalPlaces.length, 1);
assert.deepEqual(new Set(pragueIncrementalPlaces[0].photoIds), new Set(["photo-prague-bridge", "photo-prague-castle"]));
assert.equal(incrementalProjected.globeMarkers.filter((marker) => marker.kind === "place" && marker.countryName === "捷克").length, 1);
assert.equal(incrementalProjected.globeMarkers.find((marker) => marker.kind === "country" && marker.countryName === "捷克")?.count, 2);
assert.equal(incrementalProjected.globeMarkers.find((marker) => marker.kind === "country" && marker.countryName === "奥地利")?.count, 2);
assert.deepEqual(
  incrementalProjected.dossierGroups[0].countries.flatMap((group) => group.days.map((day) => day.placeIds.length)),
  [1, 1],
);

const sameDayPhotos = [
  {
    id: "photo-salzburg",
    fileName: "salzburg-cafe.jpg",
    title: "萨尔茨堡咖啡馆小憩",
    thumbnailUrl: "/data/thumbs/salzburg.jpg",
    capturedAt: "2025-07-23T15:00:00Z",
    tripId: "trip-same-day",
    location: { lat: 47.8022, lng: 13.0435 },
    tags: ["萨尔茨堡", "咖啡馆"],
    aiCaption: "萨尔茨堡咖啡馆。",
    locationResolution: {
      status: "confirmed",
      effectiveName: "萨尔茨堡",
      effectivePoint: { lat: 47.8022, lng: 13.0435 },
      confidence: 0.9,
      source: "ai_vision",
      candidateId: "candidate-salzburg",
      candidates: [
        {
          id: "candidate-salzburg",
          name: "萨尔茨堡",
          country: "奥地利",
          city: "萨尔茨堡",
          point: { lat: 47.8022, lng: 13.0435 },
          confidence: 0.9,
          source: "ai_vision",
          reason: "城市与 GPS 一致。",
        },
      ],
      requiresUserAction: false,
      updatedAt: "2025-07-23T15:30:00Z",
    },
  },
  {
    id: "photo-innsbruck",
    fileName: "innsbruck-hotel.jpg",
    title: "因斯布鲁克酒店自拍",
    thumbnailUrl: "/data/thumbs/innsbruck.jpg",
    capturedAt: "2025-07-23T21:00:00Z",
    tripId: "trip-same-day",
    location: { lat: 47.2622, lng: 11.3957 },
    tags: ["因斯布鲁克", "酒店"],
    aiCaption: "因斯布鲁克酒店。",
    locationResolution: {
      status: "confirmed",
      effectiveName: "因斯布鲁克",
      effectivePoint: { lat: 47.2622, lng: 11.3957 },
      confidence: 0.95,
      source: "ai_vision",
      candidateId: "candidate-innsbruck",
      candidates: [
        {
          id: "candidate-innsbruck",
          name: "因斯布鲁克",
          country: "奥地利",
          city: "因斯布鲁克",
          point: { lat: 47.2622, lng: 11.3957 },
          confidence: 0.95,
          source: "ai_vision",
          reason: "酒店位置与 GPS 一致。",
        },
      ],
      requiresUserAction: false,
      updatedAt: "2025-07-23T21:30:00Z",
    },
  },
];
const sameDayPlaces = buildPlacesForGroup(sameDayPhotos, "trip-same-day", { makeId });
const sameDayPhotosWithPlaces = sameDayPhotos.map((photo) => ({
  ...photo,
  placeNodeId: sameDayPlaces.find((place) => place.photoIds.includes(photo.id))?.id,
}));
const sameDayProjected = projectState({
  trips: [
    {
      id: "trip-same-day",
      title: "2025-07 奥地利旅行",
      dateRange: { start: "2025-07-23", end: "2025-07-23" },
      countries: ["奥地利"],
      cities: ["萨尔茨堡", "因斯布鲁克"],
      coverUrl: "",
      photoCount: 2,
      placeNodeCount: sameDayPlaces.length,
      status: "confirmed",
      source: "import",
    },
  ],
  photos: sameDayPhotosWithPlaces,
  placeNodes: sameDayPlaces,
  routes: [],
  importBatches: [],
  pendingItems: [],
});
const sameDayDossierPlaceIds = sameDayProjected.dossierGroups[0].countries[0].days[0].placeIds;
const sameDayDossierDays = sameDayProjected.dossierGroups[0].countries[0].days;
const sameDayGlobePlaceIds = sameDayProjected.globeMarkers.filter((marker) => marker.kind === "place").flatMap((marker) => marker.placeIds ?? []);
assert.equal(sameDayPlaces.length, 2);
assert.equal(sameDayDossierDays.length, 2);
assert.deepEqual(
  sameDayDossierDays.map((day) => day.day),
  ["2025-07-23", "2025-07-23"],
);
assert.deepEqual(new Set(sameDayDossierDays.flatMap((day) => day.placeIds)), new Set(sameDayGlobePlaceIds));
assert.equal(sameDayDossierPlaceIds.length, 1);

const sceneTagOnlyPhotos = [
  {
    id: "photo-scene-tag",
    fileName: "norway-lake.jpg",
    title: "峡湾畔的悠闲午后",
    thumbnailUrl: "/data/thumbs/norway-lake.jpg",
    capturedAt: "2024-08-06T12:16:14Z",
    tripId: "trip-norway",
    location: { lat: 59.223972, lng: 5.465675 },
    tags: ["山间湖泊", "挪威海岸风光"],
    aiCaption: "峡湾边的一段午后。",
    ai: {
      visiblePlaceNames: ["挪威海岸"],
      locationCandidates: [
        {
          id: "candidate-norway-country",
          name: "挪威",
          country: "挪威",
          confidence: 0.9,
          source: "ai_vision",
          reason: "GPS 匹配挪威。",
        },
      ],
    },
    locationResolution: {
      status: "confirmed",
      effectivePoint: { lat: 59.223972, lng: 5.465675 },
      source: "exif",
      candidates: [
        {
          id: "candidate-haugesund",
          name: "Haugesund",
          country: "挪威",
          city: "Haugesund",
          point: { lat: 59.4138, lng: 5.268 },
          confidence: 0.82,
          source: "geocode",
          reason: "GeoNames nearest locality.",
        },
        {
          id: "candidate-norway-country",
          name: "挪威",
          country: "挪威",
          confidence: 0.9,
          source: "ai_vision",
          reason: "GPS 匹配挪威。",
        },
      ],
      requiresUserAction: false,
      updatedAt: "2026-05-09T11:00:00Z",
    },
  },
];
const sceneTagPlaces = buildPlacesForGroup(sceneTagOnlyPhotos, "trip-norway", { makeId });
assert.equal(sceneTagPlaces[0].name, "Haugesund");
assert.equal(sceneTagPlaces[0].names.zh, "海于格松");
assert.notEqual(sceneTagPlaces[0].name, "山间湖泊");
assert.notEqual(sceneTagPlaces[0].name, "挪威");

const existingWeakPlace = {
  id: "place-existing-weak",
  tripId: "trip-norway",
  name: "山间湖泊",
  center: { lat: 59.223972, lng: 5.465675 },
  photoIds: ["photo-old-norway"],
  timeRange: { start: "2024-08-06T10:00:00Z", end: "2024-08-06T10:00:00Z" },
  pending: false,
};
const weakUpgradePlaces = buildPlacesForGroup(
  [
    { ...sceneTagOnlyPhotos[0], id: "photo-old-norway", capturedAt: "2024-08-06T10:00:00Z" },
    sceneTagOnlyPhotos[0],
  ],
  "trip-norway",
  { makeId, existingPlaces: [existingWeakPlace] },
);
assert.equal(weakUpgradePlaces[0].id, existingWeakPlace.id);
assert.equal(weakUpgradePlaces[0].name, "Haugesund");

const existingViennaPlace = {
  id: "place-vienna-existing",
  tripId: "trip-vienna",
  name: "阿尔贝蒂娜博物馆",
  displayName: "阿尔贝蒂娜博物馆",
  country: "奥地利",
  city: "维也纳",
  center: { lat: 48.2044, lng: 16.3682 },
  photoIds: ["photo-vienna-1", "photo-vienna-2", "photo-vienna-3"],
  timeRange: { start: "2025-07-19T10:00:00Z", end: "2025-07-19T10:20:00Z" },
  pending: false,
};
const viennaMuseumPhoto = (id, capturedAt) => ({
  id,
  fileName: `${id}.jpg`,
  title: "维也纳博物馆",
  capturedAt,
  tripId: "trip-vienna",
  location: { lat: 48.2044, lng: 16.3682 },
  tags: ["维也纳", "博物馆"],
  aiCaption: "维也纳市中心的博物馆建筑。",
  ai: {
    visiblePlaceNames: ["阿尔贝蒂娜博物馆"],
    locationCandidates: [
      {
        id: `candidate-${id}`,
        name: "阿尔贝蒂娜博物馆",
        country: "奥地利",
        city: "维也纳",
        point: { lat: 48.2044, lng: 16.3682 },
        confidence: 0.82,
        source: "ai_vision",
      },
    ],
  },
  locationResolution: {
    status: "confirmed",
    effectiveName: "阿尔贝蒂娜博物馆",
    effectivePoint: { lat: 48.2044, lng: 16.3682 },
    confidence: 0.82,
    source: "ai_vision",
    candidates: [],
    requiresUserAction: false,
  },
});
const contextBoundKarlskirchePhoto = {
  ...viennaMuseumPhoto("photo-vienna-4", "2025-07-19T10:30:00Z"),
  title: "维也纳查尔斯教堂",
  location: { lat: 48.1984, lng: 16.3716 },
  tags: ["卡尔教堂", "维也纳"],
  aiCaption: "画面显示维也纳查尔斯教堂建筑特征。",
  ai: {
    visiblePlaceNames: ["维也纳查尔斯教堂"],
    locationCandidates: [
      {
        id: "candidate-karlskirche",
        name: "卡尔教堂",
        country: "奥地利",
        city: "维也纳",
        point: { lat: 48.1984, lng: 16.3716 },
        confidence: 0.86,
        source: "ai_context_inference",
      },
    ],
  },
  locationResolution: {
    status: "confirmed",
    effectiveName: "阿尔贝蒂娜博物馆",
    effectivePoint: { lat: 48.2044, lng: 16.3682 },
    confidence: 0.86,
    source: "existing_trip_context",
    candidates: [],
    requiresUserAction: false,
  },
};
const contextBoundPlaces = buildPlacesForGroup(
  [
    viennaMuseumPhoto("photo-vienna-1", "2025-07-19T10:00:00Z"),
    viennaMuseumPhoto("photo-vienna-2", "2025-07-19T10:10:00Z"),
    viennaMuseumPhoto("photo-vienna-3", "2025-07-19T10:20:00Z"),
    contextBoundKarlskirchePhoto,
  ],
  "trip-vienna",
  { makeId, existingPlaces: [existingViennaPlace] },
);
assert.equal(contextBoundPlaces[0].id, existingViennaPlace.id);
assert.equal(contextBoundPlaces[0].name, "卡尔教堂");

const existingEstimatedViennaPlace = {
  ...existingViennaPlace,
  id: "place-vienna-estimated",
  name: "维也纳博物馆",
  displayName: "维也纳博物馆",
  photoIds: ["photo-vienna-estimated-1", "photo-vienna-estimated-2", "photo-vienna-estimated-3", "photo-vienna-estimated-4"],
};
const estimatedViennaPhoto = (id, capturedAt) => ({
  ...viennaMuseumPhoto(id, capturedAt),
  locationResolution: {
    status: "confirmed",
    effectiveName: "维也纳博物馆",
    effectivePoint: { lat: 48.2044, lng: 16.3682 },
    confidence: 0.72,
    source: "ai_context_inference",
    candidates: [],
    requiresUserAction: false,
  },
});
const firstGpsViennaPhoto = {
  ...viennaMuseumPhoto("photo-vienna-first-gps", "2025-07-19T11:00:00Z"),
  locationResolution: {
    status: "confirmed",
    effectiveName: "阿尔贝蒂娜博物馆",
    effectivePoint: { lat: 48.2044, lng: 16.3682 },
    confidence: 0.95,
    source: "exif",
    candidates: [
      {
        id: "candidate-first-gps",
        name: "阿尔贝蒂娜博物馆",
        country: "奥地利",
        city: "维也纳",
        point: { lat: 48.2044, lng: 16.3682 },
        confidence: 0.95,
        source: "geocode",
      },
    ],
    requiresUserAction: false,
  },
  exifStatus: { gps: "read", time: "read" },
};
const firstGpsPlaces = buildPlacesForGroup(
  [
    estimatedViennaPhoto("photo-vienna-estimated-1", "2025-07-19T10:00:00Z"),
    estimatedViennaPhoto("photo-vienna-estimated-2", "2025-07-19T10:10:00Z"),
    estimatedViennaPhoto("photo-vienna-estimated-3", "2025-07-19T10:20:00Z"),
    estimatedViennaPhoto("photo-vienna-estimated-4", "2025-07-19T10:30:00Z"),
    firstGpsViennaPhoto,
  ],
  "trip-vienna",
  { makeId, existingPlaces: [existingEstimatedViennaPlace] },
);
assert.equal(firstGpsPlaces[0].id, existingEstimatedViennaPlace.id);
assert.equal(firstGpsPlaces[0].name, "阿尔贝蒂娜博物馆");

console.log("Backend projection checks passed");

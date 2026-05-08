import assert from "node:assert/strict";
import { applyPendingDecision } from "../server/domain/pending-workflow.mjs";
import { buildPlacesForGroup } from "../server/domain/place-projector.mjs";
import { projectState } from "../server/domain/state-projector.mjs";

let sequence = 0;
function makeId(prefix) {
  sequence += 1;
  return `${prefix}-test-${sequence}`;
}

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
assert.deepEqual(projectedAfter.photos[0].location, { lat: 47.5622, lng: 13.6493 });
assert.equal(projectedAfter.placeNodes.length, 1);
assert.equal(projectedAfter.globeMarkers.some((marker) => marker.kind === "place" && marker.label === "哈尔施塔特"), true);

const ignored = applyPendingDecision(baseState, "pending-location", { accepted: false });
assert.equal(projectState(ignored).pendingItems[0].status, "ignored");

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
assert.equal(praguePlace, undefined);
const pragueLandmarkPlace = centralEuropeProjected.placeNodes.find((place) => place.name === "布拉格查理大桥");
assert.equal(pragueLandmarkPlace?.country, "捷克");
assert.equal(pragueLandmarkPlace?.displayName, "布拉格查理大桥与城堡");
assert.equal(centralEuropeProjected.timelineSegments.find((segment) => segment.relatedId === pragueLandmarkPlace?.id)?.label, "布拉格查理大桥");
assert.deepEqual(
  centralEuropeProjected.dossierGroups[0].countries.map((group) => group.country),
  ["捷克", "奥地利"],
);
assert.equal(centralEuropeProjected.globeMarkers.find((marker) => marker.kind === "place" && marker.label === "布拉格查理大桥")?.countryName, "捷克");

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

console.log("Backend projection checks passed");

import assert from "node:assert/strict";
import { projectState as projectDesktopState } from "../server/domain/state-projector.mjs";
import { buildDossierGroups, buildGlobeMarkers, buildSearchDocuments, buildTimelineSegments } from "../shared/domain/projectors.mjs";
import { normalizeState } from "../shared/domain/state-normalizer.mjs";
import { applyPendingDecision } from "../shared/domain/pending-workflow.mjs";
import { buildImportStateFromPhotos } from "../shared/import/import-state-core.mjs";
import { buildSearchResults } from "../shared/search/search-core.mjs";

function makeIdFactory() {
  let sequence = 0;
  return (prefix) => {
    sequence += 1;
    return `${prefix}-parity-${sequence}`;
  };
}

function projectAndroidEquivalentState(state) {
  const normalized = normalizeState(state);
  return {
    ...normalized,
    timelineSegments: buildTimelineSegments(normalized.trips, normalized.placeNodes),
    globeMarkers: buildGlobeMarkers(normalized),
    dossierGroups: buildDossierGroups(normalized),
    searchDocuments: buildSearchDocuments(normalized),
  };
}

function normalizeForParity(value) {
  if (Array.isArray(value)) return value.map(normalizeForParity);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (["storageUrl", "sourceUri", "sourceWebPath", "thumbnailUrl", "sourceProvider", "coverUrl"].includes(key)) continue;
    next[key] = normalizeForParity(item);
  }
  return Object.fromEntries(Object.entries(next).sort(([left], [right]) => left.localeCompare(right)));
}

function baseState() {
  return {
    trips: [],
    photos: [],
    placeNodes: [],
    routes: [],
    importBatches: [],
    pendingItems: [],
  };
}

function fixturePhotos(platform) {
  const pathPrefix = platform === "android" ? "content://media/external/images/media" : "file:///desktop/imports";
  const provider = platform === "android" ? "android_photo_picker" : "file_input";
  return [
    {
      id: "photo-parity-1",
      fileName: "reine-harbor-1.jpg",
      title: "Reine harbor 1",
      originalHash: "hash-reine-1",
      mime: "image/jpeg",
      thumbnailUrl: `${pathPrefix}/thumb-1.jpg`,
      storageUrl: `${pathPrefix}/1.jpg`,
      sourceUri: platform === "android" ? `${pathPrefix}/1` : undefined,
      sourceProvider: provider,
      capturedAt: "2026-05-01T10:00:00Z",
      location: { lat: 67.9324, lng: 13.0896 },
      tags: ["Reine", "harbor", "Norway"],
      aiCaption: "A harbor in Reine, Norway.",
      exifStatus: { time: "read", gps: "read" },
      locationResolution: {
        status: "confirmed",
        effectivePoint: { lat: 67.9324, lng: 13.0896 },
        confidence: 1,
        source: "exif",
        precision: "confirmed",
        candidates: [],
        requiresUserAction: false,
        updatedAt: "2026-05-01T10:00:00Z",
      },
    },
    {
      id: "photo-parity-2",
      fileName: "reine-harbor-2.jpg",
      title: "Reine harbor 2",
      originalHash: "hash-reine-2",
      mime: "image/jpeg",
      thumbnailUrl: `${pathPrefix}/thumb-2.jpg`,
      storageUrl: `${pathPrefix}/2.jpg`,
      sourceUri: platform === "android" ? `${pathPrefix}/2` : undefined,
      sourceProvider: provider,
      capturedAt: "2026-05-01T10:06:00Z",
      location: { lat: 67.9325, lng: 13.09 },
      tags: ["Reine", "mountain", "water"],
      aiCaption: "Mountain water and a fishing village.",
      exifStatus: { time: "read", gps: "read" },
      locationResolution: {
        status: "confirmed",
        effectivePoint: { lat: 67.9325, lng: 13.09 },
        confidence: 1,
        source: "exif",
        precision: "confirmed",
        candidates: [],
        requiresUserAction: false,
        updatedAt: "2026-05-01T10:06:00Z",
      },
    },
  ];
}

function buildState(platform) {
  return buildImportStateFromPhotos(baseState(), {
    totalCount: 2,
    photos: structuredClone(fixturePhotos(platform)),
    makeId: makeIdFactory(),
    now: new Date("2026-05-17T00:00:00Z"),
    locale: "zh",
    aiStats: {
      qwenCount: 0,
      fallbackCount: 0,
      embeddingCount: 2,
      qwenEmbeddingCount: 2,
      deterministicEmbeddingCount: 0,
    },
  });
}

const desktopState = buildState("desktop");
const androidState = buildState("android");
const desktopProjection = projectDesktopState(desktopState);
const androidProjection = projectAndroidEquivalentState(androidState);

for (const key of ["trips", "photos", "placeNodes", "routes", "importBatches", "pendingItems", "timelineSegments", "globeMarkers", "dossierGroups", "searchDocuments"]) {
  assert.deepEqual(normalizeForParity(androidProjection[key]), normalizeForParity(desktopProjection[key]), `Android equivalent ${key} must match desktop after platform path normalization`);
}

const acceptedDesktop = applyPendingDecision(desktopState, desktopState.pendingItems.find((item) => item.type === "needs_trip_confirmation")?.id, { accepted: true });
const acceptedAndroid = applyPendingDecision(androidState, androidState.pendingItems.find((item) => item.type === "needs_trip_confirmation")?.id, { accepted: true });
assert.deepEqual(normalizeForParity(projectAndroidEquivalentState(acceptedAndroid).pendingItems), normalizeForParity(projectDesktopState(acceptedDesktop).pendingItems), "Pending decision behavior must match");

const desktopSearch = buildSearchResults({ documents: desktopProjection.searchDocuments, photos: desktopProjection.photos, query: "Reine Norway harbor" });
const androidSearch = buildSearchResults({ documents: androidProjection.searchDocuments, photos: androidProjection.photos, query: "Reine Norway harbor" });
assert.deepEqual(androidSearch, desktopSearch, "Text search output must match");

console.log("Android/Desktop parity checks passed.");

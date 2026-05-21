import assert from "node:assert/strict";
import { projectState as projectDesktopState } from "../server/domain/state-projector.mjs";
import { buildDossierGroups, buildGlobeMarkers, buildSearchDocuments, buildTimelineSegments } from "../shared/domain/projectors.mjs";
import { normalizeState } from "../shared/domain/state-normalizer.mjs";
import { applyPendingDecision } from "../shared/domain/pending-workflow.mjs";
import { buildImportStateFromPhotos } from "../shared/import/import-state-core.mjs";
import { buildSearchResults } from "../shared/search/search-core.mjs";
import { chatCompletionRequestBody, chatCompletionWithProvider, multimodalEmbeddingRequestBody, openAiCompatibleEmbeddingRequestBody } from "../shared/ai/provider-runtime.mjs";

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

const mobileSecondPassPendingState = {
  trips: [
    {
      id: "trip-mobile-second-pass",
      title: "2026-05 Mobile second pass",
      dateRange: { start: "2026-05-01", end: "2026-05-01" },
      countries: ["Norway"],
      cities: ["Reine"],
      coverUrl: "",
      photoCount: 1,
      placeNodeCount: 0,
      status: "pending",
      source: "import",
    },
  ],
  photos: [
    {
      id: "photo-mobile-second-pass",
      fileName: "reine.jpg",
      thumbnailUrl: "content://media/external/images/media/reine-thumb",
      capturedAt: "2026-05-01T10:00:00Z",
      tripId: "trip-mobile-second-pass",
      pendingReason: "missing_gps",
      exifStatus: { time: "read", gps: "missing" },
      tags: ["Reine"],
      aiCaption: "A harbor in Reine.",
    },
  ],
  placeNodes: [],
  routes: [],
  importBatches: [],
  pendingItems: [
    {
      id: "pending-mobile-second-pass",
      type: "missing_gps",
      relatedPhotoIds: ["photo-mobile-second-pass"],
      relatedTripId: "trip-mobile-second-pass",
      suggestion: "New place Reine",
      reason: "Local gazetteer completed second-pass coordinates.",
      status: "open",
      proposal: {
        action: "create_place_from_candidate",
        tripId: "trip-mobile-second-pass",
        photoIds: ["photo-mobile-second-pass"],
        candidate: {
          id: "candidate-mobile-reine",
          name: "Reine",
          country: "Norway",
          city: "Reine",
          point: { lat: 67.9324, lng: 13.0896 },
          confidence: 0.9,
          source: "ai_context_inference",
          precision: "estimated",
          reason: "Second-pass inference used local gazetteer coordinates.",
        },
      },
    },
  ],
};
const acceptedMobileSecondPass = applyPendingDecision(mobileSecondPassPendingState, "pending-mobile-second-pass", { accepted: true });
assert.equal(acceptedMobileSecondPass.pendingItems[0].status, "accepted", "Mobile second-pass proposals with completed local coordinates must accept without desktop forward geocode");
assert.equal(acceptedMobileSecondPass.placeNodes.length, 1);
assert.deepEqual(acceptedMobileSecondPass.photos[0].location, { lat: 67.9324, lng: 13.0896 });

const rawAiCoordinateState = structuredClone(mobileSecondPassPendingState);
rawAiCoordinateState.pendingItems[0].id = "pending-raw-ai-coordinate";
rawAiCoordinateState.pendingItems[0].proposal.candidate = {
  ...rawAiCoordinateState.pendingItems[0].proposal.candidate,
  id: "candidate-raw-ai-coordinate",
  source: "ai_vision",
  reason: "Raw AI coordinates must not be accepted without local geocoding.",
};
const rawAiCoordinateAccepted = applyPendingDecision(rawAiCoordinateState, "pending-raw-ai-coordinate", { accepted: true });
assert.equal(rawAiCoordinateAccepted.pendingItems[0].status, "open", "Raw AI coordinates still require local geocoding before acceptance");
assert.equal(rawAiCoordinateAccepted.placeNodes.length, 0);

const desktopSearch = buildSearchResults({ documents: desktopProjection.searchDocuments, photos: desktopProjection.photos, query: "Reine Norway harbor" });
const androidSearch = buildSearchResults({ documents: androidProjection.searchDocuments, photos: androidProjection.photos, query: "Reine Norway harbor" });
assert.deepEqual(androidSearch, desktopSearch, "Text search output must match");

assert.deepEqual(
  multimodalEmbeddingRequestBody({
    model: "tongyi-embedding-vision-plus-2026-03-06",
    dataUrl: "data:image/jpeg;base64,aaa",
    dimensions: 1024,
  }).parameters,
  { dimension: 1024 },
  "Aliyun dated Tongyi vision embedding models must request the configured 1024D output",
);
assert.deepEqual(
  multimodalEmbeddingRequestBody({
    model: "qwen3-vl-embedding",
    dataUrl: "data:image/jpeg;base64,aaa",
    dimensions: 1024,
  }).parameters,
  { dimension: 1024 },
  "Aliyun qwen3-vl-embedding must request the configured 1024D output instead of the 2560D default",
);
assert.deepEqual(
  openAiCompatibleEmbeddingRequestBody({
    providerId: "siliconflow",
    model: "Qwen/Qwen3-VL-Embedding-8B",
    dataUrl: "data:image/jpeg;base64,aaa",
    dimensions: 1024,
  }).input,
  { image: "data:image/jpeg;base64,aaa" },
  "SiliconFlow VL embedding should pass image base64 through the provider-specific image input field",
);
assert.equal(
  openAiCompatibleEmbeddingRequestBody({
    providerId: "siliconflow",
    model: "Qwen/Qwen3-VL-Embedding-8B",
    dataUrl: "data:image/jpeg;base64,aaa",
    dimensions: 1024,
  }).dimensions,
  1024,
  "SiliconFlow Qwen3 embedding should request the configured 1024D output",
);
assert.equal(
  openAiCompatibleEmbeddingRequestBody({
    providerId: "openrouter",
    model: "nvidia/llama-nemotron-embed-vl-1b-v2:free",
    dataUrl: "data:image/jpeg;base64,aaa",
    dimensions: 1024,
  }).dimensions,
  1024,
  "OpenRouter Llama Nemotron VL should request the configured 1024D output",
);
assert.equal(
  chatCompletionRequestBody({
    providerId: "aliyun",
    model: "qwen3.6-flash",
    messages: [{ role: "user", content: "Return JSON." }],
  }).enable_thinking,
  false,
  "Aliyun/Qwen chat models must default thinking mode off",
);
assert.equal(
  chatCompletionRequestBody({
    providerId: "siliconflow",
    model: "Qwen/Qwen3.6-35B-A3B",
    messages: [{ role: "user", content: "Return JSON." }],
  }).enable_thinking,
  false,
  "SiliconFlow Qwen chat models must default thinking mode off",
);
assert.equal(
  chatCompletionRequestBody({
    providerId: "openai",
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Return JSON." }],
  }).enable_thinking,
  undefined,
  "Providers without Qwen-style thinking controls should not receive non-standard thinking fields",
);
assert.equal(
  chatCompletionRequestBody({
    providerId: "openai",
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Return JSON." }],
  }).reasoning,
  undefined,
  "OpenAI mini chat models must not receive OpenRouter-only reasoning controls",
);
assert.deepEqual(
  chatCompletionRequestBody({
    providerId: "openrouter",
    model: "qwen/qwen3.6-flash",
    messages: [{ role: "user", content: "Return JSON." }],
  }).reasoning,
  { effort: "none" },
  "OpenRouter Qwen chat models must default reasoning mode off",
);
assert.deepEqual(
  chatCompletionRequestBody({
    providerId: "openrouter",
    model: "~openai/gpt-mini-latest",
    messages: [{ role: "user", content: "Return JSON." }],
  }).reasoning,
  { effort: "none" },
  "OpenRouter GPT Mini Latest must default reasoning mode off",
);
assert.deepEqual(
  chatCompletionRequestBody({
    providerId: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    messages: [{ role: "user", content: "Return JSON." }],
  }).reasoning,
  { effort: "minimal" },
  "OpenRouter Gemini Flash Lite must request the minimum supported reasoning budget",
);

{
  let attempts = 0;
  const content = await chatCompletionWithProvider({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        const cause = new Error("socket reset");
        cause.code = "ECONNRESET";
        throw new TypeError("fetch failed", { cause });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200 });
    },
    providerId: "aliyun",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    model: "qwen3.6-flash",
    messages: [{ role: "user", content: "Return JSON." }],
    timeoutMs: 1000,
  });
  assert.equal(attempts, 3, "Transient fetch transport failures should be retried before surfacing to import state");
  assert.equal(content, "{\"ok\":true}", "Chat completion retry should return the successful response content");
}

console.log("Android/Desktop parity checks passed.");

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EarthRepository } from "../server/repository.mjs";
import { dataDir, dbPath, thumbDir, vectorPath } from "../server/config/paths.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.EARTH_ONLINE_BASE_URL ?? "http://127.0.0.1:8787";
const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tinyJpg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";

let server;
let beforeState;

async function request(pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function ensureServer() {
  try {
    await request("/api/state");
    return;
  } catch {
    server = spawn(process.execPath, ["server/index.mjs"], { cwd: rootDir, stdio: "ignore" });
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        await request("/api/state");
        return;
      } catch {
        // retry
      }
    }
    throw new Error("API server did not start");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function testSplitMergeRollback() {
  const before = await request("/api/state");
  const payload = {
    allowCloudAi: false,
    files: [
      { name: "kyoto-split-a.png", type: "image/png", size: 68, lastModified: new Date("2025-01-01T00:00:00Z").getTime(), dataUrl: tinyPng, thumbnailDataUrl: tinyJpg },
      { name: "paris-split-b.png", type: "image/png", size: 68, lastModified: new Date("2025-08-01T00:00:00Z").getTime(), dataUrl: tinyPng, thumbnailDataUrl: tinyJpg },
    ],
  };
  const imported = await request("/api/import", { method: "POST", body: JSON.stringify(payload) });
  const batch = imported.importBatches.at(-1);
  assert(batch.createdTripIds.length === 1 || batch.createdTripIds.length === 2, "import should create at least one trip");
  assert(batch.duplicateCount >= 1 || batch.addedPhotoIds.length >= 1, "duplicate detection or add should work");
  if (batch.createdTripIds.length > 1) {
    const merged = await request(`/api/import/${batch.id}/merge`, { method: "POST", body: "{}" });
    const mergedBatch = merged.importBatches.find((item) => item.id === batch.id);
    assert(mergedBatch.createdTripIds.length === 1, "merge should keep one trip id");
  }
  const rolled = await request(`/api/import/${batch.id}/rollback`, { method: "POST", body: "{}" });
  assert(rolled.photos.length === before.photos.length, "rollback should restore photo count");
}

async function testAppleImportExifRollback() {
  const before = await request("/api/state");
  const imported = await request("/api/import/apple-test", { method: "POST", body: "{}" });
  const batch = imported.importBatches.at(-1);
  const photos = imported.photos.filter((photo) => photo.importedBatchId === batch.id);
  assert(photos.length > 50 || batch.duplicateCount > 50, "Apple test import should process the provided set");
  assert(photos.every((photo) => photo.exifStatus?.time === "read" || photo.exifStatus?.time === "fallback"), "imported photos should have time status");
  assert(photos.some((photo) => photo.exifStatus?.gps === "read") || batch.duplicateCount > 50, "Apple set should include GPS-readable photos");
  if (batch.status === "pending_confirmation") {
    const rolled = await request(`/api/import/${batch.id}/rollback`, { method: "POST", body: "{}" });
    assert(rolled.photos.length === before.photos.length, "Apple rollback should restore photo count");
  }
}

async function testManualAndSearch() {
  const created = await request("/api/trips", { method: "POST", body: JSON.stringify({ title: "验收手动旅行", start: "2026-01-01", end: "2026-01-02" }) });
  const trip = created.trips.find((item) => item.title === "验收手动旅行") ?? created.trips.at(-1);
  const withPlace = await request("/api/places", { method: "POST", body: JSON.stringify({ tripId: trip.id, name: "验收地点", lat: 35, lng: 135 }) });
  const place = withPlace.placeNodes.find((item) => item.name === "验收地点" && item.tripId === trip.id);
  assert(place.tripId === trip.id, "manual place should belong to trip");
  const search = await request(`/api/search?tripId=${encodeURIComponent(trip.id)}`);
  assert(Array.isArray(search.results), "filtered search should return result array");
}

async function testStorageFiles() {
  assert(existsSync(path.join(dataDir, "earth-online.sqlite")), "SQLite database should exist");
  assert(existsSync(vectorPath), "vector index should exist");
  await fs.mkdir(thumbDir, { recursive: true });
}

async function main() {
  await ensureServer();
  const repository = new EarthRepository({
    dataDir,
    dbJsonPath: dbPath,
  });
  await repository.ensureInitialized();
  beforeState = repository.readState();
  await testStorageFiles();
  await testSplitMergeRollback();
  await testAppleImportExifRollback();
  await testManualAndSearch();
  repository.saveState(beforeState);
  console.log("MVP acceptance checks passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (beforeState) {
      try {
        const repository = new EarthRepository({
          dataDir,
          dbJsonPath: dbPath,
        });
        repository.saveState(beforeState);
      } catch {
        // best-effort cleanup
      }
    }
    if (server) server.kill();
  });

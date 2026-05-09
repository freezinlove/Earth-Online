import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { analyzeTravelImage, analyzeTravelImageVision, embedTravelImageAnalysis, embedTravelImageImage } from "../server/ai-provider.mjs";
import { createImportServices } from "../server/application/import-service.mjs";
import { createStateService } from "../server/application/state-service.mjs";
import { dataDir, dbPath, importJobDir, photoDir, rootDir, thumbDir, vectorPath } from "../server/config/paths.mjs";
import { EarthRepository } from "../server/repository.mjs";
import { makeId, mimeFromName, resetDataDir, saveEmptyState } from "./data_utils.mjs";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const sourceDataDir = path.resolve(argValue("--source", dataDir));
const sourcePhotoDir = path.join(sourceDataDir, "photos");
const sourceDbPath = path.join(sourceDataDir, "db.json");
const allowCloudAi = !process.argv.includes("--no-cloud");

function assertSafeSource() {
  if (!existsSync(path.join(sourceDataDir, "earth-online.sqlite"))) {
    throw new Error(`Source SQLite database not found: ${path.join(sourceDataDir, "earth-online.sqlite")}`);
  }
  if (!existsSync(sourcePhotoDir)) {
    throw new Error(`Source photo directory not found: ${sourcePhotoDir}`);
  }
}

async function collectSourceFiles() {
  const sourceRepository = new EarthRepository({ dataDir: sourceDataDir, dbJsonPath: sourceDbPath });
  await sourceRepository.ensureInitialized();
  const sourceState = sourceRepository.readState();
  sourceRepository.close();

  const files = [];
  for (const photo of sourceState.photos) {
    if (!photo.storageUrl?.startsWith("/data/photos/")) continue;
    const sourcePath = path.join(sourcePhotoDir, path.basename(photo.storageUrl));
    if (!existsSync(sourcePath)) continue;
    const stat = await fs.stat(sourcePath);
    files.push({
      name: photo.fileName || path.basename(sourcePath),
      type: photo.mime || mimeFromName(photo.fileName || sourcePath),
      size: stat.size,
      lastModified: photo.capturedAt ? new Date(String(photo.capturedAt).replace(/Z$/i, "")).getTime() : stat.mtimeMs,
      sourcePath,
    });
  }

  files.sort((left, right) => String(left.lastModified).localeCompare(String(right.lastModified)) || left.name.localeCompare(right.name));
  return files;
}

async function main() {
  assertSafeSource();
  const files = await collectSourceFiles();
  if (files.length === 0) throw new Error("No local imported photos found in source data.");

  await resetDataDir({ deleteFiles: true });
  await saveEmptyState();

  const repository = new EarthRepository({ dataDir, dbJsonPath: dbPath });
  const importJobs = new Map();
  const stateServices = createStateService({
    paths: { photoDir, thumbDir, importJobDir, vectorPath },
    repository,
  });
  const { ensureStorage, readState, readVectorIndex, responseState, writeState, writeVectorIndex } = stateServices;
  await ensureStorage();

  const importServices = createImportServices({
    analyzeTravelImage,
    analyzeTravelImageVision,
    embedTravelImageAnalysis,
    embedTravelImageImage,
    importJobs,
    makeId,
    paths: { rootDir, photoDir, thumbDir, importJobDir },
    readState,
    readVectorIndex,
    repository,
    responseState,
    writeState,
    writeVectorIndex,
  });

  const snapshot = await importServices.importPhotos({
    files,
    source: "rebuild-from-existing-local-photos",
    allowCloudAi,
    reanalyzeDuplicates: false,
  });
  const latestBatch = snapshot.importBatches.at(-1);
  const finalSnapshot = latestBatch ? await importServices.confirmImport(latestBatch.id) : snapshot;
  repository.close();

  console.log(
    JSON.stringify(
      {
        sourceDataDir,
        targetDataDir: dataDir,
        importedFiles: files.length,
        trips: finalSnapshot.trips.length,
        photos: finalSnapshot.photos.length,
        placeNodes: finalSnapshot.placeNodes.length,
        pendingItems: finalSnapshot.pendingItems.length,
        allowCloudAi,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import http from "node:http";
import { randomUUID } from "node:crypto";
import { analyzeTravelImage, analyzeTravelImageVision, embedSearchQuery, embedTravelImageAnalysis, embedTravelImageImage, inferMissingInfoWithImage } from "./ai-provider.mjs";
import { createEditServices } from "./application/edit-services.mjs";
import { createImportServices } from "./application/import-service.mjs";
import { createSearchService } from "./application/search-service.mjs";
import { createSettingsService } from "./application/settings-service.mjs";
import { createStateService } from "./application/state-service.mjs";
import { dataDir, dbPath, distDir, importJobDir, photoDir, port, rootDir, thumbDir, vectorPath } from "./config/paths.mjs";
import { createSecretProvider } from "./config/secrets.mjs";
import { createRouter } from "./http/router.mjs";
import { EarthRepository } from "./repository.mjs";
import { servePhoto, serveStatic } from "./storage/file-storage.mjs";
const repository = new EarthRepository({ dataDir, dbJsonPath: dbPath });
const importJobs = new Map();
const secretProvider = createSecretProvider({ rootDir, dataDir });

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

const stateServices = createStateService({
  paths: { photoDir, thumbDir, importJobDir, vectorPath },
  repository,
});
const { ensureStorage, readState, readVectorIndex, responseState, writeState, writeVectorIndex } = stateServices;
const editServices = createEditServices({
  readState,
  readVectorIndex,
  writeState,
  writeVectorIndex,
  responseState,
  makeId,
  paths: { photoDir, thumbDir },
});
const importServices = createImportServices({
  analyzeTravelImage,
  analyzeTravelImageVision,
  embedTravelImageAnalysis,
  embedTravelImageImage,
  inferMissingInfoWithImage,
  importJobs,
  makeId,
  paths: { rootDir, photoDir, thumbDir, importJobDir },
  readState,
  readVectorIndex,
  repository,
  responseState,
  secretProvider,
  writeState,
  writeVectorIndex,
});
const searchServices = createSearchService({ readState, readVectorIndex, embedSearchQuery, rootDir, secretProvider });
const settingsServices = createSettingsService({ secretProvider });

const server = http.createServer(
  createRouter(
    {
      responseState,
      secretProvider,
      ...searchServices,
      ...settingsServices,
      ...importServices,
      ...editServices,
      servePhoto,
      serveStatic,
    },
    { photoDir, thumbDir, distDir },
  ),
);

await ensureStorage();
server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Earth_Online API port is already in use: http://127.0.0.1:${port}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Earth_Online API listening on http://127.0.0.1:${port}`);
});

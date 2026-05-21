import http from "node:http";
import { randomUUID } from "node:crypto";
import { analyzeTravelImage, analyzeTravelImageVision, embedSearchQuery, embedTravelImageAnalysis, embedTravelImageImage, inferMissingInfoWithImage } from "./ai-provider.mjs";
import { createEditServices } from "./application/edit-services.mjs";
import { createImportServices } from "./application/import-service.mjs";
import { createSearchService } from "./application/search-service.mjs";
import { createSettingsService } from "./application/settings-service.mjs";
import { createStateService } from "./application/state-service.mjs";
import { aiInputDir, dataDir, dbPath, displayDir, distDir, importJobDir, photoDir, port as defaultPort, rootDir, thumbDir, vectorPath } from "./config/paths.mjs";
import { createSecretProvider } from "./config/secrets.mjs";
import { reverseLocalGeocode } from "./domain/local-geocoder.mjs";
import { createRouter } from "./http/router.mjs";
import { EarthRepository } from "./repository.mjs";
import { servePhoto, serveStatic } from "./storage/file-storage.mjs";

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function createEarthOnlineApiServer() {
  const repository = new EarthRepository({ dataDir, dbJsonPath: dbPath });
  const importJobs = new Map();
  const secretProvider = createSecretProvider({ rootDir, dataDir });

  const stateServices = createStateService({
    paths: { photoDir, thumbDir, aiInputDir, displayDir, importJobDir, vectorPath },
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
    paths: { photoDir, thumbDir, aiInputDir, displayDir },
  });
  const importServices = createImportServices({
    analyzeTravelImage,
    analyzeTravelImageVision,
    embedTravelImageAnalysis,
    embedTravelImageImage,
    inferMissingInfoWithImage,
    importJobs,
    makeId,
    paths: { rootDir, photoDir, thumbDir, aiInputDir, displayDir, importJobDir },
    readState,
    readVectorIndex,
    repository,
    responseState,
    secretProvider,
    writeState,
    writeVectorIndex,
  });
  const searchServices = createSearchService({ readState, readVectorIndex, embedSearchQuery, rootDir, secretProvider });
  const settingsServices = createSettingsService({
    rootDir,
    secretProvider,
    paths: { dataDir, dbPath, importJobDir, photoDir, thumbDir, aiInputDir, displayDir, vectorPath },
  });

  function reverseGeocode(params) {
    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { candidates: [] };
    return { candidates: reverseLocalGeocode({ lat, lng }, { preferCity: true }) };
  }

  const server = http.createServer(
    createRouter(
      {
        responseState,
        secretProvider,
        ...searchServices,
        ...settingsServices,
        reverseGeocode,
        ...importServices,
        ...editServices,
        servePhoto,
        serveStatic,
      },
      { photoDir, thumbDir, aiInputDir, displayDir, distDir },
    ),
  );

  async function start({ host = "127.0.0.1", port = defaultPort } = {}) {
    await ensureStorage();
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    return {
      host,
      port: actualPort,
      url: `http://${host}:${actualPort}`,
    };
  }

  async function close() {
    await new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    repository.close();
  }

  return {
    close,
    paths: { dataDir, dbPath, displayDir, distDir, aiInputDir, importJobDir, photoDir, rootDir, thumbDir, vectorPath },
    repository,
    server,
    start,
  };
}

export async function startEarthOnlineApiServer(options = {}) {
  const api = createEarthOnlineApiServer();
  const address = await api.start(options);
  return { ...api, ...address };
}

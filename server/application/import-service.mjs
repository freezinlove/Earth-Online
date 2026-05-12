import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { safeArray } from "../domain/arrays.mjs";
import { toDateInput } from "../domain/dates.mjs";
import { parseExif } from "../domain/exif-parser.mjs";
import { geoContextFor, haversineKm, inferPreset, isUsableLocation, localizedGeoHint, normalizeLocale } from "../domain/geo.mjs";
import { forwardLocalGeocode, reverseLocalGeocode } from "../domain/local-geocoder.mjs";
import { mergeLocationCandidates, resolveImportedLocation, toAiEvidence } from "../domain/location-resolver.mjs";
import { cleanPlaceName } from "../domain/place-name-selector.mjs";
import { buildPlacesForGroup } from "../domain/place-projector.mjs";
import { buildPhotoRoute, buildRoute } from "../domain/route-projector.mjs";
import { makePhotoTitle } from "../domain/text-normalizer.mjs";
import { rebuildTrips } from "../domain/trip-rebuilder.mjs";
import { dominantPresetsForPhotos, findAdjacentTrip, groupImportedPhotos } from "../domain/trip-resolver.mjs";
import { readMultipartFormDataToDir } from "../http/body.mjs";
import { extFromName, hashBuffer } from "../storage/file-storage.mjs";

export function createImportServices({
  analyzeTravelImage,
  analyzeTravelImageVision = analyzeTravelImage,
  embedTravelImageAnalysis,
  embedTravelImageImage,
  inferMissingInfoWithImage,
  importJobs,
  makeId,
  paths,
  readState,
  readVectorIndex,
  repository,
  responseState,
  secretProvider,
  writeState,
  writeVectorIndex,
}) {
  const jobSubscribers = new Map();
  const metadataConcurrency = Number(process.env.EARTH_ONLINE_IMPORT_METADATA_CONCURRENCY ?? 16);
  const storageWriteConcurrency = Number(process.env.EARTH_ONLINE_IMPORT_STORAGE_WRITE_CONCURRENCY ?? 16);
  const aiConcurrency = Number(process.env.EARTH_ONLINE_IMPORT_AI_CONCURRENCY ?? 200);
  const embeddingConcurrency = Number(process.env.EARTH_ONLINE_IMPORT_EMBEDDING_CONCURRENCY ?? 600);
  const missingInferenceConcurrency = Number(process.env.EARTH_ONLINE_MISSING_INFERENCE_CONCURRENCY ?? 200);
  const failedImportJobRetentionMs = Number(process.env.EARTH_ONLINE_FAILED_IMPORT_JOB_RETENTION_MS ?? 24 * 60 * 60 * 1000);
  const aiImageMaxDimension = Number(process.env.EARTH_ONLINE_AI_IMAGE_MAX_DIMENSION ?? 1200);
  const aiImageJpegQuality = Number(process.env.EARTH_ONLINE_AI_IMAGE_JPEG_QUALITY ?? 82);
  const missingGpsLowConfidenceThreshold = 0.55;
  const closeNeighborContextMs = 15 * 60 * 1000;

  async function mapConcurrent(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= items.length) return;
          results[index] = await worker(items[index], index);
        }
      }),
    );
    return results;
  }

  function createLimiter(limit) {
    const max = Math.max(1, Number(limit) || 1);
    let active = 0;
    const queue = [];
    const drain = () => {
      if (active >= max) return;
      const next = queue.shift();
      if (!next) return;
      active += 1;
      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    };
    return (task) =>
      new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
      });
  }

  async function readImportFile(file) {
    const fullPath = file.tempPath || file.sourcePath;
    if (fullPath) {
      const buffer = await fs.readFile(fullPath);
      return { fullPath, mime: file.type || "image/jpeg", buffer };
    }
    throw new Error(`Import file is missing a tempPath/sourcePath: ${file.name || "unnamed"}`);
  }

  async function createThumbnailFromFile(fullPath, ext) {
    try {
      return {
        ext: ".jpg",
        buffer: await sharp(fullPath, { failOn: "none" }).rotate().resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(),
      };
    } catch {
      return { ext, buffer: await fs.readFile(fullPath) };
    }
  }

  async function readAiImagePayloadFromFile(fullPath, mime) {
    const maxDimension = Number.isFinite(aiImageMaxDimension) && aiImageMaxDimension > 0 ? aiImageMaxDimension : 1200;
    const quality = Number.isFinite(aiImageJpegQuality) && aiImageJpegQuality > 0 && aiImageJpegQuality <= 100 ? aiImageJpegQuality : 82;
    try {
      const buffer = await sharp(fullPath, { failOn: "none" })
        .rotate()
        .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      return {
        mime: "image/jpeg",
        dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      };
    } catch {
      const buffer = await fs.readFile(fullPath);
      return {
        mime,
        dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
      };
    }
  }

  async function cleanupStaleImportJobDirs() {
    if (!paths.importJobDir) return;
    const retentionMs = Number.isFinite(failedImportJobRetentionMs) && failedImportJobRetentionMs > 0 ? failedImportJobRetentionMs : 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    const entries = await fs.readdir(paths.importJobDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = path.join(paths.importJobDir, entry.name);
          const stat = await fs.stat(fullPath).catch(() => undefined);
          if (stat && stat.mtimeMs < cutoff) await fs.rm(fullPath, { recursive: true, force: true });
        }),
    );
  }

  async function importPhotos(payload, progress = {}) {
    const state = await readState();
    const vectorIndex = await readVectorIndex();
    const now = new Date();
    const files = safeArray(payload.files).slice(0, 1000);
    const locale = normalizeLocale(payload.locale);
    if (files.length === 0) throw new Error("没有收到可导入图片。");

    const batchId = makeId("batch");
    const imported = [];
    const duplicateNames = [];
    const aiStats = {
      qwenCount: 0,
      fallbackCount: 0,
      embeddingCount: 0,
      qwenEmbeddingCount: 0,
      deterministicEmbeddingCount: 0,
    };
    const knownHashToPhoto = new Map(state.photos.filter((photo) => photo.originalHash).map((photo) => [photo.originalHash, photo]));
    const knownHashes = new Set(knownHashToPhoto.keys());
    const duplicatePhotoIds = new Set();
    let exifDone = 0;
    let thumbnailDone = 0;
    let aiDone = 0;
    let embeddingDone = 0;
    progress.update?.({ phase: "exif", done: 0, total: files.length });
    progress.update?.({ phase: "thumbnails", done: 0, total: files.length });
    progress.update?.({ phase: "ai", done: 0, total: files.length });
    progress.update?.({ phase: "embedding", done: 0, total: files.length });

    const storageLimit = createLimiter(storageWriteConcurrency);
    const visionLimit = createLimiter(aiConcurrency);
    const embeddingLimit = createLimiter(embeddingConcurrency);
    const downstreamTasks = [];
    const importedSlots = new Array(files.length);
    const allowCloud = payload.allowCloudAi !== false;

    const markThumbnailDone = (fileName) => {
      thumbnailDone += 1;
      progress.update?.({ phase: "thumbnails", done: thumbnailDone, total: files.length, currentFileName: fileName });
    };
    const markAiDone = (fileName) => {
      aiDone += 1;
      progress.update?.({ phase: "ai", done: aiDone, total: files.length, currentFileName: fileName });
    };
    const markEmbeddingDone = (fileName) => {
      embeddingDone += 1;
      progress.update?.({ phase: "embedding", done: embeddingDone, total: files.length, currentFileName: fileName });
    };

    await mapConcurrent(files, metadataConcurrency, async (file, index) => {
      const fileName = file.name || `photo-${index + 1}`;
      progress.update?.({ phase: "exif", done: exifDone, total: files.length, currentFileName: fileName });
      const parsed = await readImportFile(file);
      const { fullPath, mime, buffer } = parsed;
      const ext = extFromName(file.name, mime);
      const originalHash = hashBuffer(buffer);
      const exif = parseExif(buffer);
      exifDone += 1;
      progress.update?.({ phase: "exif", done: exifDone, total: files.length, currentFileName: fileName });

      if (knownHashes.has(originalHash)) {
        duplicateNames.push(fileName);
        const duplicatePhoto = knownHashToPhoto.get(originalHash);
        if (duplicatePhoto?.id) duplicatePhotoIds.add(duplicatePhoto.id);
        markThumbnailDone(fileName);
        if (payload.reanalyzeDuplicates) {
          const existingPhoto = duplicatePhoto;
          if (existingPhoto) {
            const parsedLocation = isUsableLocation(exif.location) ? exif.location : existingPhoto.location;
            const aiImagePayload = allowCloud ? readAiImagePayloadFromFile(fullPath, mime) : Promise.resolve(undefined);
            downstreamTasks.push(
              Promise.all([
                visionLimit(async () => {
                  const imagePayload = await aiImagePayload;
                  const ai = await analyzePhotoVision({
                    fileName,
                    mime: imagePayload?.mime ?? mime,
                    dataUrl: imagePayload?.dataUrl,
                    preset: inferPreset(fileName, parsedLocation),
                    location: parsedLocation,
                    allowCloud,
                    locale,
                  });
                  recordVisionStats(ai, aiStats);
                  markAiDone(fileName);
                  return ai;
                }),
                embeddingLimit(async () => {
                  const imagePayload = await aiImagePayload;
                  const embedding = await embedPhotoImage({ fileName, mime: imagePayload?.mime ?? mime, dataUrl: imagePayload?.dataUrl, allowCloud });
                  recordEmbeddingStats(embedding, aiStats);
                  markEmbeddingDone(fileName);
                  return embedding;
                }),
              ]).then(([ai, embedding]) => {
                const resolvedLocation = existingPhoto.location ?? parsedLocation;
                const aiEvidenceBase = toAiEvidence(ai, { makeId });
                const aiEvidence = withBackendLocationCandidates({ location: resolvedLocation, aiEvidence: aiEvidenceBase, locale });
                existingPhoto.tags = ai.tags;
                existingPhoto.title = ai.title || makePhotoTitle(existingPhoto);
                existingPhoto.aiCaption = ai.caption;
                existingPhoto.ai = aiEvidence;
                existingPhoto.locationResolution = resolveImportedLocation({
                  location: resolvedLocation,
                  aiEvidence,
                  pendingReason: existingPhoto.pendingReason,
                });
                existingPhoto.aiProvider = ai.provider;
                existingPhoto.aiModel = ai.model;
                existingPhoto.aiFallbackReason = ai.fallbackReason;
                existingPhoto.embeddingProvider = embedding.embeddingProvider;
                existingPhoto.embeddingModel = embedding.embeddingModel;
                existingPhoto.embeddingSpaceId = embedding.embeddingSpaceId;
                existingPhoto.embeddingDimension = embedding.embeddingDimension ?? embedding.embedding?.length;
                existingPhoto.embeddingMode = embedding.embeddingMode;
                existingPhoto.embeddingFallbackReason = embedding.embeddingFallbackReason;
                if (parsedLocation && !existingPhoto.location) existingPhoto.location = parsedLocation;
                if (Array.isArray(embedding.embedding)) vectorIndex[existingPhoto.id] = embedding.embedding;
                else delete vectorIndex[existingPhoto.id];
              }),
            );
          }
        } else {
          markAiDone(fileName);
          markEmbeddingDone(fileName);
        }
        return;
      }

      knownHashes.add(originalHash);
      const photoId = makeId("photo");
      const storageName = `${photoId}${ext}`;
      const storagePath = path.join(paths.photoDir, storageName);
      const parsedLocation = isUsableLocation(exif.location) ? exif.location : undefined;
      const preset = inferPreset(fileName, parsedLocation);
      const capturedAt =
        exif.capturedAt ??
        (file.lastModified ? new Date(file.lastModified).toISOString() : new Date(now.getTime() - (files.length - index) * 86400000).toISOString());
      const hasExifLocation = Boolean(parsedLocation);
      const location = parsedLocation;
      const pendingReason = !location ? "missing_gps" : !exif.capturedAt ? "missing_time" : undefined;
      const newAiJob = {
        type: "new",
        index,
        photoId,
        fileName,
        storageName,
        thumbName: `${photoId}.jpg`,
        originalHash,
        mime,
        fullPath,
        preset,
        location,
        capturedAt,
        pendingReason,
        hasExifLocation,
        hasExifTime: Boolean(exif.capturedAt),
      };
      const aiImagePayload = allowCloud ? readAiImagePayloadFromFile(fullPath, mime) : Promise.resolve(undefined);
      downstreamTasks.push(
        Promise.all([
          storageLimit(async () => {
            const thumbnail = await createThumbnailFromFile(fullPath, ext);
            const thumbName = `${photoId}${thumbnail.ext}`;
            await Promise.all([fs.copyFile(fullPath, storagePath), fs.writeFile(path.join(paths.thumbDir, thumbName), thumbnail.buffer)]);
            markThumbnailDone(fileName);
            return thumbName;
          }),
          visionLimit(async () => {
            const imagePayload = await aiImagePayload;
            const ai = await analyzePhotoVision({
              fileName,
              mime: imagePayload?.mime ?? mime,
              dataUrl: imagePayload?.dataUrl,
              preset,
              location,
              allowCloud,
              locale,
            });
            recordVisionStats(ai, aiStats);
            markAiDone(fileName);
            return ai;
          }),
          embeddingLimit(async () => {
            const imagePayload = await aiImagePayload;
            const embedding = await embedPhotoImage({ fileName, mime: imagePayload?.mime ?? mime, dataUrl: imagePayload?.dataUrl, allowCloud });
            recordEmbeddingStats(embedding, aiStats);
            markEmbeddingDone(fileName);
            return embedding;
          }),
        ]).then(([thumbName, ai, embedding]) => {
          const aiFailure = buildAiFailure(ai, embedding, newAiJob);
          const photoPendingReason = aiFailure ? "ai_processing_failed" : newAiJob.pendingReason;
          const aiEvidenceBase = toAiEvidence(ai, { makeId });
          const aiEvidence = withBackendLocationCandidates({ location: newAiJob.location, aiEvidence: aiEvidenceBase, locale });
          const photo = {
            id: newAiJob.photoId,
            fileName: newAiJob.fileName || newAiJob.storageName,
            title: ai.title || makePhotoTitle({ fileName: newAiJob.fileName || newAiJob.storageName, tags: ai.tags, aiCaption: ai.caption }),
            originalHash: newAiJob.originalHash,
            mime: newAiJob.mime,
            thumbnailUrl: `/data/thumbs/${thumbName}`,
            storageUrl: `/data/photos/${newAiJob.storageName}`,
            capturedAt: newAiJob.capturedAt,
            location: newAiJob.location,
            tags: ai.tags,
            aiCaption: ai.caption,
            ai: aiEvidence,
            locationResolution: resolveImportedLocation({ location: newAiJob.location, aiEvidence, pendingReason: photoPendingReason }),
            aiProvider: ai.provider,
            aiModel: ai.model,
            aiFallbackReason: ai.fallbackReason,
            embeddingProvider: embedding.embeddingProvider,
            embeddingModel: embedding.embeddingModel,
            embeddingSpaceId: embedding.embeddingSpaceId,
            embeddingDimension: embedding.embeddingDimension ?? embedding.embedding?.length,
            embeddingMode: embedding.embeddingMode,
            embeddingFallbackReason: embedding.embeddingFallbackReason,
            aiFailure,
            importedBatchId: batchId,
            pendingReason: photoPendingReason,
            exifStatus: {
              time: newAiJob.hasExifTime ? "read" : "fallback",
              gps: newAiJob.hasExifLocation ? "read" : "missing",
            },
          };
          if (Array.isArray(embedding.embedding)) vectorIndex[photo.id] = embedding.embedding;
          importedSlots[newAiJob.index] = photo;
        }),
      );
    });

    await Promise.all(downstreamTasks);
    imported.push(...importedSlots.filter(Boolean));

    progress.update?.({ phase: "grouping", done: files.length, total: files.length });
    const groups = imported.length ? groupImportedPhotos(imported) : [];
    const createdTrips = [];
    const updatedTripIds = new Set();
    const pendingItems = [];
    let workingTrips = state.trips.slice();
    let workingPhotos = [...state.photos, ...imported];
    let workingPlaceNodes = state.placeNodes.slice();
    let workingRoutes = state.routes.slice();

    for (const [groupIndex, group] of groups.entries()) {
      const first = group[0];
      const firstLocated = group.find((photo) => photo.location);
      const preset = inferPreset(first.fileName, firstLocated?.location);
      const start = toDateInput(group[0]?.capturedAt);
      const end = toDateInput(group.at(-1)?.capturedAt);
      const adjacentTrip = findAdjacentTrip({ ...state, trips: workingTrips }, group);
      const tripId = adjacentTrip?.id ?? makeId("trip");
      const title = importTripTitle({ month: start.slice(0, 7), city: preset.city, groupIndex, groupCount: groups.length, locale });
      let trip = adjacentTrip;
      if (!trip) {
        trip = {
          id: tripId,
          title,
          dateRange: { start, end },
          countries: [preset.country],
          cities: [preset.city],
          coverUrl: first.thumbnailUrl,
          photoCount: group.length,
          placeNodeCount: 0,
          status: "pending",
          source: "import",
        };
        createdTrips.push(trip);
        workingTrips.push(trip);
      } else {
        updatedTripIds.add(tripId);
      }
      for (const photo of group) photo.tripId = tripId;
      const tripPhotosAfter = workingPhotos.filter((photo) => photo.tripId === tripId);
      const archivableTripPhotos = tripPhotosAfter.filter((photo) => !hasMissingImportInfo(photo) && !hasAiProcessingFailure(photo));
      const tripLocatedAfter = archivableTripPhotos.filter((photo) => photo.location);
      if (tripLocatedAfter.length) {
        const places = buildPlacesForGroup(archivableTripPhotos, tripId, { makeId, existingPlaces: workingPlaceNodes.filter((place) => place.tripId === tripId) });
        workingPlaceNodes = workingPlaceNodes.filter((place) => place.tripId !== tripId).concat(places);
        workingRoutes = workingRoutes.filter((route) => route.tripId !== tripId).concat(buildPhotoRoute(tripId, tripLocatedAfter));
        for (const photo of tripPhotosAfter) photo.placeNodeId = undefined;
        for (const place of places) {
          for (const photoId of place.photoIds) {
            const photo = tripPhotosAfter.find((item) => item.id === photoId);
            if (photo) photo.placeNodeId = place.id;
          }
        }
      }
      const tripDates = tripPhotosAfter.map((photo) => photo.capturedAt).filter(Boolean).sort();
      const geoSummary = dominantPresetsForPhotos(tripPhotosAfter);
      workingTrips = workingTrips.map((item) =>
        item.id === tripId
          ? {
              ...item,
              title: createdTrips.some((createdTrip) => createdTrip.id === tripId)
                ? importTripTitle({
                    month: toDateInput(tripDates[0]).slice(0, 7),
                    city: geoSummary.cities.length > 1 ? importTripMultiCityLabel(locale) : geoSummary.cities[0],
                    locale,
                  })
                : item.title,
              dateRange: { start: toDateInput(tripDates[0] ?? start), end: toDateInput(tripDates.at(-1) ?? end) },
              countries: geoSummary.countries.length ? geoSummary.countries : item.countries,
              cities: geoSummary.cities,
              coverUrl: item.coverUrl || first.thumbnailUrl,
            }
          : item,
      );
      pendingItems.push({
        id: makeId("pending"),
        type: "needs_trip_confirmation",
        relatedPhotoIds: group.map((photo) => photo.id),
        relatedTripId: tripId,
        suggestion: adjacentTrip ? `建议把这次导入追加到已有旅行档案「${adjacentTrip.title}」。` : `建议创建新的旅行档案「${title}」。`,
        reason: "系统基于拍摄时间、GPS/文件名地点线索和 Qwen 标签给出建议，需要用户确认。",
        status: "open",
        proposal: {
          action: "confirm_trip_assignment",
          tripId,
          photoIds: group.map((photo) => photo.id),
        },
      });
    }

    addLocationPendingItems(imported, pendingItems);
    addMissingInfoPendingItems(imported, pendingItems);
    addAiFailurePendingItems(imported, pendingItems);

    const aiFailures = imported.filter(hasAiProcessingFailure);
    const missing = imported.filter((photo) => hasMissingImportInfo(photo) && !hasAiProcessingFailure(photo));
    if (groups.length > 1 || imported.length >= 6) {
      pendingItems.push({
        id: makeId("pending"),
        type: "split_suggestion",
        relatedPhotoIds: imported.map((photo) => photo.id),
        suggestion: groups.length > 1 ? `这批照片可能包含 ${groups.length} 段旅行，已按明显时间断层拆成多个待确认 Trip。` : "这批照片数量较多，可能包含多段旅行，请确认是否仍保留为当前归档建议。",
        reason: "MVP 使用明显时间断层作为拆分建议依据，不做强制静默拆分。",
        status: "open",
      });
    }
    const recent = imported.some((photo) => Math.abs(now.getTime() - new Date(photo.capturedAt).getTime()) <= 24 * 60 * 60 * 1000);
    if (recent) {
      pendingItems.push({
        id: makeId("pending"),
        type: "recent_import",
        relatedPhotoIds: imported.map((photo) => photo.id),
        relatedTripId: createdTrips[0]?.id,
        suggestion: "这批照片拍摄于最近 24 小时内，可加入当前旅行、新建正在进行的旅行，或暂不归档。",
        reason: "近期照片归属必须由用户确认。",
        status: "open",
      });
    }

    const batch = {
      id: batchId,
      importedAt: now.toISOString(),
      totalCount: files.length,
      successCount: imported.length - missing.length - aiFailures.length,
      failedCount: missing.length + aiFailures.length,
      duplicateCount: duplicateNames.length,
      duplicatePhotoIds: Array.from(duplicatePhotoIds),
      duplicateNames,
      status: imported.length > 0 ? "pending_confirmation" : "confirmed",
      createdTripIds: createdTrips.map((trip) => trip.id),
      updatedTripIds: Array.from(updatedTripIds),
      addedPhotoIds: imported.map((photo) => photo.id),
      pendingItemIds: pendingItems.map((item) => item.id),
      storedFileNames: imported.map((photo) => path.basename(photo.storageUrl)),
      storedThumbnailNames: imported.map((photo) => path.basename(photo.thumbnailUrl)),
      aiStats,
      summary:
        imported.length > 0
          ? `新增 ${imported.length} 张照片，跳过 ${duplicateNames.length} 张重复照片，创建 ${createdTrips.length} 个待确认旅行档案，${missing.length} 张需要补充时间或地点，${aiFailures.length} 张 AI 初次处理失败。`
          : `没有新增照片，已跳过 ${duplicateNames.length} 张重复照片；其中 ${aiStats.qwenCount + aiStats.fallbackCount} 张完成了 AI 重新分析。`,
    };

    await writeVectorIndex(vectorIndex);
    await writeState({
      ...state,
      trips: workingTrips,
      photos: workingPhotos,
      placeNodes: workingPlaceNodes,
      routes: workingRoutes,
      importBatches: [...state.importBatches, batch],
      pendingItems: [...state.pendingItems, ...pendingItems],
    });
    progress.update?.({ phase: "completed", done: files.length, total: files.length });
    return responseState();
  }

  async function startImportJob(payload) {
    const id = makeId("job");
    return enqueueImportJob(id, {
      ...payload,
      allowCloudAi: payload.allowCloudAi === "false" ? false : payload.allowCloudAi === "true" ? true : payload.allowCloudAi,
      reanalyzeDuplicates: payload.reanalyzeDuplicates === "true" ? true : payload.reanalyzeDuplicates,
      files: safeArray(payload.files),
    });
  }

  async function startMultipartImportJob(req) {
    await cleanupStaleImportJobDirs();
    const id = makeId("job");
    const rawDir = path.join(paths.importJobDir ?? path.join(paths.rootDir, "data", "import-jobs"), id, "raw");
    let payload;
    try {
      payload = await readMultipartFormDataToDir(req, rawDir);
    } catch (error) {
      await fs.rm(path.dirname(rawDir), { recursive: true, force: true });
      throw error;
    }
    return enqueueImportJob(id, {
      ...payload,
      allowCloudAi: payload.allowCloudAi === "false" ? false : payload.allowCloudAi === "true" ? true : payload.allowCloudAi,
      reanalyzeDuplicates: payload.reanalyzeDuplicates === "true" ? true : payload.reanalyzeDuplicates,
    });
  }

  function enqueueImportJob(id, jobPayload) {
    const total = safeArray(jobPayload.files).length;
    const createdAt = new Date().toISOString();
    const initialProgress = {
      phase: "queued",
      done: 0,
      total,
      steps: {
        upload: { done: total, total },
        exif: { done: 0, total },
        thumbnails: { done: 0, total },
        ai: { done: 0, total },
        embedding: { done: 0, total },
      },
    };
    const job = {
      id,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: initialProgress,
      progressEvents: [{ ...initialProgress, sequence: 0, createdAt }],
      result: undefined,
      error: undefined,
    };
    importJobs.set(id, job);
    repository.saveImportJob(job);
    setTimeout(async () => {
      const current = importJobs.get(id);
      if (!current) return;
      current.status = "processing";
      current.updatedAt = new Date().toISOString();
      current.progress = {
        phase: "exif",
        done: 0,
        total,
        steps: {
          upload: { done: total, total },
          exif: { done: 0, total },
          thumbnails: { done: 0, total },
          ai: { done: 0, total },
          embedding: { done: 0, total },
        },
      };
      appendProgressEvent(current);
      repository.saveImportJob(current);
      const updateProgress = (next) => {
        const steps = { ...(current.progress?.steps ?? {}) };
        if (["uploading", "exif", "thumbnails", "ai", "embedding"].includes(next.phase)) {
          const stepKey = next.phase === "uploading" ? "upload" : next.phase;
          steps[next.phase] = {
            done: next.done ?? steps[next.phase]?.done ?? 0,
            total: next.total ?? steps[next.phase]?.total ?? total,
            currentFileName: next.currentFileName,
          };
          steps[stepKey] = {
            done: next.done ?? steps[stepKey]?.done ?? 0,
            total: next.total ?? steps[stepKey]?.total ?? total,
            currentFileName: next.currentFileName,
          };
        }
        if (next.phase === "completed") {
          steps.upload = { ...(steps.upload ?? {}), done: total, total };
          steps.exif = { ...(steps.exif ?? {}), done: total, total };
          steps.thumbnails = { ...(steps.thumbnails ?? {}), done: total, total };
          steps.ai = { ...(steps.ai ?? {}), done: total, total };
          steps.embedding = { ...(steps.embedding ?? {}), done: total, total };
        }
        current.progress = {
          ...(current.progress ?? {}),
          ...next,
          total: next.total ?? current.progress?.total ?? total,
          steps,
        };
        current.updatedAt = new Date().toISOString();
        appendProgressEvent(current);
        repository.saveImportJob(current);
      };
      try {
        current.result = await importPhotos(jobPayload, { update: updateProgress });
        if (paths.importJobDir) await fs.rm(path.join(paths.importJobDir, id), { recursive: true, force: true });
        current.status = "completed";
        current.progress = {
          ...(current.progress ?? {}),
          phase: "completed",
          done: total,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            upload: { done: total, total },
            exif: { done: total, total },
            thumbnails: { done: total, total },
            ai: { done: total, total },
            embedding: { done: total, total },
          },
        };
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "import job failed";
        current.progress = { ...(current.progress ?? {}), phase: "failed", total };
        appendProgressEvent(current);
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
      publishJobTerminal(current);
    }, 0);
    return job;
  }

  async function startPendingInferenceJob(batchId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") {
      throw new Error("找不到待确认导入批次。");
    }
    const requestedIds = new Set(safeArray(body.pendingIds).map(String));
    const pendingItems = state.pendingItems.filter(
      (item) =>
        batch.pendingItemIds.includes(item.id) &&
        item.status === "open" &&
        ["missing_gps", "confirm_location_candidate"].includes(item.type) &&
        requestedIds.has(item.id),
    );
    return enqueuePendingInferenceJob(makeId("job"), { batchId, pendingIds: pendingItems.map((item) => item.id), locale: normalizeLocale(body.locale) });
  }

  async function startAiFailureResolveJob(batchId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") {
      throw new Error("找不到待确认导入批次。");
    }
    const requestedIds = new Set(safeArray(body.pendingIds).map(String));
    const action = ["retry_vision", "retry_embedding", "retry_both"].includes(body.action) ? body.action : "retry_vision";
    const pendingItems = state.pendingItems.filter(
      (item) =>
        batch.pendingItemIds.includes(item.id) &&
        item.status === "open" &&
        item.type === "ai_processing_failed" &&
        requestedIds.has(item.id),
    );
    return enqueueAiFailureResolveJob(makeId("job"), { batchId, pendingIds: pendingItems.map((item) => item.id), action, locale: normalizeLocale(body.locale) });
  }

  function enqueuePendingInferenceJob(id, jobPayload) {
    const total = safeArray(jobPayload.pendingIds).length;
    const createdAt = new Date().toISOString();
    const initialProgress = {
      phase: "queued",
      done: 0,
      total,
      steps: {
        ai: { done: 0, total },
      },
    };
    const job = {
      id,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: initialProgress,
      progressEvents: [{ ...initialProgress, sequence: 0, createdAt }],
      result: undefined,
      error: undefined,
    };
    importJobs.set(id, job);
    repository.saveImportJob(job);
    setTimeout(async () => {
      const current = importJobs.get(id);
      if (!current) return;
      current.status = "processing";
      current.updatedAt = new Date().toISOString();
      current.progress = {
        phase: "ai",
        done: 0,
        total,
        steps: {
          ai: { done: 0, total },
        },
      };
      appendProgressEvent(current);
      repository.saveImportJob(current);
      const updateProgress = (next) => {
        const steps = { ...(current.progress?.steps ?? {}) };
        steps.ai = {
          done: next.done ?? steps.ai?.done ?? 0,
          total: next.total ?? steps.ai?.total ?? total,
          currentFileName: next.currentFileName,
        };
        current.progress = {
          ...(current.progress ?? {}),
          ...next,
          phase: next.phase ?? "ai",
          total: next.total ?? current.progress?.total ?? total,
          steps,
        };
        current.updatedAt = new Date().toISOString();
        appendProgressEvent(current);
        repository.saveImportJob(current);
      };
      try {
        current.result = await inferPendingLocationsBatch(jobPayload, { update: updateProgress });
        current.status = "completed";
        current.progress = {
          ...(current.progress ?? {}),
          phase: "completed",
          done: total,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            ai: { done: total, total },
          },
        };
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "pending inference job failed";
        current.progress = { ...(current.progress ?? {}), phase: "failed", total };
        appendProgressEvent(current);
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
      publishJobTerminal(current);
    }, 0);
    return job;
  }

  function enqueueAiFailureResolveJob(id, jobPayload) {
    const total = safeArray(jobPayload.pendingIds).length;
    const createdAt = new Date().toISOString();
    const initialProgress = {
      phase: "queued",
      done: 0,
      total,
      steps: {
        ai: { done: 0, total },
      },
    };
    const job = {
      id,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: initialProgress,
      progressEvents: [{ ...initialProgress, sequence: 0, createdAt }],
      result: undefined,
      error: undefined,
    };
    importJobs.set(id, job);
    repository.saveImportJob(job);
    setTimeout(async () => {
      const current = importJobs.get(id);
      if (!current) return;
      current.status = "processing";
      current.updatedAt = new Date().toISOString();
      current.progress = {
        phase: "ai",
        done: 0,
        total,
        steps: {
          ai: { done: 0, total },
        },
      };
      appendProgressEvent(current);
      repository.saveImportJob(current);
      const updateProgress = (next) => {
        const steps = { ...(current.progress?.steps ?? {}) };
        steps.ai = {
          done: next.done ?? steps.ai?.done ?? 0,
          total: next.total ?? steps.ai?.total ?? total,
          currentFileName: next.currentFileName,
        };
        current.progress = {
          ...(current.progress ?? {}),
          ...next,
          phase: next.phase ?? "ai",
          total: next.total ?? current.progress?.total ?? total,
          steps,
        };
        current.updatedAt = new Date().toISOString();
        appendProgressEvent(current);
        repository.saveImportJob(current);
      };
      try {
        current.result = await resolveImportAiFailuresBatch(jobPayload, { update: updateProgress });
        current.status = "completed";
        current.progress = {
          ...(current.progress ?? {}),
          phase: "completed",
          done: total,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            ai: { done: total, total },
          },
        };
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "AI failure resolve job failed";
        current.progress = { ...(current.progress ?? {}), phase: "failed", total };
        appendProgressEvent(current);
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
      publishJobTerminal(current);
    }, 0);
    return job;
  }

  function enqueueEmbeddingRebuildJob(id, jobPayload = {}) {
    const createdAt = new Date().toISOString();
    const job = {
      id,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: {
        phase: "queued",
        done: 0,
        total: 0,
        steps: {
          embedding: { done: 0, total: 0 },
        },
      },
      progressEvents: [
        {
          phase: "queued",
          done: 0,
          total: 0,
          steps: {
            embedding: { done: 0, total: 0 },
          },
          sequence: 0,
          createdAt,
        },
      ],
      result: undefined,
      error: undefined,
    };
    importJobs.set(id, job);
    repository.saveImportJob(job);
    setTimeout(async () => {
      const current = importJobs.get(id);
      if (!current) return;
      current.status = "processing";
      current.updatedAt = new Date().toISOString();
      const updateProgress = (next) => {
        const total = next.total ?? current.progress?.total ?? 0;
        const done = next.done ?? current.progress?.done ?? 0;
        current.progress = {
          ...(current.progress ?? {}),
          ...next,
          phase: next.phase ?? "embedding",
          done,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            embedding: {
              done,
              total,
              currentFileName: next.currentFileName,
            },
          },
        };
        current.updatedAt = new Date().toISOString();
        appendProgressEvent(current);
        repository.saveImportJob(current);
      };
      updateProgress({ phase: "embedding", done: 0, total: 0 });
      try {
        current.result = await rebuildPhotoEmbeddings(jobPayload, { update: updateProgress });
        const total = current.progress?.total ?? 0;
        current.status = "completed";
        current.progress = {
          ...(current.progress ?? {}),
          phase: "completed",
          done: total,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            embedding: { done: total, total },
          },
        };
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "embedding rebuild job failed";
        current.progress = { ...(current.progress ?? {}), phase: "failed" };
        appendProgressEvent(current);
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
      publishJobTerminal(current);
    }, 0);
    return job;
  }

  function startEmbeddingRebuildJob(body = {}) {
    return enqueueEmbeddingRebuildJob(makeId("job"), {
      photoIds: safeArray(body.photoIds).map(String).filter(Boolean),
    });
  }

  async function rebuildPhotoEmbeddings(jobPayload = {}, progress = {}) {
    const state = await readState();
    const requestedPhotoIds = new Set(safeArray(jobPayload.photoIds).map(String).filter(Boolean));
    const photos = requestedPhotoIds.size ? safeArray(state.photos).filter((photo) => requestedPhotoIds.has(photo.id)) : safeArray(state.photos);
    const total = photos.length;
    const previousVectorIndex = await readVectorIndex();
    const nextVectorIndex = requestedPhotoIds.size ? { ...previousVectorIndex } : {};
    const failed = [];
    const succeeded = [];
    let done = 0;
    progress.update?.({ phase: "embedding", done, total });
    const rebuiltPhotos = await mapConcurrent(photos, embeddingConcurrency, async (photo) => {
      const imagePayload = await readPhotoImagePayload(photo);
      let embedding;
      if (imagePayload) {
        embedding = await embedPhotoImageWithRetry({
          fileName: photo.fileName,
          mime: imagePayload.mime,
          dataUrl: imagePayload.dataUrl,
          allowCloud: true,
        });
      } else {
        embedding = {
          embedding: undefined,
          embeddingProvider: undefined,
          embeddingModel: undefined,
          embeddingSpaceId: undefined,
          embeddingDimension: undefined,
          embeddingMode: "failed",
          embeddingFallbackReason: "找不到原图，无法重建向量。",
        };
      }
      const success = Array.isArray(embedding.embedding) && embedding.embedding.length > 0 && embedding.embeddingMode === "cross_modal";
      if (success) {
        nextVectorIndex[photo.id] = embedding.embedding;
        succeeded.push(photo.id);
      } else {
        delete nextVectorIndex[photo.id];
        failed.push({
          id: photo.id,
          fileName: photo.fileName,
          reason: embedding.embeddingFallbackReason || "向量模型未返回可用 embedding。",
        });
      }
      done += 1;
      progress.update?.({ phase: "embedding", done, total, currentFileName: photo.fileName });
      return {
        ...photo,
        embeddingProvider: embedding.embeddingProvider,
        embeddingModel: embedding.embeddingModel,
        embeddingSpaceId: embedding.embeddingSpaceId,
        embeddingDimension: embedding.embeddingDimension ?? embedding.embedding?.length,
        embeddingMode: embedding.embeddingMode,
        embeddingFallbackReason: embedding.embeddingFallbackReason,
      };
    });
    const rebuiltById = new Map(rebuiltPhotos.map((photo) => [photo.id, photo]));
    await writeVectorIndex(nextVectorIndex);
    const nextState = {
      ...state,
      photos: safeArray(state.photos).map((photo) => rebuiltById.get(photo.id) ?? photo),
    };
    await writeState({
      ...nextState,
    });
    progress.update?.({ phase: "completed", done: total, total });
    return {
      ...(await responseState()),
      embeddingRebuild: {
        total,
        successCount: succeeded.length,
        failedCount: failed.length,
        failedPhotoIds: failed.map((item) => item.id),
        failures: failed,
        mode: requestedPhotoIds.size ? "retry_failed" : "all",
      },
    };
  }

  async function wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function embedPhotoImageWithRetry(input, { attempts = 3 } = {}) {
    let latest;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      latest = await embedPhotoImage(input);
      if (Array.isArray(latest.embedding) && latest.embedding.length > 0 && latest.embeddingMode === "cross_modal") return latest;
      if (attempt < attempts) await wait(400 * attempt);
    }
    return latest;
  }

  function appendProgressEvent(job) {
    const progress = job.progress;
    if (!progress) return;
    const previous = safeArray(job.progressEvents);
    const last = previous.at(-1);
    if (last && last.phase === progress.phase && last.done === progress.done && last.total === progress.total && last.currentFileName === progress.currentFileName) return;
    const sequence = Number.isFinite(Number(last?.sequence)) ? Number(last.sequence) + 1 : 0;
    const event = {
      ...JSON.parse(JSON.stringify(progress)),
      sequence,
      createdAt: job.updatedAt ?? new Date().toISOString(),
    };
    job.progressEvents = [...previous, event].slice(-3000);
    publishJobProgress(job.id, event);
  }

  function writeSse(res, eventName, payload) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function publishJobProgress(jobId, event) {
    const subscribers = jobSubscribers.get(jobId);
    if (!subscribers?.size) return;
    for (const res of subscribers) writeSse(res, "progress", event);
  }

  function publishJobTerminal(job) {
    const subscribers = jobSubscribers.get(job.id);
    if (!subscribers?.size) return;
    for (const res of subscribers) {
      writeSse(res, "done", { status: job.status, error: job.error });
      res.end();
    }
    jobSubscribers.delete(job.id);
  }

  function subscribeImportJob(id, req, res) {
    const job = getImportJob(id);
    if (!job) return false;
    res.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    for (const event of safeArray(job.progressEvents)) writeSse(res, "progress", event);
    if (job.status === "completed" || job.status === "failed") {
      writeSse(res, "done", { status: job.status, error: job.error });
      res.end();
      return true;
    }
    const subscribers = jobSubscribers.get(id) ?? new Set();
    subscribers.add(res);
    jobSubscribers.set(id, subscribers);
    req.on("close", () => {
      const current = jobSubscribers.get(id);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) jobSubscribers.delete(id);
    });
    return true;
  }

  function getImportJob(id) {
    const job = importJobs.get(id);
    return job ?? repository.getImportJob(id);
  }

  async function importAppleTestPhotos(options = {}) {
    const appleDir = path.join(paths.rootDir, "DESIGN_SPECS", "photo test", "apple");
    const entries = await fs.readdir(appleDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && /\.(jpe?g|png|heic)$/i.test(entry.name)) {
        const sourcePath = path.join(appleDir, entry.name);
        const stat = await fs.stat(sourcePath);
        files.push({
          name: entry.name,
          type: /\.(png)$/i.test(entry.name) ? "image/png" : /\.(heic)$/i.test(entry.name) ? "image/heic" : "image/jpeg",
          size: stat.size,
          lastModified: stat.mtimeMs,
          sourcePath,
        });
      }
    }
    const limitedFiles = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? files.slice(0, Number(options.limit)) : files;
    return importPhotos({
      files: limitedFiles,
      source: "apple-test",
      allowCloudAi: Boolean(options.allowCloudAi) || process.env.EARTH_ONLINE_TEST_CLOUD_AI === "1",
      reanalyzeDuplicates: Boolean(options.allowCloudAi),
    });
  }

  async function confirmImport(id) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === id);
    if (!batch || batch.status !== "pending_confirmation") return responseState();
    const openMissingItems = state.pendingItems.filter(
      (item) =>
        batch.pendingItemIds.includes(item.id) &&
        item.status === "open" &&
        ["missing_gps", "missing_time", "confirm_location_candidate", "ai_processing_failed"].includes(item.type),
    );
    if (openMissingItems.length) throw new Error("仍有待补信息或 AI 初次处理失败照片未处理，不能确认导入。");
    await writeState({
      ...state,
      trips: state.trips.map((trip) => (batch.createdTripIds.includes(trip.id) ? { ...trip, status: "confirmed" } : trip)),
      importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "confirmed" } : item)),
    });
    return responseState();
  }

  async function inferPendingLocation(batchId, pendingId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const pending = state.pendingItems.find((item) => item.id === pendingId);
    if (!batch || batch.status !== "pending_confirmation" || !pending || !batch.pendingItemIds.includes(pending.id)) return responseState();
    if (!["missing_gps", "confirm_location_candidate"].includes(pending.type)) return responseState();

    const proposal = await buildMissingInfoInferenceProposal(state, batch, pending, { locale: normalizeLocale(body.locale) });
    const latestState = await readState();
    const latestBatch = latestState.importBatches.find((item) => item.id === batchId);
    const latestPending = latestState.pendingItems.find((item) => item.id === pendingId);
    if (!latestBatch || latestBatch.status !== "pending_confirmation" || !latestPending || !latestBatch.pendingItemIds.includes(latestPending.id)) return responseState();
    if (!["missing_gps", "confirm_location_candidate"].includes(latestPending.type)) return responseState();
    const nextPending = applyMissingInfoProposal(latestPending, proposal);
    await writeState({
      ...latestState,
      pendingItems: latestState.pendingItems.map((item) => (item.id === latestPending.id ? nextPending : item)),
    });
    return responseState();
  }

  async function inferPendingLocationsBatch({ batchId, pendingIds, locale: rawLocale }, progress = {}) {
    const state = await readState();
    const locale = normalizeLocale(rawLocale);
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") return responseState();
    const requestedIds = new Set(safeArray(pendingIds).map(String));
    const items = state.pendingItems.filter(
      (item) =>
        batch.pendingItemIds.includes(item.id) &&
        item.status === "open" &&
        ["missing_gps", "confirm_location_candidate"].includes(item.type) &&
        requestedIds.has(item.id),
    );
    const total = items.length;
    let done = 0;
    progress.update?.({ phase: "ai", done, total });
    const results = await mapConcurrent(items, missingInferenceConcurrency, async (pending) => {
      const photo = state.photos.find((item) => pending.relatedPhotoIds.includes(item.id));
      try {
        const proposal = await buildMissingInfoInferenceProposal(state, batch, pending, { locale });
        return { pendingId: pending.id, proposal };
      } catch (error) {
        return {
          pendingId: pending.id,
          proposal: keepPending(error instanceof Error ? error.message : missingInferenceText(locale, "secondInferenceFailed"), 0, locale),
        };
      } finally {
        done += 1;
        progress.update?.({ phase: "ai", done, total, currentFileName: photo?.fileName });
      }
    });
    const proposalByPendingId = new Map(results.map((item) => [item.pendingId, item.proposal]));
    const latestState = await readState();
    const latestBatch = latestState.importBatches.find((item) => item.id === batchId);
    if (!latestBatch || latestBatch.status !== "pending_confirmation") return responseState();
    await writeState({
      ...latestState,
      pendingItems: latestState.pendingItems.map((item) => {
        const proposal = proposalByPendingId.get(item.id);
        if (!proposal || !latestBatch.pendingItemIds.includes(item.id) || item.status !== "open") return item;
        if (!["missing_gps", "confirm_location_candidate"].includes(item.type)) return item;
        return applyMissingInfoProposal(item, proposal);
      }),
    });
    progress.update?.({ phase: "completed", done: total, total });
    return responseState();
  }

  function applyMissingInfoProposal(pending, proposal) {
    return {
      ...pending,
      suggestion: proposal.suggestion,
      reason: proposal.reason,
      proposal: proposal.actionable ? proposal.proposal : undefined,
      inference: {
        status: proposal.actionable ? "suggested" : "keep_pending",
        confidence: proposal.confidence,
        reason: proposal.reason,
        displayTarget: proposal.displayTarget,
        displayTargetLabel: proposal.displayTargetLabel,
        displayTargetBadge: proposal.displayTargetBadge,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  async function rollbackImport(id) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === id);
    const latestPending = state.importBatches.filter((item) => item.status === "pending_confirmation").at(-1);
    if (!batch || batch.id !== latestPending?.id) throw new Error("MVP 只支持回撤最近一次待确认导入。");
    const photoIds = new Set(batch.addedPhotoIds);
    const tripIds = new Set(batch.createdTripIds);
    const affectedExistingTripIds = new Set(safeArray(batch.updatedTripIds));
    const pendingIds = new Set(batch.pendingItemIds);
    for (const name of safeArray(batch.storedFileNames)) {
      await fs.rm(path.join(paths.photoDir, path.basename(name)), { force: true });
    }
    for (const name of safeArray(batch.storedThumbnailNames)) {
      await fs.rm(path.join(paths.thumbDir, path.basename(name)), { force: true });
    }
    const vectorIndex = await readVectorIndex();
    for (const id of photoIds) delete vectorIndex[id];
    await writeVectorIndex(vectorIndex);
    const base = {
      ...state,
      photos: state.photos.filter((photo) => !photoIds.has(photo.id)),
      trips: state.trips.filter((trip) => !tripIds.has(trip.id)),
      placeNodes: state.placeNodes.filter((place) => !tripIds.has(place.tripId)),
      routes: state.routes.filter((route) => !tripIds.has(route.tripId)),
      pendingItems: state.pendingItems.filter((item) => !pendingIds.has(item.id)),
      importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "rolled_back" } : item)),
    };
    await writeState(rebuildTrips(base, affectedExistingTripIds, { makeId }));
    return responseState();
  }

  async function cancelImportPhotos(batchId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const latestPending = state.importBatches.filter((item) => item.status === "pending_confirmation").at(-1);
    if (!batch || batch.id !== latestPending?.id) throw new Error("只能从最近一次待确认导入中取消照片。");
    const requested = new Set(safeArray(body.photoIds));
    const batchPhotoIds = new Set(batch.addedPhotoIds);
    const cancelIds = new Set([...requested].filter((id) => batchPhotoIds.has(id)));
    if (cancelIds.size === 0) return responseState();

    const cancelPhotos = state.photos.filter((photo) => cancelIds.has(photo.id));
    for (const photo of cancelPhotos) {
      if (photo.storageUrl) await fs.rm(path.join(paths.photoDir, path.basename(photo.storageUrl)), { force: true });
      if (photo.thumbnailUrl) await fs.rm(path.join(paths.thumbDir, path.basename(photo.thumbnailUrl)), { force: true });
    }

    const affectedTripIds = new Set(cancelPhotos.map((photo) => photo.tripId).filter(Boolean));
    const remainingAddedPhotoIds = batch.addedPhotoIds.filter((id) => !cancelIds.has(id));
    const emptyCreatedTripIds = new Set(
      batch.createdTripIds.filter((tripId) => !state.photos.some((photo) => photo.tripId === tripId && !cancelIds.has(photo.id))),
    );
    for (const tripId of emptyCreatedTripIds) affectedTripIds.delete(tripId);

    const pendingItems = state.pendingItems
      .map((item) => {
        if (!batch.pendingItemIds.includes(item.id)) return item;
        const relatedPhotoIds = safeArray(item.relatedPhotoIds).filter((id) => !cancelIds.has(id));
        return { ...item, relatedPhotoIds };
      })
      .filter((item) => !batch.pendingItemIds.includes(item.id) || item.relatedPhotoIds.length > 0);
    const pendingIds = new Set(pendingItems.filter((item) => batch.pendingItemIds.includes(item.id)).map((item) => item.id));

    const vectorIndex = await readVectorIndex();
    for (const id of cancelIds) delete vectorIndex[id];
    await writeVectorIndex(vectorIndex);

    const canceledMissingCount = cancelPhotos.filter((photo) => photo.pendingReason).length;
    const canceledSuccessCount = cancelIds.size - canceledMissingCount;
    const patchedBatch = {
      ...batch,
      totalCount: Math.max(0, batch.totalCount - cancelIds.size),
      successCount: Math.max(0, batch.successCount - canceledSuccessCount),
      failedCount: Math.max(0, batch.failedCount - canceledMissingCount),
      createdTripIds: batch.createdTripIds.filter((id) => !emptyCreatedTripIds.has(id)),
      addedPhotoIds: remainingAddedPhotoIds,
      pendingItemIds: batch.pendingItemIds.filter((id) => pendingIds.has(id)),
      storedFileNames: safeArray(batch.storedFileNames).filter((name) => !cancelPhotos.some((photo) => path.basename(photo.storageUrl ?? "") === path.basename(name))),
      storedThumbnailNames: safeArray(batch.storedThumbnailNames).filter((name) => !cancelPhotos.some((photo) => path.basename(photo.thumbnailUrl ?? "") === path.basename(name))),
      status: remainingAddedPhotoIds.length > 0 ? batch.status : "rolled_back",
      summary: `${batch.summary} 已取消 ${cancelIds.size} 张待补照片。`,
    };
    const base = {
      ...state,
      photos: state.photos.filter((photo) => !cancelIds.has(photo.id)),
      trips: state.trips.filter((trip) => !emptyCreatedTripIds.has(trip.id)),
      placeNodes: state.placeNodes.filter((place) => !emptyCreatedTripIds.has(place.tripId)).map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => !cancelIds.has(id)) })),
      routes: state.routes.filter((route) => !emptyCreatedTripIds.has(route.tripId)),
      pendingItems,
      importBatches: state.importBatches.map((item) => (item.id === batchId ? patchedBatch : item)),
    };
    await writeState(rebuildTrips(base, affectedTripIds, { makeId }));
    return responseState();
  }

  async function resolveImportAiFailure(batchId, pendingId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const pending = state.pendingItems.find((item) => item.id === pendingId);
    if (!batch || batch.status !== "pending_confirmation" || !pending || !batch.pendingItemIds.includes(pending.id) || pending.type !== "ai_processing_failed") return responseState();
    const photo = state.photos.find((item) => item.id === pending.relatedPhotoIds?.[0]);
    if (!photo) return responseState();

    if (body.action === "archive_exif") return archiveAiFailureWithExif(state, batch, pending, photo);
    if (body.action === "retry_vision" || body.action === "retry_embedding" || body.action === "retry_both") return retryImportAiFailure(state, batch, pending, photo, body.action, { locale: normalizeLocale(body.locale) });
    throw new Error("未知的 AI 失败处理方式。");
  }

  async function resolveImportAiFailuresBatch({ batchId, pendingIds, action = "retry_vision", locale: rawLocale }, progress = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "pending_confirmation") return responseState();
    const locale = normalizeLocale(rawLocale);
    const requestedIds = new Set(safeArray(pendingIds).map(String));
    const items = state.pendingItems
      .filter((pending) => pending.status === "open" && pending.type === "ai_processing_failed" && batch.pendingItemIds.includes(pending.id) && requestedIds.has(pending.id))
      .map((pending) => ({
        pending,
        photo: state.photos.find((photo) => pending.relatedPhotoIds?.includes(photo.id)),
      }))
      .filter((item) => Boolean(item.photo));
    const total = items.length;
    let done = 0;
    progress.update?.({ phase: "ai", done, total });
    const results = await mapConcurrent(items, aiConcurrency, async ({ pending, photo }) => {
      try {
        const retry = await buildRetryImportAiFailureResult(state, batch, pending, photo, action, { locale });
        return { pendingId: pending.id, photoId: photo.id, retry };
      } catch (error) {
        return { pendingId: pending.id, photoId: photo.id, error: error instanceof Error ? error.message : "AI Vision 重跑失败。" };
      } finally {
        done += 1;
        progress.update?.({ phase: "ai", done, total, currentFileName: photo?.fileName });
      }
    });

    const latestState = await readState();
    const latestBatch = latestState.importBatches.find((item) => item.id === batchId);
    if (!latestBatch || latestBatch.status !== "pending_confirmation") return responseState();

    let nextState = latestState;
    const vectorIndex = await readVectorIndex();
    const affectedTripIds = new Set([...latestBatch.createdTripIds, ...(latestBatch.updatedTripIds ?? [])].filter(Boolean));
    const resultByPendingId = new Map(results.map((item) => [item.pendingId, item]));
    nextState = {
      ...nextState,
      photos: nextState.photos.map((photo) => {
        const pending = nextState.pendingItems.find((item) => item.status === "open" && item.type === "ai_processing_failed" && latestBatch.pendingItemIds.includes(item.id) && item.relatedPhotoIds?.includes(photo.id));
        const result = pending ? resultByPendingId.get(pending.id) : undefined;
        if (!result?.retry) return photo;
        if (photo.tripId) affectedTripIds.add(photo.tripId);
        if (result.retry.retryEmbedding && Array.isArray(result.retry.embedding.embedding)) vectorIndex[photo.id] = result.retry.embedding.embedding;
        else if (result.retry.retryEmbedding) delete vectorIndex[photo.id];
        return result.retry.patchedPhoto;
      }),
      pendingItems: nextState.pendingItems.map((pending) => {
        const result = resultByPendingId.get(pending.id);
        if (!result || !latestBatch.pendingItemIds.includes(pending.id) || pending.status !== "open" || pending.type !== "ai_processing_failed") return pending;
        if (result.error) return { ...pending, reason: result.error, suggestion: "初次导入 AI 重跑失败，需要重新选择处理方式。" };
        if (!result.retry) return pending;
        return result.retry.failed
          ? { ...pending, reason: failureReasonText(result.retry.patchedPhoto), suggestion: `${result.retry.patchedPhoto.title ?? result.retry.patchedPhoto.fileName} 初次导入 AI 仍处理失败，需要重新选择处理方式。` }
          : { ...pending, status: "accepted" };
      }),
    };
    await writeVectorIndex(vectorIndex);
    for (const result of results) {
      if (!result.retry || result.retry.failed) continue;
      const currentBatch = nextState.importBatches.find((item) => item.id === batchId) ?? latestBatch;
      nextState = appendMissingInfoPendingIfNeeded(nextState, currentBatch, result.retry.patchedPhoto);
    }
    await writeState(rebuildTrips(nextState, affectedTripIds, { makeId, allowExistingPlaceMerge: true }));
    progress.update?.({ phase: "completed", done: total, total });
    return responseState();
  }

  async function archiveAiFailureWithExif(state, batch, pending, photo) {
    if (photo.exifStatus?.gps !== "read" || !isUsableLocation(photo.location)) throw new Error("这张照片没有真实 EXIF GPS，不能直接按真实定位归档。");
    const patchedPhoto = {
      ...clearAiFailureForPhoto(photo),
      placeNodeId: undefined,
    };
    const nextState = appendMissingInfoPendingIfNeeded(
      {
        ...state,
        photos: state.photos.map((item) => (item.id === photo.id ? patchedPhoto : item)),
        pendingItems: state.pendingItems.map((item) => (item.id === pending.id ? { ...item, status: "accepted" } : item)),
      },
      batch,
      patchedPhoto,
    );
    await writeState(rebuildTripsForImportedPhoto(nextState, patchedPhoto, batch, { allowExistingPlaceMerge: true }));
    return responseState();
  }

  async function buildRetryImportAiFailureResult(state, batch, pending, photo, action, { locale = "zh" } = {}) {
    const imagePayload = await readPhotoImagePayload(photo);
    if (!imagePayload) throw new Error("找不到原图，无法重跑初次导入 AI。");
    const retryVision = action === "retry_vision" || action === "retry_both";
    const retryEmbedding = action === "retry_embedding" || action === "retry_both";
    let ai = photo.ai
      ? {
          provider: photo.aiProvider ?? photo.ai.provider,
          promptId: photo.ai.promptId,
          promptVersion: photo.ai.promptVersion,
          model: photo.aiModel ?? photo.ai.model,
          title: photo.title,
          tags: photo.tags ?? [],
          caption: photo.aiCaption,
          visiblePlaceNames: photo.ai.visiblePlaceNames ?? [],
          locationCandidates: photo.ai.locationCandidates ?? [],
          uncertainties: photo.ai.uncertainties ?? [],
          fallbackReason: photo.aiFallbackReason,
        }
      : undefined;
    let embedding = {
      embedding: undefined,
      embeddingProvider: photo.embeddingProvider,
      embeddingModel: photo.embeddingModel,
      embeddingSpaceId: photo.embeddingSpaceId,
      embeddingDimension: photo.embeddingDimension,
      embeddingMode: photo.embeddingMode,
      embeddingFallbackReason: photo.embeddingFallbackReason,
    };
    if (retryVision) {
      ai = await analyzePhotoVision({
        fileName: photo.fileName,
        mime: imagePayload.mime,
        dataUrl: imagePayload.dataUrl,
        preset: inferPreset(photo.fileName, photo.location),
        location: photo.location,
        allowCloud: true,
        locale,
      });
    }
    if (!ai) throw new Error("照片缺少可用的初次导入分析结果。");
    if (retryEmbedding) {
      embedding = await embedPhotoImage({
        fileName: photo.fileName,
        mime: imagePayload.mime,
        dataUrl: imagePayload.dataUrl,
        allowCloud: true,
      });
    }

    const nextFailure = {
      vision: retryVision ? ai.fallbackReason : photo.aiFailure?.vision,
      embedding: retryEmbedding ? embeddingFailureReason(embedding) : photo.aiFailure?.embedding,
      hasRealExifGps: photo.exifStatus?.gps === "read" && isUsableLocation(photo.location),
      hasRealExifTime: photo.exifStatus?.time === "read",
      updatedAt: new Date().toISOString(),
    };
    const failed = Boolean(nextFailure.vision || nextFailure.embedding);
    const aiEvidenceBase = toAiEvidence(ai, { makeId });
    const aiEvidence = withBackendLocationCandidates({ location: photo.location, aiEvidence: aiEvidenceBase, locale });
    const patchedPhoto = {
      ...photo,
      title: ai.title || makePhotoTitle({ fileName: photo.fileName, tags: ai.tags, aiCaption: ai.caption }),
      tags: ai.tags,
      aiCaption: ai.caption,
      ai: aiEvidence,
      locationResolution: resolveImportedLocation({ location: photo.location, aiEvidence, pendingReason: failed ? "ai_processing_failed" : pendingReasonFromExif(photo) }),
      aiProvider: ai.provider,
      aiModel: ai.model,
      aiFallbackReason: ai.fallbackReason,
      embeddingProvider: retryEmbedding ? embedding.embeddingProvider : photo.embeddingProvider,
      embeddingModel: retryEmbedding ? embedding.embeddingModel : photo.embeddingModel,
      embeddingSpaceId: retryEmbedding ? embedding.embeddingSpaceId : photo.embeddingSpaceId,
      embeddingDimension: retryEmbedding ? embedding.embeddingDimension ?? embedding.embedding?.length : photo.embeddingDimension,
      embeddingMode: retryEmbedding ? embedding.embeddingMode : photo.embeddingMode,
      embeddingFallbackReason: retryEmbedding ? embedding.embeddingFallbackReason : photo.embeddingFallbackReason,
      aiFailure: failed ? nextFailure : undefined,
      pendingReason: failed ? "ai_processing_failed" : pendingReasonFromExif(photo),
    };

    return { patchedPhoto, embedding, failed, retryEmbedding };
  }

  async function retryImportAiFailure(state, batch, pending, photo, action, { locale = "zh" } = {}) {
    const retry = await buildRetryImportAiFailureResult(state, batch, pending, photo, action, { locale });
    const vectorIndex = await readVectorIndex();
    if (retry.retryEmbedding && Array.isArray(retry.embedding.embedding)) vectorIndex[photo.id] = retry.embedding.embedding;
    else if (retry.retryEmbedding) delete vectorIndex[photo.id];
    await writeVectorIndex(vectorIndex);
    const nextState = appendMissingInfoPendingIfNeeded(
      {
        ...state,
        photos: state.photos.map((item) => (item.id === photo.id ? retry.patchedPhoto : item)),
        pendingItems: state.pendingItems.map((item) => (item.id === pending.id && !retry.failed ? { ...item, status: "accepted" } : item.id === pending.id ? { ...item, reason: failureReasonText(retry.patchedPhoto), suggestion: `${retry.patchedPhoto.title ?? retry.patchedPhoto.fileName} 初次导入 AI 仍处理失败，需要重新选择处理方式。` } : item)),
      },
      batch,
      retry.patchedPhoto,
    );
    await writeState(rebuildTripsForImportedPhoto(nextState, retry.patchedPhoto, batch, { allowExistingPlaceMerge: true }));
    return responseState();
  }

  function pendingReasonFromExif(photo) {
    if (photo.exifStatus?.gps === "missing" || !isUsableLocation(photo.location)) return "missing_gps";
    if (photo.exifStatus?.time !== "read") return "missing_time";
    return undefined;
  }

  function clearAiFailureForPhoto(photo) {
    const aiEvidence = withBackendLocationCandidates({ location: photo.location, aiEvidence: photo.ai });
    return {
      ...photo,
      aiFailure: undefined,
      pendingReason: pendingReasonFromExif(photo),
      ai: aiEvidence,
      locationResolution: resolveImportedLocation({ location: photo.location, aiEvidence, pendingReason: pendingReasonFromExif(photo) }),
    };
  }

  function appendMissingInfoPendingIfNeeded(state, batch, photo) {
    if (hasAiProcessingFailure(photo) || !hasMissingImportInfo(photo)) return state;
    const alreadyOpen = state.pendingItems.some(
      (item) => item.status === "open" && batch.pendingItemIds.includes(item.id) && ["missing_gps", "missing_time", "confirm_location_candidate"].includes(item.type) && item.relatedPhotoIds?.includes(photo.id),
    );
    if (alreadyOpen) return state;
    const nextItems = [];
    addLocationPendingItems([photo], nextItems);
    addMissingInfoPendingItems([photo], nextItems);
    if (!nextItems.length) return state;
    return {
      ...state,
      pendingItems: [...state.pendingItems, ...nextItems],
      importBatches: state.importBatches.map((item) => (item.id === batch.id ? { ...item, pendingItemIds: [...item.pendingItemIds, ...nextItems.map((pendingItem) => pendingItem.id)] } : item)),
    };
  }

  function failureReasonText(photo) {
    return [
      photo.aiFailure?.hasRealExifGps ? "真实GPS" : "无GPS",
      photo.aiFailure?.vision ? `AI Vision：${photo.aiFailure.vision}` : undefined,
      photo.aiFailure?.embedding ? `Embedding：${photo.aiFailure.embedding}` : undefined,
    ]
      .filter(Boolean)
      .join("。");
  }

  function rebuildTripsForImportedPhoto(state, photo, batch, options = {}) {
    const affectedTripIds = new Set([photo.tripId, ...batch.createdTripIds, ...(batch.updatedTripIds ?? [])].filter(Boolean));
    return rebuildTrips(state, affectedTripIds, { makeId, ...options });
  }

  async function mergeImportTrips(batchId) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.createdTripIds.length <= 1) return responseState();
    const [targetTripId, ...removeTripIds] = batch.createdTripIds;
    const removeSet = new Set(removeTripIds);
    const batchPhotos = state.photos.filter((photo) => batch.addedPhotoIds.includes(photo.id));
    const dates = batchPhotos.map((photo) => photo.capturedAt).filter(Boolean).sort();
    const placeNodes = state.placeNodes.map((place) => (removeSet.has(place.tripId) ? { ...place, tripId: targetTripId } : place));
    const targetPlaces = placeNodes.filter((place) => place.tripId === targetTripId);
    const routes = state.routes.filter((route) => !batch.createdTripIds.includes(route.tripId)).concat(buildRoute(targetTripId, targetPlaces));
    await writeState({
      ...state,
      photos: state.photos.map((photo) => (batch.addedPhotoIds.includes(photo.id) ? { ...photo, tripId: targetTripId } : photo)),
      trips: state.trips
        .filter((trip) => !removeSet.has(trip.id))
        .map((trip) =>
          trip.id === targetTripId
            ? {
                ...trip,
                title: trip.title.replace(/\s+\d+$/, ""),
                dateRange: { start: toDateInput(dates[0]), end: toDateInput(dates.at(-1)) },
                cities: Array.from(new Set(state.trips.filter((item) => batch.createdTripIds.includes(item.id)).flatMap((item) => item.cities))),
                countries: Array.from(new Set(state.trips.filter((item) => batch.createdTripIds.includes(item.id)).flatMap((item) => item.countries))),
              }
            : trip,
        ),
      placeNodes,
      routes,
      importBatches: state.importBatches.map((item) => (item.id === batchId ? { ...item, createdTripIds: [targetTripId], summary: `${item.summary} 已按用户选择合并为一个旅行档案。` } : item)),
      pendingItems: state.pendingItems.map((item) => (item.type === "split_suggestion" && batch.pendingItemIds.includes(item.id) ? { ...item, status: "accepted" } : item)),
    });
    return responseState();
  }

  async function analyzePhotoVision({ fileName, mime, dataUrl, preset, location, allowCloud, locale = "zh" }) {
    return analyzeTravelImageVision({
      rootDir: paths.rootDir,
      secretProvider,
      fileName,
      mime,
      dataUrl,
      preset,
      geoContext: geoContextFor(preset, location, locale),
      allowCloud,
      locale,
    });
  }

  function importTripTitle({ month, city, groupIndex = 0, groupCount = 1, locale = "zh" }) {
    const suffix = groupCount > 1 ? ` ${groupIndex + 1}` : "";
    if (normalizeLocale(locale) === "en") return `${month} ${localizedGeoHint(city, locale)} trip${suffix}`;
    return `${month} ${city}旅行${suffix}`;
  }

  function importTripMultiCityLabel(locale = "zh") {
    return normalizeLocale(locale) === "en" ? "Europe multi-city" : "欧洲多城";
  }

  async function embedPhotoAnalysis({ fileName, analysis, allowCloud }) {
    if (!embedTravelImageAnalysis) {
      return {
        embedding: analysis.embedding,
        embeddingProvider: analysis.embeddingProvider,
        embeddingModel: analysis.embeddingModel,
        embeddingSpaceId: analysis.embeddingSpaceId,
        embeddingDimension: analysis.embeddingDimension ?? analysis.embedding?.length,
        embeddingMode: analysis.embeddingMode ?? "disabled",
      };
    }
    return embedTravelImageAnalysis({
      rootDir: paths.rootDir,
      secretProvider,
      fileName,
      analysis,
      allowCloud,
    });
  }

  async function embedPhotoImage({ fileName, mime, dataUrl, allowCloud }) {
    if (!embedTravelImageImage) {
      return embedPhotoAnalysis({
        fileName,
        analysis: { title: fileName, caption: mime, tags: [], visiblePlaceNames: [] },
        allowCloud: false,
      });
    }
    return embedTravelImageImage({
      rootDir: paths.rootDir,
      secretProvider,
      fileName,
      mime,
      dataUrl,
      allowCloud,
    });
  }

  function recordVisionStats(ai, aiStats) {
    if (ai.provider === "qwen" || ai.provider === "aliyun") aiStats.qwenCount += 1;
    else aiStats.fallbackCount += 1;
  }

  function recordEmbeddingStats(ai, aiStats) {
    if (Array.isArray(ai.embedding) && ai.embedding.length > 0) aiStats.embeddingCount += 1;
    if (ai.embeddingProvider === "qwen" || ai.embeddingProvider === "aliyun") aiStats.qwenEmbeddingCount += 1;
    else if (ai.embeddingMode !== "cross_modal") aiStats.deterministicEmbeddingCount += 1;
  }

  function embeddingFailureReason(embedding) {
    if (!embedding) return undefined;
    if (embedding.embeddingMode !== "failed") return undefined;
    return embedding.embeddingFallbackReason || "Embedding 未返回可用向量。";
  }

  function buildAiFailure(ai, embedding, job) {
    const vision = ai?.fallbackReason;
    const embeddingFailure = embeddingFailureReason(embedding);
    if (!vision && !embeddingFailure) return undefined;
    return {
      vision,
      embedding: embeddingFailure,
      hasRealExifGps: Boolean(job.hasExifLocation),
      hasRealExifTime: Boolean(job.hasExifTime),
      updatedAt: new Date().toISOString(),
    };
  }

  function hasAiProcessingFailure(photo) {
    return Boolean(photo.aiFailure?.vision || photo.aiFailure?.embedding || photo.pendingReason === "ai_processing_failed");
  }

  function addLocationPendingItems(imported, pendingItems) {
    const suggestedLocations = imported.filter((photo) => !hasAiProcessingFailure(photo) && photo.locationResolution?.status === "suggested" && photo.locationResolution.candidateId);
    for (const photo of suggestedLocations) {
      const candidate = completeCandidatePoint(photo.locationResolution.candidates.find((item) => item.id === photo.locationResolution.candidateId));
      if (!candidate?.point) continue;
      pendingItems.push({
        id: makeId("pending"),
        type: "confirm_location_candidate",
        relatedPhotoIds: [photo.id],
        relatedTripId: photo.tripId,
        suggestion: `AI 建议将「${photo.title ?? photo.fileName}」定位到「${photo.locationResolution.effectiveName}」。`,
        reason: "照片缺少可靠 EXIF GPS，但 AI 给出了可解释的地点候选，需要用户确认后才写入确定坐标。",
        status: "open",
        proposal: {
          action: "create_place_from_candidate",
          tripId: photo.tripId,
          photoIds: [photo.id],
          candidate,
        },
      });
    }
  }

  function addMissingInfoPendingItems(imported, pendingItems) {
    for (const photo of imported.filter((item) => hasMissingImportInfo(item) && !hasAiProcessingFailure(item))) {
      const missingGps = photo.exifStatus?.gps === "missing" || photo.pendingReason === "missing_gps";
      const missingTime = photo.exifStatus?.time !== "read";
      pendingItems.push({
        id: makeId("pending"),
        type: missingGps ? "missing_gps" : "missing_time",
        relatedPhotoIds: [photo.id],
        relatedTripId: photo.tripId,
        suggestion: `${photo.title ?? photo.fileName} 缺少${missingGps && missingTime ? " GPS 和 EXIF 时间" : missingGps ? " GPS" : " EXIF 时间"}，可手动触发基于上下文推断。`,
        reason: "初次导入只完成单张照片理解；需要用户在待补信息中手动触发上下文推断后再确认。",
        status: "open",
      });
    }
  }

  function addAiFailurePendingItems(imported, pendingItems) {
    for (const photo of imported.filter(hasAiProcessingFailure)) {
      const failedParts = [photo.aiFailure?.vision ? "AI Vision" : undefined, photo.aiFailure?.embedding ? "Embedding" : undefined].filter(Boolean).join(" / ");
      const gpsLabel = photo.aiFailure?.hasRealExifGps ? "真实GPS" : "无GPS";
      pendingItems.push({
        id: makeId("pending"),
        type: "ai_processing_failed",
        relatedPhotoIds: [photo.id],
        relatedTripId: photo.tripId,
        suggestion: `${photo.title ?? photo.fileName} 初次导入 ${failedParts || "AI"} 处理失败，需要选择处理方式。`,
        reason: `${gpsLabel}。${[
          photo.aiFailure?.vision ? `AI Vision：${photo.aiFailure.vision}` : undefined,
          photo.aiFailure?.embedding ? `Embedding：${photo.aiFailure.embedding}` : undefined,
        ]
          .filter(Boolean)
          .join("；")}`,
        status: "open",
        proposal: {
          action: "resolve_ai_processing_failed",
          photoIds: [photo.id],
        },
      });
    }
  }

  function hasMissingImportInfo(photo) {
    return photo.pendingReason === "missing_gps" || photo.pendingReason === "missing_time" || photo.exifStatus?.gps === "missing" || photo.exifStatus?.time !== "read";
  }

  async function buildMissingInfoInferenceProposal(state, batch, pending, { locale = "zh" } = {}) {
    const photo = state.photos.find((item) => item.id === pending.relatedPhotoIds[0]);
    if (!photo) return keepPending(missingInferenceText(locale, "photoNotFound"), 0.2, locale);
    const context = buildInferenceContextPhotos(state, batch, photo);
    const contextPlaces = allowedInferencePlaces(state, context);
    const imagePayload = await readPhotoImagePayload(photo);
    if (!imagePayload) return keepPending(missingInferenceText(locale, "imageMissing"), 0, locale);
    const inferenceInput = buildMissingInfoInferenceInput({ photo, context, contextPlaces, locale });
    const aiResult = await inferMissingInfoWithImage({
      rootDir: paths.rootDir,
      secretProvider,
      dataUrl: imagePayload.dataUrl,
      mime: imagePayload.mime,
      inferenceInput,
      allowCloud: true,
      locale,
    });
    return normalizeMissingInfoAiProposal({ aiResult, photo, context, contextPlaces, locale });
  }

  function buildInferenceContextPhotos(state, batch, photo) {
    const batchPhotoIds = new Set(batch.addedPhotoIds);
    const currentTime = new Date(photo.capturedAt).getTime();
    let previous;
    let next;
    let previousLocated;
    let nextLocated;
    for (const item of state.photos) {
      if (item.id === photo.id) continue;
      const itemTime = new Date(item.capturedAt).getTime();
      if (!Number.isFinite(currentTime) || !Number.isFinite(itemTime)) continue;
      const distance = timeDistanceMs(item.capturedAt, photo.capturedAt);
      const isSameTripOrBatch = item.tripId === photo.tripId || batchPhotoIds.has(item.id);
      if (!isSameTripOrBatch) continue;
      const located = hasReadExifGps(item);
      if (itemTime <= currentTime) {
        if (!previous || distance < previous.distance) previous = { item, distance };
        if (located && (!previousLocated || distance < previousLocated.distance)) previousLocated = { item, distance };
      } else if (!next || distance < next.distance) {
        next = { item, distance };
      }
      if (itemTime > currentTime && located) {
        if (!nextLocated || distance < nextLocated.distance) nextLocated = { item, distance };
      }
    }
    return { previousPhoto: previous?.item, nextPhoto: next?.item, previousLocatedPhoto: previousLocated?.item, nextLocatedPhoto: nextLocated?.item };
  }

  function allowedInferencePlaces(state, context) {
    const placeIds = new Set([context.previousPhoto?.placeNodeId, context.nextPhoto?.placeNodeId].filter(Boolean));
    return state.placeNodes.filter((place) => placeIds.has(place.id));
  }

  async function readPhotoImagePayload(photo) {
    if (!photo.storageUrl) return undefined;
    const fileName = path.basename(photo.storageUrl);
    const fullPath = path.join(paths.photoDir, fileName);
    const ext = path.extname(fileName).toLowerCase();
    const mime = photo.mime || (ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".heic" ? "image/heic" : "image/jpeg");
    return fs.access(fullPath).then(() => readAiImagePayloadFromFile(fullPath, mime)).catch(() => undefined);
  }

  function buildMissingInfoInferenceInput({ photo, context, contextPlaces, locale = "zh" }) {
    return {
      task: "missing_gps_second_pass",
      currentPhoto: {
        capturedAt: formatAiTimestamp(photo.capturedAt),
        initialLocationCandidate: serializeInitialLocationCandidate(photo),
      },
      neighbors: {
        previous: serializeNeighborPhoto(context.previousPhoto, contextPlaces, locale),
        next: serializeNeighborPhoto(context.nextPhoto, contextPlaces, locale),
      },
      allowedPlaces: contextPlaces.map((place) => ({
        id: place.id,
        name: localizedPlaceValue(place, "name", locale),
        city: localizedPlaceValue(place, "city", locale),
        country: localizedPlaceValue(place, "country", locale),
      })),
    };
  }

  function serializeInitialLocationCandidate(photo) {
    const candidate = bestPhotoLocationCandidate(photo);
    if (!candidate) return null;
    return {
      name: candidate.name,
      city: candidate.city,
    };
  }

  function bestPhotoLocationCandidate(photo) {
    return [...(photo.locationResolution?.candidates ?? []), ...(photo.ai?.locationCandidates ?? [])]
      .filter((candidate) => candidate?.name)
      .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0];
  }

  function serializeNeighborPhoto(photo, contextPlaces, locale = "zh") {
    if (!photo) {
      return {
        capturedAt: null,
        placeId: null,
        placeName: null,
        city: null,
        country: null,
        hasRealExifGps: false,
      };
    }
    const hasReliableGps = hasReadExifGps(photo);
    const place = photo.placeNodeId ? contextPlaces.find((item) => item.id === photo.placeNodeId) : undefined;
    const candidate = bestPhotoLocationCandidate(photo);
    return {
      capturedAt: formatAiTimestamp(photo.capturedAt),
      placeId: place?.id ?? null,
      placeName: place ? localizedPlaceValue(place, "displayName", locale) : (photo.locationResolution?.effectiveName ?? candidate?.name ?? null),
      city: place ? localizedPlaceValue(place, "city", locale) : (candidate?.city ?? null),
      country: place ? localizedPlaceValue(place, "country", locale) : (candidate?.country ?? null),
      hasRealExifGps: hasReliableGps,
    };
  }

  function localizedPlaceValue(place, field, locale = "zh") {
    if (!place) return null;
    if (normalizeLocale(locale) !== "en") {
      if (field === "displayName") return place.displayName ?? place.name ?? null;
      return place[field] ?? null;
    }
    if (field === "name" || field === "displayName") return place.names?.en ?? place.displayName ?? place.name ?? null;
    if (field === "city") return place.cityNames?.en ?? place.city ?? null;
    if (field === "country") return place.countryNames?.en ?? place.country ?? null;
    return place[field] ?? null;
  }

  function formatAiTimestamp(value) {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value).slice(0, 16).replace("T", " ");
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function normalizeMissingInfoAiProposal({ aiResult, photo, context, contextPlaces, locale = "zh" }) {
    if (aiResult.action === "bind_photos_to_place") {
      const place = contextPlaces.find((item) => item.id === aiResult.targetPlaceId);
      if (!place) return keepPending(missingInferenceText(locale, "targetNotAllowed"), aiResult.confidence ?? 0, locale);
      const closeNeighbor = closeNeighborForPlace(photo, context, place);
      if (isMissingGpsPhoto(photo) && Number(aiResult.confidence ?? 0) < missingGpsLowConfidenceThreshold && !closeNeighbor) {
        return keepPending(aiResult.reason || missingInferenceText(locale, "lowConfidence"), aiResult.confidence ?? 0, locale);
      }
      const reason = withCloseNeighborReason(aiResult.reason, closeNeighbor, locale);
      return {
        actionable: true,
        confidence: aiResult.confidence,
        displayTarget: `${missingInferenceText(locale, "mergeBadge")} ${place.displayName ?? place.name}`,
        displayTargetLabel: place.displayName ?? place.name,
        displayTargetBadge: missingInferenceText(locale, "mergeBadge"),
        suggestion: `${missingInferenceText(locale, "mergeBadge")} ${place.displayName ?? place.name}`,
        reason,
        proposal: {
          action: "bind_photos_to_place",
          photoIds: [photo.id],
          placeId: place.id,
          confidence: aiResult.confidence,
          reason,
          rewrittenInitialAnalysis: normalizedRewriteForProposal(aiResult.rewrittenInitialAnalysis),
        },
      };
    }

    if (aiResult.action === "create_place_from_candidate") {
      const candidate = completeCandidatePoint(aiResult.candidate, locale);
      if (!candidate?.name) return keepPending(candidate?.reason || missingInferenceText(locale, "invalidPlaceName"), candidate?.confidence ?? 0, locale);
      if (!candidate.point) return keepPending(candidate.reason || missingInferenceText(locale, "noGeocode"), candidate.confidence ?? 0, locale);
      const mergePlace = findMergeableContextPlace(candidate, contextPlaces);
      if (mergePlace) {
        const closeNeighbor = closeNeighborForPlace(photo, context, mergePlace);
        const strongOverlap = hasStrongGeographicOverlap(candidate, mergePlace);
        if (isMissingGpsPhoto(photo) && Number(candidate.confidence ?? 0) < missingGpsLowConfidenceThreshold && !closeNeighbor && !strongOverlap) {
          return keepPending(candidate.reason || missingInferenceText(locale, "lowConfidence"), candidate.confidence ?? 0, locale);
        }
        const placeName = mergePlace.displayName ?? mergePlace.name;
        const reason = withInferenceSupportReason(
          `${candidate.reason || missingInferenceText(locale, "clearPlace")} ${missingInferenceText(locale, "matchedExistingPlace")}: ${placeName}.`,
          { closeNeighbor, strongOverlap },
          locale,
        );
        return {
          actionable: true,
          confidence: candidate.confidence,
          displayTarget: `${missingInferenceText(locale, "mergeBadge")} ${placeName}`,
          displayTargetLabel: placeName,
          displayTargetBadge: missingInferenceText(locale, "mergeBadge"),
          suggestion: `${missingInferenceText(locale, "mergeBadge")} ${placeName}`,
          reason,
          proposal: {
            action: "bind_photos_to_place",
            photoIds: [photo.id],
            placeId: mergePlace.id,
            confidence: candidate.confidence,
            reason,
            rewrittenInitialAnalysis: normalizedRewriteForProposal(aiResult.rewrittenInitialAnalysis),
          },
        };
      }
      if (isMissingGpsPhoto(photo) && Number(candidate.confidence ?? 0) < missingGpsLowConfidenceThreshold) return keepPending(candidate.reason || missingInferenceText(locale, "lowConfidence"), candidate.confidence ?? 0, locale);
      return {
        actionable: true,
        confidence: candidate.confidence,
        displayTarget: `${missingInferenceText(locale, "newPlaceBadge")} ${candidate.name}`,
        displayTargetLabel: candidate.name,
        displayTargetBadge: missingInferenceText(locale, "newPlaceBadge"),
        suggestion: `${missingInferenceText(locale, "newPlaceBadge")} ${candidate.name}`,
        reason: candidate.reason,
        proposal: {
          action: "create_place_from_candidate",
          tripId: photo.tripId,
          photoIds: [photo.id],
          candidate: {
            ...candidate,
            source: "ai_context_inference",
            precision: "estimated",
          },
          rewrittenInitialAnalysis: normalizedRewriteForProposal(aiResult.rewrittenInitialAnalysis),
        },
      };
    }

    return keepPending(aiResult.reason || missingInferenceText(locale, "noAutoArchive"), aiResult.confidence ?? 0, locale);
  }

  function closeNeighborForPlace(photo, context, place) {
    if (!place?.id) return undefined;
    return uniquePhotos([context.previousPhoto, context.nextPhoto, context.previousLocatedPhoto, context.nextLocatedPhoto])
      .map((neighbor) => ({
        neighbor,
        distance: timeDistanceMs(neighbor.capturedAt, photo.capturedAt),
      }))
      .filter(({ neighbor, distance }) => hasReadExifGps(neighbor) && neighbor.placeNodeId === place.id && distance <= closeNeighborContextMs)
      .sort((left, right) => left.distance - right.distance)[0];
  }

  function normalizedRewriteForProposal(rewrittenInitialAnalysis) {
    if (!rewrittenInitialAnalysis?.caption || !Array.isArray(rewrittenInitialAnalysis.tags) || !rewrittenInitialAnalysis.locationCandidate) return undefined;
    const candidate = rewrittenInitialAnalysis.locationCandidate;
    return {
      title: rewrittenInitialAnalysis.title,
      tags: rewrittenInitialAnalysis.tags,
      caption: rewrittenInitialAnalysis.caption,
      locationCandidate: {
        name: candidate.name,
        country: candidate.country,
        city: candidate.city,
        confidence: candidate.confidence,
      },
    };
  }

  function hasReadExifGps(photo) {
    return photo?.exifStatus?.gps === "read" && isUsableLocation(photo.location);
  }

  function uniquePhotos(photos) {
    const seen = new Set();
    return photos.filter((photo) => {
      if (!photo || seen.has(photo.id)) return false;
      seen.add(photo.id);
      return true;
    });
  }

  function withCloseNeighborReason(reason, closeNeighbor, locale = "zh") {
    if (!closeNeighbor) return reason;
    const minutes = Math.max(1, Math.round(closeNeighbor.distance / 60000));
    const baseReason = reason || missingInferenceText(locale, "bindablePlace");
    return normalizeLocale(locale) === "en"
      ? `${baseReason} A neighboring geotagged photo is only ${minutes} minutes away and matches the target place, so the low-confidence nearby context is allowed.`
      : `${baseReason} 与相邻已定位照片仅相隔 ${minutes} 分钟，且目标地点一致，已允许低置信度近时间上下文通过。`;
  }

  function withInferenceSupportReason(reason, { closeNeighbor, strongOverlap }, locale = "zh") {
    if (strongOverlap) return reason;
    return withCloseNeighborReason(reason, closeNeighbor, locale);
  }

  function hasStrongGeographicOverlap(candidate, place) {
    if (!candidate?.point || !place?.center) return false;
    const distance = haversineKm(candidate.point, place.center);
    const candidateName = cleanPlaceName(candidate.name);
    const placeName = cleanPlaceName(place.displayName ?? place.name);
    const candidateCity = cleanPlaceName(candidate.city);
    const placeCity = cleanPlaceName(place.city);
    const candidateCountry = cleanPlaceName(candidate.country);
    const placeCountry = cleanPlaceName(place.country);
    const sameCountry = !candidateCountry || !placeCountry || candidateCountry === placeCountry;
    const sameCity = Boolean(candidateCity && placeCity && candidateCity === placeCity);
    const sameName = Boolean(candidateName && placeName && (candidateName === placeName || candidateName.includes(placeName) || placeName.includes(candidateName)));
    return sameCountry && (distance <= 1.2 || (sameCity && distance <= 5) || (sameName && distance <= 12));
  }

  function findMergeableContextPlace(candidate, contextPlaces) {
    if (!candidate?.point) return undefined;
    const candidateName = cleanPlaceName(candidate.name);
    const candidateCity = cleanPlaceName(candidate.city);
    const candidateCountry = cleanPlaceName(candidate.country);
    return contextPlaces
      .map((place) => {
        if (!place.center) return undefined;
        const distance = haversineKm(candidate.point, place.center);
        const placeName = cleanPlaceName(place.displayName ?? place.name);
        const placeCity = cleanPlaceName(place.city);
        const placeCountry = cleanPlaceName(place.country);
        const sameCountry = !candidateCountry || !placeCountry || candidateCountry === placeCountry;
        const sameCity = Boolean(candidateCity && placeCity && candidateCity === placeCity);
        const sameName = Boolean(candidateName && placeName && (candidateName === placeName || candidateName.includes(placeName) || placeName.includes(candidateName)));
        const threshold = sameName ? 25 : sameCity ? 25 : 25;
        if (!sameCountry || distance > threshold) return undefined;
        return { place, distance, sameName, sameCity };
      })
      .filter(Boolean)
      .sort((left, right) => Number(right.sameName) - Number(left.sameName) || Number(right.sameCity) - Number(left.sameCity) || left.distance - right.distance)[0]?.place;
  }

  function completeCandidatePoint(candidate, locale = "zh") {
    if (!candidate?.name) return candidate;
    const cityQuery = candidate.city || candidate.name;
    const fallback = forwardLocalGeocode(
      {
        city: cityQuery,
        country: candidate.country,
      },
      { makeId },
    )[0];
    if (!fallback?.point) return candidate;
    return {
      ...candidate,
      point: fallback.point,
      city: candidate.city ?? fallback.city ?? cityQuery,
      country: candidate.country ?? fallback.country,
      localizedNames: candidate.localizedNames ?? fallback.localizedNames,
      localizedCountryNames: candidate.localizedCountryNames ?? fallback.localizedCountryNames,
      confidence: Math.max(Number(candidate.confidence ?? 0), Math.min(0.72, Number(fallback.confidence ?? 0.6))),
      reason:
        normalizeLocale(locale) === "en"
          ? `${candidate.reason || "AI provided a clear place name."} Local gazetteer coordinates were added from ${fallback.name}.`
          : `${candidate.reason || "AI 给出了明确地点名。"} 已用本地地名库补入估计坐标：${fallback.name}。`,
      source: "geocode",
      precision: "estimated",
    };
  }

  function withBackendLocationCandidates({ location, aiEvidence, locale = "zh" }) {
    if (!aiEvidence) return aiEvidence;
    const aiCandidates = safeArray(aiEvidence.locationCandidates).map(stripCandidatePoint);
    const backendCandidates = isUsableLocation(location)
      ? reverseLocalGeocode(location, { makeId })
      : aiCandidates.map((candidate) => geocodeAiLocationCandidate(candidate, locale));
    return {
      ...aiEvidence,
      locationCandidates: mergeLocationCandidates(backendCandidates, aiCandidates),
    };
  }

  function stripCandidatePoint(candidate) {
    if (!candidate) return candidate;
    const rest = { ...candidate };
    delete rest.point;
    delete rest.lat;
    delete rest.lng;
    return rest;
  }

  function geocodeAiLocationCandidate(candidate, locale = "zh") {
    if (!candidate?.name && !candidate?.city) return candidate;
    const cityQuery = candidate.city || candidate.name;
    const fallback = forwardLocalGeocode({ city: cityQuery, country: candidate.country }, { makeId })[0];
    if (!fallback?.point) return candidate;
    return {
      ...candidate,
      point: fallback.point,
      city: candidate.city ?? fallback.city ?? cityQuery,
      country: candidate.country ?? fallback.country,
      localizedNames: candidate.localizedNames ?? fallback.localizedNames,
      localizedCountryNames: candidate.localizedCountryNames ?? fallback.localizedCountryNames,
      confidence: Math.max(Number(candidate.confidence ?? 0), Math.min(0.72, Number(fallback.confidence ?? 0.6))),
      source: "geocode",
      precision: "estimated",
      reason:
        normalizeLocale(locale) === "en"
          ? `${candidate.reason || "AI provided a place name."} Local gazetteer coordinates were added from ${fallback.name}.`
          : `${candidate.reason || "AI 给出了地点名。"} 已用本地地名库补入估计坐标：${fallback.name}。`,
    };
  }

  function isMissingGpsPhoto(photo) {
    return photo.pendingReason === "missing_gps" || photo.exifStatus?.gps === "missing" || !isUsableLocation(photo.location);
  }

  function missingInferenceText(locale, key) {
    const english = normalizeLocale(locale) === "en";
    const messages = {
      photoNotFound: english ? "The pending photo could not be found." : "找不到待补照片。",
      imageMissing: english ? "The original image for this pending photo could not be found, so context inference cannot run." : "找不到当前待补照片原图，无法执行基于上下文推断。",
      secondInferenceFailed: english ? "Context inference failed." : "基于上下文推断失败。",
      targetNotAllowed: english ? "AI suggested a target place that is not in the backend allowed-place list." : "AI 建议的目标地点不在后端允许的地点列表中。",
      lowConfidence: english ? "The inferred location confidence is too low for this pending photo." : "待补照片地点置信度不足。",
      invalidPlaceName: english ? "AI did not provide a valid place name that can be created." : "AI 未给出可创建地点的合法名称。",
      noGeocode: english ? "AI provided a place name, but the local gazetteer could not estimate usable coordinates, so manual placement is still required." : "AI 给出了地点名，但本地地名库无法估计可用坐标，仍需手动补点。",
      noAutoArchive: english ? "AI still cannot determine a reliable location for this photo." : "AI 认为当前照片仍无法可靠判断地点。",
      clearPlace: english ? "AI provided a clear place." : "AI 给出了明确地点。",
      matchedExistingPlace: english ? "It matched an existing place in the same trip" : "已匹配到同一行程中的现有地点",
      bindablePlace: english ? "AI suggested a place that can be bound to the same location." : "AI 给出了可绑定到同一地点的建议。",
      mergeBadge: english ? "Merge" : "合并",
      newPlaceBadge: english ? "New place" : "新地点",
      pendingTarget: english ? "Still pending" : "仍待确认",
      pendingLabel: english ? "Pending" : "待确认",
      keepPendingSuggestion: english ? "AI does not recommend automatic archiving yet. Manual handling is still required." : "AI 暂不建议自动归档，仍需手动处理。",
    };
    return messages[key] ?? messages.noAutoArchive;
  }

  function keepPending(reason, confidence, locale = "zh") {
    return {
      actionable: false,
      confidence,
      displayTarget: missingInferenceText(locale, "pendingTarget"),
      displayTargetLabel: missingInferenceText(locale, "pendingLabel"),
      displayTargetBadge: missingInferenceText(locale, "pendingLabel"),
      suggestion: missingInferenceText(locale, "keepPendingSuggestion"),
      reason,
      proposal: { action: "keep_pending", confidence, reason },
    };
  }

  function timeDistanceMs(left, right) {
    if (!left || !right) return Number.MAX_SAFE_INTEGER;
    return Math.abs(new Date(left).getTime() - new Date(right).getTime());
  }

  return {
    importPhotos,
    startImportJob,
    startMultipartImportJob,
    startEmbeddingRebuildJob,
    getImportJob,
    subscribeImportJob,
    importAppleTestPhotos,
    confirmImport,
    rollbackImport,
    cancelImportPhotos,
    resolveImportAiFailure,
    startAiFailureResolveJob,
    inferPendingLocation,
    startPendingInferenceJob,
    mergeImportTrips,
  };
}

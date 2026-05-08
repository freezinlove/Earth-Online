import fs from "node:fs/promises";
import path from "node:path";
import { safeArray } from "../domain/arrays.mjs";
import { toDateInput } from "../domain/dates.mjs";
import { parseExif } from "../domain/exif-parser.mjs";
import { geoContextFor, inferPreset, isUsableLocation } from "../domain/geo.mjs";
import { resolveImportedLocation, toAiEvidence } from "../domain/location-resolver.mjs";
import { buildPlacesForGroup } from "../domain/place-projector.mjs";
import { buildPhotoRoute, buildRoute } from "../domain/route-projector.mjs";
import { makePhotoTitle } from "../domain/text-normalizer.mjs";
import { dominantPresetsForPhotos, findAdjacentTrip, groupImportedPhotos } from "../domain/trip-resolver.mjs";
import { dataUrlToBuffer, extFromName, hashBuffer } from "../storage/file-storage.mjs";

export function createImportServices({
  analyzeTravelImage,
  importJobs,
  makeId,
  paths,
  readState,
  readVectorIndex,
  repository,
  responseState,
  writeState,
  writeVectorIndex,
}) {
  async function makeImportFilePayloadFromLocalFile(fullPath) {
    const buffer = await fs.readFile(fullPath);
    return {
      name: path.basename(fullPath),
      type: "image/jpeg",
      size: buffer.length,
      lastModified: (await fs.stat(fullPath)).mtimeMs,
      buffer,
    };
  }

  async function importPhotos(payload) {
    const state = await readState();
    const vectorIndex = await readVectorIndex();
    const now = new Date();
    const files = safeArray(payload.files).slice(0, 1000);
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
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const parsed = file.buffer ? { mime: file.type || "image/jpeg", buffer: file.buffer } : dataUrlToBuffer(file.dataUrl);
      const { mime, buffer } = parsed;
      const ext = extFromName(file.name, mime);
      const originalHash = hashBuffer(buffer);
      if (knownHashes.has(originalHash)) {
        duplicateNames.push(file.name || `duplicate-${index + 1}`);
        if (payload.reanalyzeDuplicates) {
          const existingPhoto = knownHashToPhoto.get(originalHash);
          if (existingPhoto) {
            const exif = parseExif(buffer);
            const parsedLocation = isUsableLocation(exif.location) ? exif.location : existingPhoto.location;
            const preset = inferPreset(file.name, parsedLocation);
            const dataUrl = file.dataUrl ?? `data:${mime};base64,${buffer.toString("base64")}`;
            const ai = await analyzePhoto({ fileName: file.name, mime, dataUrl, preset, location: parsedLocation, allowCloud: payload.allowCloudAi !== false });
            recordAiStats(ai, aiStats);
            const aiEvidence = toAiEvidence(ai, { makeId });
            const resolvedLocation = existingPhoto.location ?? parsedLocation;
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
            existingPhoto.embeddingProvider = ai.embeddingProvider;
            existingPhoto.embeddingDimension = ai.embeddingDimension ?? ai.embedding?.length;
            existingPhoto.aiFallbackReason = ai.fallbackReason;
            if (parsedLocation && !existingPhoto.location) existingPhoto.location = parsedLocation;
            vectorIndex[existingPhoto.id] = ai.embedding;
          }
        }
        continue;
      }
      knownHashes.add(originalHash);
      const photoId = makeId("photo");
      const storageName = `${photoId}${ext}`;
      const thumbName = `${photoId}.jpg`;
      const storagePath = path.join(paths.photoDir, storageName);
      const thumbPath = path.join(paths.thumbDir, thumbName);
      await fs.writeFile(storagePath, buffer);
      const thumbnailSource = file.thumbnailDataUrl ? dataUrlToBuffer(file.thumbnailDataUrl).buffer : buffer;
      await fs.writeFile(thumbPath, thumbnailSource);
      const exif = parseExif(buffer);
      const parsedLocation = isUsableLocation(exif.location) ? exif.location : undefined;
      const preset = inferPreset(file.name, parsedLocation);
      const capturedAt =
        exif.capturedAt ??
        (file.lastModified ? new Date(file.lastModified).toISOString() : new Date(now.getTime() - (files.length - index) * 86400000).toISOString());
      const hasExifLocation = Boolean(parsedLocation);
      const location = parsedLocation;
      const dataUrl = file.dataUrl ?? `data:${mime};base64,${buffer.toString("base64")}`;
      const ai = await analyzePhoto({ fileName: file.name, mime, dataUrl, preset, location, allowCloud: payload.allowCloudAi !== false });
      recordAiStats(ai, aiStats);
      const aiEvidence = toAiEvidence(ai, { makeId });
      const pendingReason = !location ? "missing_gps" : !capturedAt ? "missing_time" : undefined;
      const photo = {
        id: photoId,
        fileName: file.name || storageName,
        title: ai.title || makePhotoTitle({ fileName: file.name || storageName, tags: ai.tags, aiCaption: ai.caption }),
        originalHash,
        mime,
        thumbnailUrl: `/data/thumbs/${thumbName}`,
        storageUrl: `/data/photos/${storageName}`,
        capturedAt,
        location,
        tags: ai.tags,
        aiCaption: ai.caption,
        ai: aiEvidence,
        locationResolution: resolveImportedLocation({ location, aiEvidence, pendingReason }),
        aiProvider: ai.provider,
        embeddingProvider: ai.embeddingProvider,
        embeddingDimension: ai.embeddingDimension ?? ai.embedding?.length,
        aiFallbackReason: ai.fallbackReason,
        importedBatchId: batchId,
        pendingReason,
        exifStatus: {
          time: exif.capturedAt ? "read" : "fallback",
          gps: hasExifLocation ? "read" : "missing",
        },
      };
      vectorIndex[photo.id] = ai.embedding;
      imported.push(photo);
    }

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
      const title = `${start.slice(0, 7)} ${preset.city}旅行${groups.length > 1 ? ` ${groupIndex + 1}` : ""}`;
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
      const tripLocatedAfter = tripPhotosAfter.filter((photo) => photo.location);
      if (tripLocatedAfter.length) {
        const places = buildPlacesForGroup(tripPhotosAfter, tripId, { makeId });
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
              title: adjacentTrip ? `${toDateInput(tripDates[0]).slice(0, 7)} ${geoSummary.cities.length > 1 ? "欧洲多城" : geoSummary.cities[0]}旅行` : item.title,
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

    const missing = imported.filter((photo) => photo.pendingReason);
    if (missing.length) {
      pendingItems.push({
        id: makeId("pending"),
        type: "missing_gps",
        relatedPhotoIds: missing.map((photo) => photo.id),
        relatedTripId: missing[0].tripId,
        suggestion: `${missing.length} 张照片缺少 GPS，需要手动标点或绑定到地点节点。`,
        reason: "EXIF 未读取到可靠坐标，系统不会静默推断确定地点。",
        status: "open",
      });
    }
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
      successCount: imported.length - missing.length,
      failedCount: missing.length,
      duplicateCount: duplicateNames.length,
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
          ? `新增 ${imported.length} 张照片，跳过 ${duplicateNames.length} 张重复照片，创建 ${createdTrips.length} 个待确认旅行档案，${missing.length} 张需要补充时间或地点。`
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
    return responseState();
  }

  function startImportJob(payload) {
    const id = makeId("job");
    const job = {
      id,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      try {
        current.result = await importPhotos(payload);
        current.status = "completed";
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "import job failed";
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
    }, 0);
    return job;
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
        files.push(await makeImportFilePayloadFromLocalFile(path.join(appleDir, entry.name)));
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
    await writeState({
      ...state,
      trips: state.trips.map((trip) => (batch.createdTripIds.includes(trip.id) ? { ...trip, status: "confirmed" } : trip)),
      importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "confirmed" } : item)),
    });
    return responseState();
  }

  async function rollbackImport(id) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === id);
    const latestPending = state.importBatches.filter((item) => item.status === "pending_confirmation").at(-1);
    if (!batch || batch.id !== latestPending?.id) throw new Error("MVP 只支持回撤最近一次待确认导入。");
    const photoIds = new Set(batch.addedPhotoIds);
    const tripIds = new Set(batch.createdTripIds);
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
    await writeState({
      ...state,
      photos: state.photos.filter((photo) => !photoIds.has(photo.id)),
      trips: state.trips.filter((trip) => !tripIds.has(trip.id)),
      placeNodes: state.placeNodes.filter((place) => !tripIds.has(place.tripId)),
      routes: state.routes.filter((route) => !tripIds.has(route.tripId)),
      pendingItems: state.pendingItems.filter((item) => !pendingIds.has(item.id)),
      importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "rolled_back" } : item)),
    });
    return responseState();
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

  async function analyzePhoto({ fileName, mime, dataUrl, preset, location, allowCloud }) {
    return analyzeTravelImage({
      rootDir: paths.rootDir,
      fileName,
      mime,
      dataUrl,
      preset,
      geoContext: geoContextFor(preset, location),
      allowCloud,
    });
  }

  function recordAiStats(ai, aiStats) {
    if (ai.provider === "qwen") aiStats.qwenCount += 1;
    else aiStats.fallbackCount += 1;
    if (Array.isArray(ai.embedding) && ai.embedding.length > 0) aiStats.embeddingCount += 1;
    if (ai.embeddingProvider === "qwen") aiStats.qwenEmbeddingCount += 1;
    else aiStats.deterministicEmbeddingCount += 1;
  }

  function addLocationPendingItems(imported, pendingItems) {
    const suggestedLocations = imported.filter((photo) => photo.locationResolution?.status === "suggested" && photo.locationResolution.candidateId);
    for (const photo of suggestedLocations) {
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
          candidate: photo.locationResolution.candidates.find((candidate) => candidate.id === photo.locationResolution.candidateId),
        },
      });
    }
  }

  return {
    importPhotos,
    startImportJob,
    getImportJob,
    importAppleTestPhotos,
    confirmImport,
    rollbackImport,
    mergeImportTrips,
  };
}

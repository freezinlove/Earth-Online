import { readBody } from "./body.mjs";
import { corsHeaders, send, sendError } from "./responses.mjs";

export function createRouter(handlers, paths) {
  return async function route(req, res) {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const pathname = url.pathname;
      if (pathname.startsWith("/data/photos/") || pathname.startsWith("/data/thumbs/")) {
        return handlers.servePhoto(res, pathname, { photoDir: paths.photoDir, thumbDir: paths.thumbDir });
      }
      if (req.method === "GET" && pathname === "/api/health/capabilities") return send(res, 200, { embeddingRebuildJobs: true });
      if (req.method === "GET" && pathname === "/api/state") return send(res, 200, await handlers.responseState());
      if (req.method === "GET" && pathname === "/api/settings/local-ai") return send(res, 200, handlers.localAiSettings());
      if (req.method === "PATCH" && pathname === "/api/settings/local-ai") return send(res, 200, handlers.updateLocalAiSettings(await readBody(req)));
      if (req.method === "GET" && pathname === "/api/settings/ai") return send(res, 200, handlers.aiSettings());
      if (req.method === "PATCH" && pathname === "/api/settings/ai") return send(res, 200, handlers.updateAiSettings(await readBody(req)));
      if (req.method === "GET" && pathname === "/api/geocode/reverse") return send(res, 200, handlers.reverseGeocode(url.searchParams));
      if (req.method === "GET" && pathname === "/api/search") return send(res, 200, await handlers.search(url.searchParams));
      if (req.method === "POST" && pathname === "/api/import/jobs") {
        const contentType = req.headers["content-type"] ?? "";
        if (String(contentType).includes("multipart/form-data")) return send(res, 202, await handlers.startMultipartImportJob(req));
        return send(res, 202, await handlers.startImportJob(await readBody(req)));
      }
      const importJobEvents = pathname.match(/^\/api\/import\/jobs\/([^/]+)\/events$/);
      if (req.method === "GET" && importJobEvents) {
        return handlers.subscribeImportJob(importJobEvents[1], req, res) ? undefined : sendError(res, 404, "Import job not found");
      }
      const importJob = pathname.match(/^\/api\/import\/jobs\/([^/]+)$/);
      if (req.method === "GET" && importJob) {
        const job = handlers.getImportJob(importJob[1]);
        return job ? send(res, 200, job) : sendError(res, 404, "Import job not found");
      }
      if (req.method === "POST" && pathname === "/api/photos/embeddings/rebuild/jobs") return send(res, 202, await handlers.startEmbeddingRebuildJob(await readBody(req)));
      if (req.method === "POST" && pathname === "/api/import/apple-test") return send(res, 200, await handlers.importAppleTestPhotos(await readBody(req)));
      const importConfirm = pathname.match(/^\/api\/import\/([^/]+)\/confirm$/);
      if (req.method === "POST" && importConfirm) return send(res, 200, await handlers.confirmImport(importConfirm[1]));
      const importRollback = pathname.match(/^\/api\/import\/([^/]+)\/rollback$/);
      if (req.method === "POST" && importRollback) return send(res, 200, await handlers.rollbackImport(importRollback[1]));
      const importCancelPhotos = pathname.match(/^\/api\/import\/([^/]+)\/cancel-photos$/);
      if (req.method === "POST" && importCancelPhotos) return send(res, 200, await handlers.cancelImportPhotos(importCancelPhotos[1], await readBody(req)));
      const importPendingInferJob = pathname.match(/^\/api\/import\/([^/]+)\/pending\/infer-locations\/jobs$/);
      if (req.method === "POST" && importPendingInferJob) return send(res, 202, await handlers.startPendingInferenceJob(importPendingInferJob[1], await readBody(req)));
      const importPendingInfer = pathname.match(/^\/api\/import\/([^/]+)\/pending\/([^/]+)\/infer-location$/);
      if (req.method === "POST" && importPendingInfer) return send(res, 200, await handlers.inferPendingLocation(importPendingInfer[1], importPendingInfer[2], await readBody(req)));
      const importAiFailure = pathname.match(/^\/api\/import\/([^/]+)\/ai-failures\/([^/]+)\/resolve$/);
      if (req.method === "POST" && importAiFailure) return send(res, 200, await handlers.resolveImportAiFailure(importAiFailure[1], importAiFailure[2], await readBody(req)));
      const importAiFailureJob = pathname.match(/^\/api\/import\/([^/]+)\/ai-failures\/resolve\/jobs$/);
      if (req.method === "POST" && importAiFailureJob) return send(res, 202, await handlers.startAiFailureResolveJob(importAiFailureJob[1], await readBody(req)));
      const importMerge = pathname.match(/^\/api\/import\/([^/]+)\/merge$/);
      if (req.method === "POST" && importMerge) return send(res, 200, await handlers.mergeImportTrips(importMerge[1]));
      if (req.method === "POST" && pathname === "/api/trips") return send(res, 200, await handlers.createTrip(await readBody(req)));
      const tripDelete = pathname.match(/^\/api\/trips\/([^/]+)\/delete$/);
      if (req.method === "POST" && tripDelete) return send(res, 200, await handlers.deleteTrip(tripDelete[1]));
      const tripPatch = pathname.match(/^\/api\/trips\/([^/]+)$/);
      if (req.method === "PATCH" && tripPatch) return send(res, 200, await handlers.patchTrip(tripPatch[1], await readBody(req)));
      if (req.method === "POST" && pathname === "/api/places") return send(res, 200, await handlers.createPlace(await readBody(req)));
      const placeDelete = pathname.match(/^\/api\/places\/([^/]+)\/delete$/);
      if (req.method === "POST" && placeDelete) return send(res, 200, await handlers.deletePlace(placeDelete[1]));
      const placeReorder = pathname.match(/^\/api\/trips\/([^/]+)\/reorder-places$/);
      if (req.method === "POST" && placeReorder) return send(res, 200, await handlers.reorderPlaces(placeReorder[1], await readBody(req)));
      const photoMove = pathname.match(/^\/api\/photos\/([^/]+)\/move$/);
      if (req.method === "POST" && photoMove) return send(res, 200, await handlers.movePhoto(photoMove[1], await readBody(req)));
      const photoDelete = pathname.match(/^\/api\/photos\/([^/]+)\/delete$/);
      if (req.method === "POST" && photoDelete) return send(res, 200, await handlers.deletePhoto(photoDelete[1]));
      const photoPatch = pathname.match(/^\/api\/photos\/([^/]+)$/);
      if (req.method === "PATCH" && photoPatch) return send(res, 200, await handlers.patchPhoto(photoPatch[1], await readBody(req)));
      const photoBind = pathname.match(/^\/api\/photos\/([^/]+)\/bind-place$/);
      if (req.method === "POST" && photoBind) return send(res, 200, await handlers.bindPhoto(photoBind[1], await readBody(req)));
      const pendingPatch = pathname.match(/^\/api\/pending\/([^/]+)$/);
      if (req.method === "POST" && pendingPatch) return send(res, 200, await handlers.updatePending(pendingPatch[1], await readBody(req)));
      const pendingManual = pathname.match(/^\/api\/pending\/([^/]+)\/manual$/);
      if (req.method === "POST" && pendingManual) return send(res, 200, await handlers.resolvePendingManually(pendingManual[1], await readBody(req)));
      const pendingApply = pathname.match(/^\/api\/pending\/([^/]+)\/apply$/);
      if (req.method === "POST" && pendingApply) return send(res, 200, await handlers.updatePending(pendingApply[1], await readBody(req)));
      const photoLocationConfirm = pathname.match(/^\/api\/photos\/([^/]+)\/location\/confirm$/);
      if (req.method === "POST" && photoLocationConfirm) return send(res, 200, await handlers.confirmPhotoLocation(photoLocationConfirm[1], await readBody(req)));
      const photoLocationReject = pathname.match(/^\/api\/photos\/([^/]+)\/location\/reject$/);
      if (req.method === "POST" && photoLocationReject) return send(res, 200, await handlers.rejectPhotoLocation(photoLocationReject[1], await readBody(req)));
      const tripProjectionMatch = pathname.match(/^\/api\/trips\/([^/]+)\/projection$/);
      if (req.method === "GET" && tripProjectionMatch) return send(res, 200, await handlers.tripProjection(tripProjectionMatch[1]));
      if (req.method === "GET" && (await handlers.serveStatic(req, res, pathname, { distDir: paths.distDir }))) return;
      sendError(res, 404, "Not found");
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : "Server error");
    }
  };
}

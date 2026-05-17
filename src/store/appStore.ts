import { create } from "zustand";
import { capturedDateLabel } from "@/domain/datetime";
import type { DossierTripGroup, GlobeMarker, ID, ImportBatch, PendingItem, Photo, PlaceNode, Route, SearchDocument, SearchResult, TimelineSegment, Trip } from "@/domain/models";
import type { AppSnapshot, ImportJobProgress } from "@/services/apiClient";
import { platformApi } from "@/platform";
import type { NativePhotoAsset } from "@/platform/nativePhotoLibrary";

export type AppPanel = "globe" | "archive" | "tripDetail" | "search" | "settings" | "upload";
export type TimelineZoom = "global" | "trip" | "day";
export type Locale = "zh" | "en";
export type GlobeViewIntent =
  | { source: "timeline-trip"; point: { lat: number; lng: number }; distance: "mid" }
  | { source: "timeline-trip-entry"; point: { lat: number; lng: number }; distance: "mid" }
  | { source: "timeline-place"; point: { lat: number; lng: number }; distance: "near" }
  | { source: "timeline-global" }
  | { source: "manual" };

export type ManualPlacePickSession = {
  pendingId: ID;
  name: string;
  mode: "bind" | "new" | "archive";
  returnPanel?: AppPanel;
  point?: { lat: number; lng: number };
  nearestLabel?: string;
  nameDirty?: boolean;
  isPicking: boolean;
};

function toDateInput(date?: string) {
  return date ? capturedDateLabel(date) : new Date().toISOString().slice(0, 10);
}

function applySnapshot(snapshot: AppSnapshot) {
  return {
    trips: snapshot.trips,
    photos: snapshot.photos,
    placeNodes: snapshot.placeNodes,
    routes: snapshot.routes,
    importBatches: snapshot.importBatches,
    pendingItems: snapshot.pendingItems,
    timelineSegments: snapshot.timelineSegments,
    globeMarkers: snapshot.globeMarkers ?? [],
    dossierGroups: snapshot.dossierGroups ?? [],
    searchDocuments: snapshot.searchDocuments ?? [],
  };
}

function initialLocale(): Locale {
  if (typeof window === "undefined") return "zh";
  return window.localStorage.getItem("earth-online-locale") === "en" ? "en" : "zh";
}

function geocodeLabel(candidate: { name?: string; localizedNames?: { zh?: string; en?: string; local?: string } } | undefined, locale: Locale) {
  if (!candidate) return undefined;
  return locale === "en"
    ? candidate.localizedNames?.en ?? candidate.localizedNames?.local ?? candidate.localizedNames?.zh ?? candidate.name
    : candidate.localizedNames?.zh ?? candidate.name ?? candidate.localizedNames?.local ?? candidate.localizedNames?.en;
}

async function rollbackLatestPendingImportIfNeeded(getState: () => AppState, setState: (partial: Partial<AppState>) => void) {
  const batches = getState().importBatches;
  const latest = batches[batches.length - 1];
  if (!latest || latest.status !== "pending_confirmation") return;
  const snapshot = await platformApi.rollbackImport(latest.id);
  setState({
    ...applySnapshot(snapshot),
    selectedTripId: snapshot.trips[0]?.id ?? "",
    selectedPlaceId: undefined,
    selectedPhotoId: undefined,
  });
}

interface AppState {
  locale: Locale;
  activePanel: AppPanel;
  selectedTripId: ID;
  selectedPlaceId?: ID;
  selectedPhotoId?: ID;
  cursorDate: string;
  timelineZoom: TimelineZoom;
  globeViewIntent: GlobeViewIntent;
  searchQuery: string;
  searchFilters: { tripId?: string; placeId?: string; date?: string; tag?: string; fileName?: string };
  searchResults: SearchResult[];
  manualPlacePick?: ManualPlacePickSession;
  aiProvider: string;
  aiCloudEnabled: boolean;
  isLoading: boolean;
  isImporting: boolean;
  importProgress?: ImportJobProgress;
  error?: string;
  trips: Trip[];
  photos: Photo[];
  placeNodes: PlaceNode[];
  routes: Route[];
  importBatches: ImportBatch[];
  pendingItems: PendingItem[];
  timelineSegments: TimelineSegment[];
  globeMarkers: GlobeMarker[];
  dossierGroups: DossierTripGroup[];
  searchDocuments: SearchDocument[];
  loadState: () => Promise<void>;
  setActivePanel: (panel: AppPanel) => void;
  setLocale: (locale: Locale) => void;
  selectTrip: (tripId: ID, panel?: AppPanel) => void;
  selectPlace: (placeId: ID) => void;
  focusPlaceOnGlobe: (placeId: ID, intent: GlobeViewIntent) => void;
  selectPhoto: (photoId: ID) => void;
  clearPlaceSelection: () => void;
  setCursorDate: (date: string) => void;
  setTimelineZoom: (zoom: TimelineZoom) => void;
  setGlobeViewIntent: (intent: GlobeViewIntent) => void;
  setSearchQuery: (query: string) => void;
  setSearchFilters: (filters: AppState["searchFilters"]) => void;
  runSearch: (query?: string) => Promise<void>;
  setAiCloudEnabled: (enabled: boolean) => void;
  importFiles: (files: FileList | File[]) => Promise<void>;
  importMobilePhotoAssets: (assets: NativePhotoAsset[]) => Promise<void>;
  importAppleTestPhotos: () => Promise<void>;
  confirmLatestImport: () => Promise<void>;
  rollbackLatestImport: () => Promise<void>;
  cancelPendingImportPhotos: (photoIds: ID[]) => Promise<void>;
  inferPendingLocation: (pendingId: ID) => Promise<void>;
  inferPendingLocations: (pendingIds: ID[], onProgress?: (progress: ImportJobProgress) => void) => Promise<void>;
  resolveImportAiFailure: (pendingId: ID, action: "retry_vision" | "retry_embedding" | "retry_both" | "archive_exif") => Promise<void>;
  resolveImportAiFailures: (pendingIds: ID[], action: "retry_vision" | "retry_embedding" | "retry_both" | "archive_exif", onProgress?: (progress: ImportJobProgress) => void) => Promise<void>;
  mergeLatestImportTrips: () => Promise<void>;
  deleteTrip: (tripId: ID) => Promise<void>;
  updateTripTitle: (tripId: ID, title: string) => Promise<void>;
  updatePlaceName: (placeId: ID, name: string) => Promise<void>;
  updatePhotoUserEdits: (photoId: ID, edits: { title?: string; caption?: string; tags?: string[] }) => Promise<void>;
  bindPhotoToPlace: (photoId: ID, placeId: ID, activePanel?: AppPanel) => Promise<void>;
  createPlaceForPhoto: (photoId: ID, body: { name: string; lat: number; lng: number }, activePanel?: AppPanel) => Promise<void>;
  deletePhoto: (photoId: ID) => Promise<void>;
  acknowledgePendingItem: (pendingId: ID, accepted: boolean) => Promise<void>;
  resolvePendingManually: (
    pendingId: ID,
    body: { action: "bind_existing_place"; placeId: string } | { action: "create_manual_place"; name: string; lat: number; lng: number } | { action: "archive_unlocated" },
  ) => Promise<void>;
  openManualPlacePick: (pendingId: ID, name: string, returnPanel?: AppPanel) => void;
  closeManualPlacePick: () => void;
  startManualPlacePick: (pendingId: ID, name: string, nameDirty?: boolean, returnPanel?: AppPanel) => void;
  finishManualPlacePick: (point: { lat: number; lng: number }, nearestLabel?: string) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  locale: initialLocale(),
  activePanel: "globe",
  selectedTripId: "",
  cursorDate: new Date().toISOString().slice(0, 10),
  timelineZoom: "global",
  globeViewIntent: { source: "manual" },
  searchQuery: "",
  searchFilters: {},
  searchResults: [],
  manualPlacePick: undefined,
  aiProvider: "qwen",
  aiCloudEnabled: true,
  isLoading: false,
  isImporting: false,
  importProgress: undefined,
  trips: [],
  photos: [],
  placeNodes: [],
  routes: [],
  importBatches: [],
  pendingItems: [],
  timelineSegments: [],
  globeMarkers: [],
  dossierGroups: [],
  searchDocuments: [],
  loadState: async () => {
    set({ isLoading: true, error: undefined });
    try {
      const snapshot = await platformApi.getState();
      const selectedTripExists = snapshot.trips.some((trip) => trip.id === get().selectedTripId);
      const nextSelectedTripId = selectedTripExists ? get().selectedTripId : snapshot.trips[0]?.id ?? "";
      set((state) => ({
        ...applySnapshot(snapshot),
        selectedTripId: nextSelectedTripId,
        cursorDate: selectedTripExists ? state.cursorDate : snapshot.trips[0]?.dateRange.start || new Date().toISOString().slice(0, 10),
        isLoading: false,
      }));
    } catch (error) {
      set({ isLoading: false, error: error instanceof Error ? error.message : "加载本地后端失败" });
    }
  },
  setActivePanel: (panel) => set({ activePanel: panel }),
  setLocale: (locale) => {
    if (typeof window !== "undefined") window.localStorage.setItem("earth-online-locale", locale);
    set({ locale });
  },
  selectTrip: (tripId, panel = "globe") => {
    const trip = get().trips.find((item) => item.id === tripId);
    set({
      selectedTripId: tripId,
      selectedPlaceId: undefined,
      selectedPhotoId: undefined,
      cursorDate: trip?.dateRange.start ?? get().cursorDate,
      timelineZoom: "trip",
      activePanel: panel,
    });
  },
  selectPlace: (placeId) => {
    const place = get().placeNodes.find((item) => item.id === placeId);
    set({
      selectedPlaceId: placeId,
      selectedTripId: place?.tripId ?? get().selectedTripId,
      cursorDate: place?.timeRange.start.slice(0, 10) ?? get().cursorDate,
      timelineZoom: "day",
      activePanel: "globe",
    });
  },
  focusPlaceOnGlobe: (placeId, intent) => {
    const place = get().placeNodes.find((item) => item.id === placeId);
    set({
      selectedPlaceId: placeId,
      selectedTripId: place?.tripId ?? get().selectedTripId,
      selectedPhotoId: undefined,
      cursorDate: place?.timeRange.start.slice(0, 10) ?? get().cursorDate,
      timelineZoom: "day",
      activePanel: "globe",
      globeViewIntent: intent,
    });
  },
  selectPhoto: (photoId) => {
    const photo = get().photos.find((item) => item.id === photoId);
    set({
      selectedPhotoId: photoId,
      selectedTripId: photo?.tripId ?? get().selectedTripId,
      selectedPlaceId: photo?.placeNodeId,
      cursorDate: toDateInput(photo?.capturedAt),
      timelineZoom: photo?.placeNodeId ? "day" : photo?.tripId ? "trip" : get().timelineZoom,
      activePanel: "globe",
    });
  },
  clearPlaceSelection: () => set({ selectedPlaceId: undefined, selectedPhotoId: undefined }),
  setCursorDate: (date) => set({ cursorDate: date }),
  setTimelineZoom: (zoom) => set({ timelineZoom: zoom }),
  setGlobeViewIntent: (intent) => set({ globeViewIntent: intent }),
  setSearchQuery: (query) => {
    set({ searchQuery: query });
    void get().runSearch(query);
  },
  setSearchFilters: (filters) => {
    set({ searchFilters: filters });
    void get().runSearch();
  },
  runSearch: async (query = get().searchQuery) => {
    try {
      const { results } = await platformApi.search(query, get().searchFilters);
      set({ searchResults: results, error: undefined });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "搜索失败" });
    }
  },
  setAiCloudEnabled: (enabled) => set({ aiCloudEnabled: enabled }),
  importFiles: async (filesLike) => {
    const files = Array.from(filesLike);
    if (files.length === 0) return;
    set({
      isImporting: true,
      importProgress: { done: 0, total: files.length, phase: "reading", steps: { reading: { done: 0, total: files.length } } },
      error: undefined,
    });
    try {
      await rollbackLatestPendingImportIfNeeded(get, set);
      const snapshot = await platformApi.importFiles(files, get().aiCloudEnabled, get().locale, (done, total) => {
        set({ importProgress: { done, total, phase: "reading", steps: { reading: { done, total } } } });
      }, (progress) => {
        set({ importProgress: progress });
      });
      const latest = snapshot.importBatches[snapshot.importBatches.length - 1];
      set({
        ...applySnapshot(snapshot),
        isImporting: false,
        importProgress: undefined,
        selectedTripId: latest?.createdTripIds[0] ?? snapshot.trips[0]?.id ?? "",
        cursorDate: snapshot.trips.find((trip) => trip.id === latest?.createdTripIds[0])?.dateRange.start ?? get().cursorDate,
        activePanel: "upload",
      });
    } catch (error) {
      set({ isImporting: false, importProgress: undefined, error: error instanceof Error ? error.message : "导入失败" });
    }
  },
  importMobilePhotoAssets: async (assets) => {
    if (assets.length === 0) return;
    const importMobilePhotoAssets = platformApi.importMobilePhotoAssets;
    if (!importMobilePhotoAssets) {
      set({ error: "当前平台不支持系统相册导入" });
      return;
    }
    set({
      isImporting: true,
      importProgress: { done: 0, total: assets.length, phase: "reading", steps: { reading: { done: 0, total: assets.length } } },
      error: undefined,
    });
    try {
      await rollbackLatestPendingImportIfNeeded(get, set);
      const snapshot = await importMobilePhotoAssets(assets, get().aiCloudEnabled, get().locale, (done, total) => {
        set({ importProgress: { done, total, phase: "reading", steps: { reading: { done, total } } } });
      }, (progress) => {
        set({ importProgress: progress });
      });
      const latest = snapshot.importBatches[snapshot.importBatches.length - 1];
      set({
        ...applySnapshot(snapshot),
        isImporting: false,
        importProgress: undefined,
        selectedTripId: latest?.createdTripIds[0] ?? snapshot.trips[0]?.id ?? "",
        cursorDate: snapshot.trips.find((trip) => trip.id === latest?.createdTripIds[0])?.dateRange.start ?? get().cursorDate,
        activePanel: "upload",
      });
    } catch (error) {
      set({ isImporting: false, importProgress: undefined, error: error instanceof Error ? error.message : "导入系统相册失败" });
    }
  },
  importAppleTestPhotos: async () => {
    set({ isImporting: true, importProgress: { done: 0, total: 149, phase: "ai", steps: { ai: { done: 0, total: 149 } } }, error: undefined });
    try {
      await rollbackLatestPendingImportIfNeeded(get, set);
      const snapshot = await platformApi.importAppleTestPhotos(get().aiCloudEnabled);
      const latest = snapshot.importBatches[snapshot.importBatches.length - 1];
      set({
        ...applySnapshot(snapshot),
        isImporting: false,
        importProgress: undefined,
        selectedTripId: latest?.createdTripIds[0] ?? snapshot.trips[0]?.id ?? "",
        cursorDate: snapshot.trips.find((trip) => trip.id === latest?.createdTripIds[0])?.dateRange.start ?? get().cursorDate,
        activePanel: "upload",
      });
    } catch (error) {
      set({ isImporting: false, importProgress: undefined, error: error instanceof Error ? error.message : "导入 Apple 测试照片失败" });
    }
  },
  confirmLatestImport: async () => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation") return;
    const snapshot = await platformApi.confirmImport(latest.id);
    set({ ...applySnapshot(snapshot), activePanel: "globe" });
  },
  rollbackLatestImport: async () => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation") return;
    const snapshot = await platformApi.rollbackImport(latest.id);
    set({ ...applySnapshot(snapshot), selectedTripId: snapshot.trips[0]?.id ?? "", activePanel: "globe" });
  },
  cancelPendingImportPhotos: async (photoIds) => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation" || photoIds.length === 0) return;
    const snapshot = await platformApi.cancelImportPhotos(latest.id, photoIds);
    const nextLatest = snapshot.importBatches[snapshot.importBatches.length - 1];
    set({
      ...applySnapshot(snapshot),
      selectedTripId: nextLatest?.createdTripIds[0] ?? nextLatest?.updatedTripIds?.[0] ?? snapshot.trips[0]?.id ?? "",
      selectedPhotoId: undefined,
      activePanel: "upload",
    });
  },
  inferPendingLocation: async (pendingId) => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation") return;
    const snapshot = await platformApi.inferPendingLocation(latest.id, pendingId, get().locale);
    set({ ...applySnapshot(snapshot), activePanel: "upload" });
  },
  inferPendingLocations: async (pendingIds, onProgress) => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation" || pendingIds.length === 0) return;
    const snapshot = await platformApi.inferPendingLocations(latest.id, pendingIds, get().locale, onProgress);
    set({ ...applySnapshot(snapshot), activePanel: "upload" });
  },
  resolveImportAiFailure: async (pendingId, action) => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation") return;
    const snapshot = await platformApi.resolveImportAiFailure(latest.id, pendingId, action, get().locale);
    set({ ...applySnapshot(snapshot), activePanel: "upload" });
  },
  resolveImportAiFailures: async (pendingIds, action, onProgress) => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation" || pendingIds.length === 0) return;
    const snapshot = await platformApi.resolveImportAiFailures(latest.id, pendingIds, action, get().locale, onProgress);
    set({ ...applySnapshot(snapshot), activePanel: "upload" });
  },
  mergeLatestImportTrips: async () => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation") return;
    const snapshot = await platformApi.mergeImportTrips(latest.id);
    set({ ...applySnapshot(snapshot), selectedTripId: latest.createdTripIds[0] ?? get().selectedTripId, activePanel: "upload" });
  },
  deleteTrip: async (tripId) => {
    const snapshot = await platformApi.deleteTrip(tripId);
    const nextSelectedTripId = snapshot.trips.some((trip) => trip.id === get().selectedTripId) ? get().selectedTripId : (snapshot.trips[0]?.id ?? "");
    set({
      ...applySnapshot(snapshot),
      selectedTripId: nextSelectedTripId,
      selectedPlaceId: undefined,
      selectedPhotoId: undefined,
      cursorDate: snapshot.trips.find((trip) => trip.id === nextSelectedTripId)?.dateRange.start ?? get().cursorDate,
      activePanel: "archive",
    });
  },
  updateTripTitle: async (tripId, title) => {
    const snapshot = await platformApi.updateTrip(tripId, { title });
    set(applySnapshot(snapshot));
  },
  updatePlaceName: async (placeId, name) => {
    const snapshot = await platformApi.updatePlace(placeId, { name });
    set(applySnapshot(snapshot));
  },
  updatePhotoUserEdits: async (photoId, edits) => {
    const snapshot = await platformApi.updatePhoto(photoId, { userEdits: edits });
    set(applySnapshot(snapshot));
  },
  bindPhotoToPlace: async (photoId, placeId, activePanel = get().activePanel) => {
    const snapshot = await platformApi.bindPhoto(photoId, placeId);
    set({ ...applySnapshot(snapshot), activePanel, manualPlacePick: undefined });
  },
  createPlaceForPhoto: async (photoId, body, activePanel = get().activePanel) => {
    const snapshot = await platformApi.createPlaceForPhoto(photoId, body);
    set({ ...applySnapshot(snapshot), activePanel, manualPlacePick: undefined });
  },
  deletePhoto: async (photoId) => {
    const snapshot = await platformApi.deletePhoto(photoId);
    set(applySnapshot(snapshot));
  },
  acknowledgePendingItem: async (pendingId, accepted) => {
    const snapshot = await platformApi.updatePending(pendingId, accepted);
    set(applySnapshot(snapshot));
  },
  resolvePendingManually: async (pendingId, body) => {
    const snapshot = await platformApi.resolvePendingManually(pendingId, body);
    set({ ...applySnapshot(snapshot), activePanel: "upload", manualPlacePick: undefined });
  },
  openManualPlacePick: (pendingId, name, returnPanel = "upload") => set({ manualPlacePick: { pendingId, name, mode: "bind", returnPanel, isPicking: false, nameDirty: false } }),
  closeManualPlacePick: () => set({ manualPlacePick: undefined }),
  startManualPlacePick: (pendingId, name, nameDirty = false, returnPanel) =>
    set((state) => ({
      manualPlacePick: {
        ...(state.manualPlacePick?.pendingId === pendingId ? state.manualPlacePick : {}),
        pendingId,
        name,
        nameDirty,
        returnPanel: returnPanel ?? state.manualPlacePick?.returnPanel ?? "upload",
        mode: "new",
        isPicking: true,
      },
      activePanel: "globe",
    })),
  finishManualPlacePick: async (point, nearestLabel) => {
    set((state) => ({
      manualPlacePick: state.manualPlacePick ? { ...state.manualPlacePick, point, nearestLabel, isPicking: false } : undefined,
      activePanel: state.manualPlacePick?.returnPanel ?? "upload",
      globeViewIntent: { source: "manual" },
    }));
    try {
      const response = await platformApi.reverseGeocode(point);
      const label = geocodeLabel(response.candidates[0], get().locale);
      set((state) => ({
        manualPlacePick: state.manualPlacePick?.point?.lat === point.lat && state.manualPlacePick.point.lng === point.lng
          ? { ...state.manualPlacePick, nearestLabel: label ?? nearestLabel, name: !state.manualPlacePick.nameDirty && label ? label : state.manualPlacePick.name }
          : state.manualPlacePick,
      }));
    } catch {
      set((state) => ({
        manualPlacePick: state.manualPlacePick?.point?.lat === point.lat && state.manualPlacePick.point.lng === point.lng
          ? { ...state.manualPlacePick, nearestLabel }
          : state.manualPlacePick,
      }));
    }
  },
}));

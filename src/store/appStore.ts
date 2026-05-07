import { create } from "zustand";
import type { ID, ImportBatch, PendingItem, Photo, PlaceNode, Route, SearchResult, TimelineSegment, Trip } from "@/domain/models";
import { apiClient, type AppSnapshot } from "@/services/apiClient";

export type AppPanel = "globe" | "archive" | "tripDetail" | "search" | "import" | "settings" | "upload" | "manual";
export type TimelineZoom = "global" | "trip" | "day";
export type GlobeViewIntent =
  | { source: "timeline-trip"; point: { lat: number; lng: number }; distance: "far" }
  | { source: "timeline-trip-entry"; point: { lat: number; lng: number }; distance: "mid" }
  | { source: "timeline-place"; point: { lat: number; lng: number }; distance: "near" }
  | { source: "timeline-global" }
  | { source: "manual" };

function toDateInput(date?: string) {
  return date ? date.slice(0, 10) : new Date().toISOString().slice(0, 10);
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
  };
}

interface AppState {
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
  aiProvider: "qwen" | "mock";
  aiCloudEnabled: boolean;
  isLoading: boolean;
  isImporting: boolean;
  importProgress?: { done: number; total: number; phase: "reading" | "analyzing" };
  error?: string;
  trips: Trip[];
  photos: Photo[];
  placeNodes: PlaceNode[];
  routes: Route[];
  importBatches: ImportBatch[];
  pendingItems: PendingItem[];
  timelineSegments: TimelineSegment[];
  loadState: () => Promise<void>;
  setActivePanel: (panel: AppPanel) => void;
  selectTrip: (tripId: ID, panel?: AppPanel) => void;
  selectPlace: (placeId: ID) => void;
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
  importAppleTestPhotos: () => Promise<void>;
  confirmLatestImport: () => Promise<void>;
  rollbackLatestImport: () => Promise<void>;
  mergeLatestImportTrips: () => Promise<void>;
  createManualTrip: (title: string, start: string, end: string) => Promise<void>;
  addManualPlace: (tripId: ID, name: string, lat: number, lng: number) => Promise<void>;
  deleteManualPlace: (placeId: ID) => Promise<void>;
  reorderTripPlaces: (tripId: ID, placeIds: ID[]) => Promise<void>;
  updateTripTitle: (tripId: ID, title: string) => Promise<void>;
  updateTripDates: (tripId: ID, start: string, end: string) => Promise<void>;
  updatePhotoMetadata: (photoId: ID, capturedAt: string, lat: string, lng: string, tags: string) => Promise<void>;
  movePhotoToTrip: (photoId: ID, tripId?: ID) => Promise<void>;
  bindPhotoToPlace: (photoId: ID, placeId?: ID) => Promise<void>;
  acknowledgePendingItem: (pendingId: ID, accepted: boolean) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  activePanel: "globe",
  selectedTripId: "trip-kansai-2025",
  cursorDate: "2025-10-04",
  timelineZoom: "global",
  globeViewIntent: { source: "manual" },
  searchQuery: "",
  searchFilters: {},
  searchResults: [],
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
  loadState: async () => {
    set({ isLoading: true, error: undefined });
    try {
      const snapshot = await apiClient.getState();
      set((state) => ({
        ...applySnapshot(snapshot),
        selectedTripId: state.selectedTripId || snapshot.trips[0]?.id || "",
        cursorDate: state.cursorDate || snapshot.trips[0]?.dateRange.start || new Date().toISOString().slice(0, 10),
        isLoading: false,
      }));
    } catch (error) {
      set({ isLoading: false, error: error instanceof Error ? error.message : "加载本地后端失败" });
    }
  },
  setActivePanel: (panel) => set({ activePanel: panel }),
  selectTrip: (tripId, panel = "globe") => {
    const trip = get().trips.find((item) => item.id === tripId);
    set({
      selectedTripId: tripId,
      selectedPlaceId: undefined,
      selectedPhotoId: undefined,
      cursorDate: trip?.dateRange.start ?? get().cursorDate,
      activePanel: panel,
    });
  },
  selectPlace: (placeId) => {
    const place = get().placeNodes.find((item) => item.id === placeId);
    set({
      selectedPlaceId: placeId,
      selectedTripId: place?.tripId ?? get().selectedTripId,
      cursorDate: place?.timeRange.start.slice(0, 10) ?? get().cursorDate,
      activePanel: "globe",
    });
  },
  selectPhoto: (photoId) => {
    const photo = get().photos.find((item) => item.id === photoId);
    set({
      selectedPhotoId: photoId,
      selectedTripId: photo?.tripId ?? get().selectedTripId,
      selectedPlaceId: photo?.placeNodeId,
      cursorDate: toDateInput(photo?.capturedAt),
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
      const { results } = await apiClient.search(query, get().searchFilters);
      set({ searchResults: results, error: undefined });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "搜索失败" });
    }
  },
  setAiCloudEnabled: (enabled) => set({ aiCloudEnabled: enabled }),
  importFiles: async (filesLike) => {
    const files = Array.from(filesLike);
    if (files.length === 0) return;
    set({ isImporting: true, importProgress: { done: 0, total: files.length, phase: "reading" }, error: undefined });
    try {
      const snapshot = await apiClient.importFiles(files, get().aiCloudEnabled, (done, total) => {
        set({ importProgress: { done, total, phase: done === total ? "analyzing" : "reading" } });
      });
      const latest = snapshot.importBatches[snapshot.importBatches.length - 1];
      set({
        ...applySnapshot(snapshot),
        isImporting: false,
        importProgress: undefined,
        selectedTripId: latest?.createdTripIds[0] ?? snapshot.trips[0]?.id ?? "",
        cursorDate: snapshot.trips.find((trip) => trip.id === latest?.createdTripIds[0])?.dateRange.start ?? get().cursorDate,
        activePanel: "import",
      });
    } catch (error) {
      set({ isImporting: false, importProgress: undefined, error: error instanceof Error ? error.message : "导入失败" });
    }
  },
  importAppleTestPhotos: async () => {
    set({ isImporting: true, importProgress: { done: 0, total: 149, phase: "analyzing" }, error: undefined });
    try {
      const snapshot = await apiClient.importAppleTestPhotos(get().aiCloudEnabled);
      const latest = snapshot.importBatches[snapshot.importBatches.length - 1];
      set({
        ...applySnapshot(snapshot),
        isImporting: false,
        importProgress: undefined,
        selectedTripId: latest?.createdTripIds[0] ?? snapshot.trips[0]?.id ?? "",
        cursorDate: snapshot.trips.find((trip) => trip.id === latest?.createdTripIds[0])?.dateRange.start ?? get().cursorDate,
        activePanel: "import",
      });
    } catch (error) {
      set({ isImporting: false, importProgress: undefined, error: error instanceof Error ? error.message : "导入 Apple 测试照片失败" });
    }
  },
  confirmLatestImport: async () => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation") return;
    const snapshot = await apiClient.confirmImport(latest.id);
    set({ ...applySnapshot(snapshot), activePanel: "globe" });
  },
  rollbackLatestImport: async () => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation") return;
    const snapshot = await apiClient.rollbackImport(latest.id);
    set({ ...applySnapshot(snapshot), selectedTripId: snapshot.trips[0]?.id ?? "", activePanel: "globe" });
  },
  mergeLatestImportTrips: async () => {
    const batches = get().importBatches;
    const latest = batches[batches.length - 1];
    if (!latest || latest.status !== "pending_confirmation") return;
    const snapshot = await apiClient.mergeImportTrips(latest.id);
    set({ ...applySnapshot(snapshot), selectedTripId: latest.createdTripIds[0] ?? get().selectedTripId, activePanel: "import" });
  },
  createManualTrip: async (title, start, end) => {
    const snapshot = await apiClient.createTrip(title, start, end);
    const created = snapshot.trips[snapshot.trips.length - 1];
    set({ ...applySnapshot(snapshot), selectedTripId: created?.id ?? get().selectedTripId, activePanel: "tripDetail" });
  },
  addManualPlace: async (tripId, name, lat, lng) => {
    const snapshot = await apiClient.createPlace(tripId, name, lat, lng);
    const created = snapshot.placeNodes[snapshot.placeNodes.length - 1];
    set({ ...applySnapshot(snapshot), selectedPlaceId: created?.id });
  },
  deleteManualPlace: async (placeId) => {
    const snapshot = await apiClient.deletePlace(placeId);
    set({ ...applySnapshot(snapshot), selectedPlaceId: undefined });
  },
  reorderTripPlaces: async (tripId, placeIds) => {
    const snapshot = await apiClient.reorderPlaces(tripId, placeIds);
    set(applySnapshot(snapshot));
  },
  updateTripTitle: async (tripId, title) => {
    const snapshot = await apiClient.updateTrip(tripId, { title });
    set(applySnapshot(snapshot));
  },
  updateTripDates: async (tripId, start, end) => {
    const snapshot = await apiClient.updateTrip(tripId, { dateRange: { start, end } });
    set(applySnapshot(snapshot));
  },
  updatePhotoMetadata: async (photoId, capturedAt, lat, lng, tags) => {
    const snapshot = await apiClient.updatePhoto(photoId, {
      capturedAt: capturedAt ? new Date(capturedAt).toISOString() : "",
      location: { lat, lng },
      tags: tags
        .split(/[,\s，、/]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
    set(applySnapshot(snapshot));
  },
  movePhotoToTrip: async (photoId, tripId) => {
    const snapshot = await apiClient.movePhoto(photoId, tripId);
    set(applySnapshot(snapshot));
  },
  bindPhotoToPlace: async (photoId, placeId) => {
    const snapshot = await apiClient.bindPhoto(photoId, placeId);
    set(applySnapshot(snapshot));
  },
  acknowledgePendingItem: async (pendingId, accepted) => {
    const snapshot = await apiClient.updatePending(pendingId, accepted);
    set(applySnapshot(snapshot));
  },
}));

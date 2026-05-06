export type ID = string;

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type PendingReason =
  | "missing_gps"
  | "missing_time"
  | "needs_trip_confirmation"
  | "split_suggestion"
  | "recent_import";

export interface Photo {
  id: ID;
  fileName: string;
  title?: string;
  thumbnailUrl: string;
  storageUrl?: string;
  originalHash?: string;
  mime?: string;
  capturedAt?: string;
  location?: GeoPoint;
  tripId?: ID;
  placeNodeId?: ID;
  tags: string[];
  aiCaption: string;
  aiProvider?: "qwen" | "qwen-mock" | "mock";
  embeddingProvider?: "qwen" | "deterministic";
  embeddingDimension?: number;
  aiFallbackReason?: string;
  exifStatus?: {
    time: "read" | "fallback" | "missing";
    gps: "read" | "fallback" | "missing";
  };
  importedBatchId?: ID;
  pendingReason?: PendingReason;
}

export interface ImportBatch {
  id: ID;
  importedAt: string;
  totalCount: number;
  successCount: number;
  failedCount: number;
  duplicateCount?: number;
  status: "analyzing" | "pending_confirmation" | "confirmed" | "rolled_back";
  createdTripIds: ID[];
  updatedTripIds?: ID[];
  addedPhotoIds: ID[];
  pendingItemIds: ID[];
  storedFileNames?: string[];
  storedThumbnailNames?: string[];
  aiStats?: {
    qwenCount: number;
    fallbackCount: number;
    embeddingCount: number;
    qwenEmbeddingCount: number;
    deterministicEmbeddingCount: number;
  };
  summary: string;
}

export interface Trip {
  id: ID;
  title: string;
  dateRange: {
    start: string;
    end: string;
  };
  countries: string[];
  cities: string[];
  coverUrl: string;
  photoCount: number;
  placeNodeCount: number;
  status: "draft" | "pending" | "confirmed" | "ongoing" | "archived";
  source: "sample" | "import" | "manual";
}

export interface PlaceNode {
  id: ID;
  tripId: ID;
  name: string;
  center: GeoPoint;
  photoIds: ID[];
  timeRange: {
    start: string;
    end: string;
  };
  pending: boolean;
}

export interface Route {
  id: ID;
  tripId: ID;
  points: GeoPoint[];
  status: "auto_generated" | "confirmed" | "incomplete" | "pending";
}

export interface TimelineSegment {
  id: ID;
  label: string;
  start: string;
  end: string;
  granularity: "year" | "month" | "day" | "photo";
  relatedType: "trip" | "place" | "photo";
  relatedId: ID;
  photoCount: number;
}

export interface PendingItem {
  id: ID;
  type: PendingReason;
  relatedPhotoIds: ID[];
  relatedTripId?: ID;
  suggestion: string;
  reason: string;
  status: "open" | "accepted" | "ignored";
}

export interface SearchResult {
  id: ID;
  photoId: ID;
  tripId?: ID;
  reason: string;
  score: number;
}

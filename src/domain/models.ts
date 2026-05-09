export type ID = string;

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type PendingReason =
  | "missing_gps"
  | "missing_time"
  | "confirm_location_candidate"
  | "needs_trip_confirmation"
  | "split_suggestion"
  | "merge_suggestion"
  | "recent_import";

export interface LocationCandidate {
  id: ID;
  name: string;
  country?: string;
  city?: string;
  point?: GeoPoint;
  confidence: number;
  source: "exif" | "ai_vision" | "filename" | "geo_catalog" | "nearby_trip" | "manual" | "ai_context_inference" | "nearby_exif" | "geocode" | "existing_trip_context";
  precision?: "confirmed" | "estimated";
  reason: string;
}

export interface PhotoAiEvidence {
  provider: "qwen" | "qwen-mock" | "mock";
  promptId: string;
  promptVersion: string;
  analyzedAt: string;
  title?: string;
  caption: string;
  tags: string[];
  visiblePlaceNames: string[];
  locationCandidates: LocationCandidate[];
  uncertainties?: string[];
  fallbackReason?: string;
}

export interface LocationResolution {
  status: "confirmed" | "suggested" | "missing" | "rejected";
  effectiveName?: string;
  effectivePoint?: GeoPoint;
  confidence?: number;
  source?: LocationCandidate["source"];
  precision?: "confirmed" | "estimated";
  candidateId?: ID;
  candidates: LocationCandidate[];
  requiresUserAction: boolean;
  updatedAt: string;
}

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
  ai?: PhotoAiEvidence;
  locationResolution?: LocationResolution;
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
  duplicatePhotoIds?: ID[];
  duplicateNames?: string[];
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
  displayName?: string;
  country?: string;
  city?: string;
  center: GeoPoint;
  coordinatePrecision?: "confirmed" | "estimated";
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
  shortLabel?: string;
  start: string;
  end: string;
  granularity: "year" | "month" | "day" | "photo";
  relatedType: "trip" | "place" | "photo";
  relatedId: ID;
  photoCount: number;
  status?: "confirmed" | "suggested" | "missing";
}

export interface PendingItem {
  id: ID;
  type: PendingReason;
  relatedPhotoIds: ID[];
  relatedTripId?: ID;
  suggestion: string;
  reason: string;
  status: "open" | "accepted" | "ignored";
  inference?: {
    status: "suggested" | "keep_pending";
    confidence: number;
    reason: string;
    displayTarget?: string;
    displayTargetLabel?: string;
    displayTargetBadge?: string;
    updatedAt: string;
  };
  proposal?: PendingProposal;
}

export type PendingProposal =
  | {
      action: "confirm_location_candidate";
      photoIds: ID[];
      candidateId: ID;
      createPlaceNode?: boolean;
    }
  | {
      action: "bind_photos_to_place";
      photoIds: ID[];
      placeId: ID;
      confidence?: number;
      reason?: string;
    }
  | {
      action: "create_place_from_candidate";
      tripId: ID;
      photoIds: ID[];
      candidate: LocationCandidate;
    }
  | {
      action: "confirm_trip_assignment";
      tripId: ID;
      photoIds: ID[];
    }
  | {
      action: "merge_trips";
      targetTripId: ID;
      sourceTripIds: ID[];
    }
  | {
      action: "keep_pending";
      confidence: number;
      reason: string;
    };

export interface GlobeMarker {
  id: ID;
  kind: "country" | "place";
  label: string;
  center: GeoPoint;
  count: number;
  photoIds: ID[];
  placeIds?: ID[];
  tripId: ID;
  countryName?: string;
  startTime?: string;
  endTime?: string;
  status: "confirmed" | "suggested" | "missing";
}

export interface DossierDayGroup {
  day: string;
  country: string;
  photoIds: ID[];
  placeIds: ID[];
  status: "confirmed" | "suggested" | "missing";
}

export interface DossierTripGroup {
  tripId: ID;
  countries: Array<{ country: string; days: DossierDayGroup[] }>;
}

export interface SearchDocument {
  id: ID;
  photoId: ID;
  tripId?: ID;
  placeNodeId?: ID;
  capturedAt?: string;
  tags: string[];
  locationNames: string[];
  geoKeywords?: string[];
  titleText?: string;
  tagText?: string;
  captionText?: string;
}

export interface SearchResult {
  id: ID;
  photoId: ID;
  tripId?: ID;
  reason: string;
  score: number;
}

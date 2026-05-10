export type ID = string;

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface LocalizedNames {
  zh?: string;
  en?: string;
  local?: string;
}

export type PendingReason =
  | "missing_gps"
  | "missing_time"
  | "ai_processing_failed"
  | "confirm_location_candidate"
  | "needs_trip_confirmation"
  | "split_suggestion"
  | "merge_suggestion"
  | "recent_import";

export interface LocationCandidate {
  id: ID;
  name: string;
  localizedNames?: LocalizedNames;
  country?: string;
  localizedCountryNames?: LocalizedNames;
  city?: string;
  localizedCityNames?: LocalizedNames;
  point?: GeoPoint;
  confidence: number;
  source:
    | "exif"
    | "ai_vision"
    | "filename"
    | "geo_catalog"
    | "nearby_trip"
    | "manual"
    | "ai_context_inference"
    | "nearby_exif"
    | "geocode"
    | "existing_trip_context"
    | "manual_existing_place"
    | "manual_new_place"
    | "manual_archived_unlocated";
  precision?: "confirmed" | "estimated";
  reason: string;
  admin1?: string;
  admin2?: string;
  countryCode?: string;
  featureCode?: string;
  featureLabel?: string;
  distanceKm?: number;
  geocodeRank?: number;
  population?: number;
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
  userEdits?: {
    title?: string;
    caption?: string;
    tags?: string[];
    updatedAt: string;
  };
  ai?: PhotoAiEvidence;
  locationResolution?: LocationResolution;
  aiProvider?: "qwen" | "qwen-mock" | "mock";
  embeddingProvider?: "qwen" | "deterministic";
  embeddingDimension?: number;
  aiFallbackReason?: string;
  aiFailure?: {
    vision?: string;
    embedding?: string;
    hasRealExifGps: boolean;
    hasRealExifTime: boolean;
    updatedAt: string;
  };
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
  names?: LocalizedNames;
  displayName?: string;
  country?: string;
  countryNames?: LocalizedNames;
  city?: string;
  cityNames?: LocalizedNames;
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
  labelNames?: LocalizedNames;
  shortLabel?: string;
  shortLabelNames?: LocalizedNames;
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
    }
  | {
      action: "resolve_ai_processing_failed";
      photoIds: ID[];
    };

export interface GlobeMarker {
  id: ID;
  kind: "country" | "place";
  label: string;
  labelNames?: LocalizedNames;
  center: GeoPoint;
  count: number;
  photoIds: ID[];
  placeIds?: ID[];
  tripId: ID;
  countryName?: string;
  countryNames?: LocalizedNames;
  startTime?: string;
  endTime?: string;
  status: "confirmed" | "suggested" | "missing";
}

export interface DossierDayGroup {
  day: string;
  country: string;
  countryNames?: LocalizedNames;
  photoIds: ID[];
  placeIds: ID[];
  status: "confirmed" | "suggested" | "missing";
}

export interface DossierTripGroup {
  tripId: ID;
  countries: Array<{ country: string; countryNames?: LocalizedNames; days: DossierDayGroup[] }>;
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

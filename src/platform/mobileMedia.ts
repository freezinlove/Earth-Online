import type { GeoPoint, Photo } from "@/domain/models";
import type { NativePhotoAsset } from "@/platform/nativePhotoLibrary";
import { parseExifBytes } from "../../shared/media/exif-core.mjs";

export type ExifResult = {
  capturedAt?: string;
  location?: GeoPoint;
};

const maxThumbSize = 720;
const defaultThumbQuality = 0.78;

export function parseExif(buffer: ArrayBuffer): ExifResult {
  return parseExifBytes(buffer) as ExifResult;
}

export async function hashBuffer(buffer: ArrayBuffer) {
  if (!window.crypto?.subtle) return undefined;
  const digest = await window.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function renderImageDataUrl(objectUrl: string, maxDimension: number, jpegQuality = defaultThumbQuality) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.decoding = "async";
    img.src = objectUrl;
  });
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const quality = jpegQuality > 1 ? jpegQuality / 100 : jpegQuality;
  return canvas.toDataURL("image/jpeg", Math.max(0.01, Math.min(1, quality)));
}

async function createImageDataUrlFromBlob(blob: Blob, maxDimension: number, jpegQuality: number, fallbackMime: string) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await renderImageDataUrl(objectUrl, maxDimension, jpegQuality);
  } catch {
    return readDataUrlFromBlob(blob, blob.type || fallbackMime);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function createImageDataUrl(source: File | string, maxDimension: number, jpegQuality = defaultThumbQuality, fallbackMime = "image/jpeg") {
  const objectUrl = typeof source === "string" ? source : URL.createObjectURL(source);
  try {
    return await renderImageDataUrl(objectUrl, maxDimension, jpegQuality);
  } catch {
    if (typeof source === "string") {
      const response = await fetch(source);
      const blob = await response.blob();
      return createImageDataUrlFromBlob(blob, maxDimension, jpegQuality, fallbackMime);
    }
    return createImageDataUrlFromBlob(source, maxDimension, jpegQuality, fallbackMime);
  } finally {
    if (typeof source !== "string") URL.revokeObjectURL(objectUrl);
  }
}

export async function createThumbnail(file: File) {
  return createImageDataUrl(file, maxThumbSize, defaultThumbQuality, file.type || "image/jpeg");
}

async function readDataUrlFromBlob(blob: Blob, mime: string) {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function photoFromNativeAsset(
  asset: NativePhotoAsset,
  { makeId, nowIso }: { makeId: (prefix: string) => string; nowIso: () => string },
): Photo {
  const location = typeof asset.latitude === "number" && typeof asset.longitude === "number" ? { lat: asset.latitude, lng: asset.longitude } : undefined;
  const capturedAt = asset.capturedAt ?? (asset.lastModified ? new Date(asset.lastModified).toISOString() : nowIso());
  const title = asset.fileName.replace(/\.[^.]+$/, "");
  const canReuseOriginal = asset.persisted !== false;
  return {
    id: makeId("photo"),
    fileName: asset.fileName,
    title,
    originalHash: asset.sha256 ?? asset.uri,
    mime: asset.mimeType,
    thumbnailUrl: asset.thumbnailDataUrl ?? asset.webPath ?? "",
    storageUrl: canReuseOriginal ? asset.webPath ?? asset.uri : undefined,
    sourceUri: canReuseOriginal ? asset.uri : undefined,
    sourceWebPath: canReuseOriginal ? asset.webPath : undefined,
    sourceProvider: "android_photo_picker",
    capturedAt,
    location,
    tags: canReuseOriginal ? ["手机相册"] : ["手机相册", "原图授权未持久化"],
    aiCaption: "",
    locationResolution: {
      status: location ? "confirmed" : "missing",
      effectivePoint: location,
      confidence: location ? 1 : undefined,
      source: location ? "exif" : undefined,
      precision: location ? "confirmed" : undefined,
      candidates: [],
      requiresUserAction: !location,
      updatedAt: nowIso(),
    },
    exifStatus: {
      time: asset.capturedAt ? "read" : "fallback",
      gps: location ? "read" : "missing",
    },
    pendingReason: location ? undefined : "missing_gps",
  };
}

export function duplicateNativeAssetIds(state: { photos: Photo[] }, assets: NativePhotoAsset[]) {
  const existingHashes = new Set(state.photos.map((photo) => photo.originalHash).filter((value): value is string => Boolean(value)));
  const existingUris = new Set(state.photos.map((photo) => photo.sourceUri).filter((value): value is string => Boolean(value)));
  return new Set(
    assets
      .filter((asset) => (asset.sha256 && existingHashes.has(asset.sha256)) || existingUris.has(asset.uri))
      .map((asset) => asset.sha256 ?? asset.uri),
  );
}

export function duplicateNativeAssetPhotoIds(state: { photos: Photo[] }, assets: NativePhotoAsset[]) {
  const hashToPhoto = new Map(state.photos.filter((photo) => photo.originalHash).map((photo) => [photo.originalHash, photo.id]));
  const uriToPhoto = new Map(state.photos.filter((photo) => photo.sourceUri).map((photo) => [photo.sourceUri, photo.id]));
  return assets
    .map((asset) => (asset.sha256 ? hashToPhoto.get(asset.sha256) : undefined) ?? uriToPhoto.get(asset.uri))
    .filter((id): id is string => Boolean(id));
}

export function sourceUrisForPhotos(photos: Photo[]) {
  return photos.map((photo) => photo.sourceUri).filter((uri): uri is string => Boolean(uri));
}

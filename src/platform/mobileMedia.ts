import type { GeoPoint, Photo } from "@/domain/models";
import type { NativePhotoAsset } from "@/platform/nativePhotoLibrary";

export type ExifResult = {
  capturedAt?: string;
  location?: GeoPoint;
};

const maxThumbSize = 720;
const defaultThumbQuality = 0.78;

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  return Array.from(bytes.slice(offset, offset + length))
    .map((byte) => String.fromCharCode(byte))
    .join("")
    .replace(/\0/g, "")
    .trim();
}

function parseTiff(bytes: Uint8Array): ExifResult {
  if (bytes.length < 8) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = readAscii(bytes, 0, 2) === "II";
  const u16 = (offset: number) => (little ? view.getUint16(offset, true) : view.getUint16(offset, false));
  const u32 = (offset: number) => (little ? view.getUint32(offset, true) : view.getUint32(offset, false));
  const rational = (offset: number) => {
    if (offset + 8 > bytes.length) return 0;
    const denominator = u32(offset + 4);
    return denominator ? u32(offset) / denominator : 0;
  };
  const parseIfd = (start: number) => {
    const entries = new Map<number, { count: number; raw: number; type: number; value: number }>();
    if (start + 2 > bytes.length) return entries;
    const count = u16(start);
    for (let index = 0; index < count; index += 1) {
      const entry = start + 2 + index * 12;
      if (entry + 12 > bytes.length) break;
      entries.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), value: u32(entry + 8), raw: entry + 8 });
    }
    return entries;
  };

  const root = parseIfd(u32(4));
  const exifIfd = root.get(0x8769)?.value;
  const gpsIfd = root.get(0x8825)?.value;
  let capturedAt: string | undefined;
  if (exifIfd) {
    const exif = parseIfd(exifIfd);
    const date = exif.get(0x9003) ?? exif.get(0x0132);
    if (date) {
      const offset = date.count > 4 ? date.value : date.raw;
      const text = readAscii(bytes, offset, date.count);
      const match = text.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (match) capturedAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
    }
  }

  let location: GeoPoint | undefined;
  if (gpsIfd) {
    const gps = parseIfd(gpsIfd);
    const latRef = readAscii(bytes, gps.get(1)?.raw ?? 0, 2);
    const lat = gps.get(2);
    const lngRef = readAscii(bytes, gps.get(3)?.raw ?? 0, 2);
    const lng = gps.get(4);
    if (lat && lng) {
      const toDeg = (entry: { value: number }) => rational(entry.value) + rational(entry.value + 8) / 60 + rational(entry.value + 16) / 3600;
      location = {
        lat: toDeg(lat) * (latRef === "S" ? -1 : 1),
        lng: toDeg(lng) * (lngRef === "W" ? -1 : 1),
      };
    }
  }
  return { capturedAt, location };
}

export function parseExif(buffer: ArrayBuffer): ExifResult {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return {};
  const view = new DataView(buffer);
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const length = view.getUint16(offset + 2, false);
    if (marker === 0xe1 && readAscii(bytes, offset + 4, 6).startsWith("Exif")) {
      return parseTiff(bytes.slice(offset + 10, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return {};
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

import { Capacitor, registerPlugin } from "@capacitor/core";

export type NativePhotoAsset = {
  uri: string;
  webPath?: string;
  fileName: string;
  mimeType: string;
  size?: number;
  width?: number;
  height?: number;
  lastModified?: number;
  capturedAt?: string;
  latitude?: number;
  longitude?: number;
  thumbnailDataUrl?: string;
  sha256?: string;
  persisted?: boolean;
  persistedError?: string;
  error?: string;
};

type PickPhotosOptions = {
  limit?: number;
};

type PickPhotosResult = {
  photos: NativePhotoAsset[];
};

type AvailabilityResult = {
  available: boolean;
  maxSelection: number;
  platform: string;
};

type ReleasePermissionsResult = {
  released: number;
};

type EarthPhotoLibraryPlugin = {
  isAvailable(): Promise<AvailabilityResult>;
  pickPhotos(options?: PickPhotosOptions): Promise<PickPhotosResult>;
  releasePersistedPermissions(options: { uris: string[] }): Promise<ReleasePermissionsResult>;
};

const EarthPhotoLibrary = registerPlugin<EarthPhotoLibraryPlugin>("EarthPhotoLibrary");

export async function isNativePhotoLibraryAvailable() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return false;
  try {
    const result = await EarthPhotoLibrary.isAvailable();
    return result.available;
  } catch {
    return false;
  }
}

export async function pickNativePhotoAssets(limit = 80) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return [];
  const result = await EarthPhotoLibrary.pickPhotos({ limit });
  return result.photos.map((photo) => ({
    ...photo,
    webPath: photo.webPath ?? Capacitor.convertFileSrc(photo.uri),
  }));
}

export async function releaseNativePhotoPermissions(uris: string[]) {
  if (!uris.length || !Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
  try {
    await EarthPhotoLibrary.releasePersistedPermissions({ uris });
  } catch {
    // Permission cleanup is best-effort; stale grants are harmless until the platform limit is reached.
  }
}

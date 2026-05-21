import type { Photo } from "@/domain/models";

export function getHighResolutionSource(source = "", width = 1800) {
  if (!source.includes("images.unsplash.com")) return source;

  return source
    .replace(/([?&]w=)\d+/g, (_match, prefix: string) => `${prefix}${width}`)
    .replace(/([?&]q=)\d+/g, (_match, prefix: string) => `${prefix}90`);
}

export function photoThumbnailSource(photo?: Photo) {
  if (!photo) return "";
  return photo.thumbnailUrl || photo.displayUrl || getHighResolutionSource(photo.storageUrl ?? "", 960);
}

export function photoDisplaySource(photo?: Photo) {
  if (!photo) return "";
  return photo.displayUrl || getHighResolutionSource(photo.storageUrl ?? photo.thumbnailUrl, 1800);
}

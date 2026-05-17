import { apiClient } from "@/services/apiClient";
import { isAndroidRuntime } from "@/platform/runtime";
import { mobileLocalApi } from "@/platform/mobileLocalApi";

export type PlatformApi = typeof apiClient & {
  importMobilePhotoAssets?: typeof mobileLocalApi.importMobilePhotoAssets;
};

export const platformApi: PlatformApi = (isAndroidRuntime() ? mobileLocalApi : apiClient) as PlatformApi;

export { isAndroidRuntime, isNativeRuntime } from "@/platform/runtime";

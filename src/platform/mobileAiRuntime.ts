import type { GeoPoint, LocationCandidate, Photo } from "@/domain/models";
import { readMobileAiSettings, secretForMobileAiProfile } from "@/platform/mobileAiSettings";
import { analyzePhotoWithProvider, embedContentWithProvider, inferMissingInfoWithProvider } from "../../shared/ai/provider-runtime.mjs";
import { inferPreset } from "../../shared/domain/geo.mjs";

export type MobileEmbeddingResult = {
  embedding?: number[];
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingSpaceId?: string;
  embeddingDimension?: number;
  embeddingMode?: Photo["embeddingMode"];
  embeddingFallbackReason?: string;
};

export type MobilePhotoAnalysis = {
  provider: string;
  model?: string;
  promptId?: string;
  promptVersion?: string;
  title?: string;
  tags: string[];
  caption: string;
  visiblePlaceNames: string[];
  locationCandidates: Array<Partial<LocationCandidate>>;
  uncertainties: string[];
  fallbackReason?: string;
};

export function vectorStatsDefaults() {
  return {
    qwenCount: 0,
    fallbackCount: 0,
    embeddingCount: 0,
    qwenEmbeddingCount: 0,
    deterministicEmbeddingCount: 0,
  };
}

export function recordMobileEmbeddingStats(result: MobileEmbeddingResult | undefined, stats: ReturnType<typeof vectorStatsDefaults>) {
  if (!result?.embedding?.length) return;
  stats.embeddingCount += 1;
  if (result.embeddingProvider === "aliyun" || result.embeddingProvider === "qwen") stats.qwenEmbeddingCount += 1;
}

export async function embedMobileContent({
  dataUrl,
  text,
  fileName,
  allowCloud = true,
}: {
  dataUrl?: string;
  text?: string;
  fileName?: string;
  allowCloud?: boolean;
}): Promise<MobileEmbeddingResult | undefined> {
  const settings = await readMobileAiSettings();
  const profile = settings.aiConfig.profiles.crossModalEmbedding;
  const apiKey = await secretForMobileAiProfile("crossModalEmbedding", profile.providerId);
  return embedContentWithProvider({ profile, apiKey, dataUrl, text, fileName, allowCloud }) as Promise<MobileEmbeddingResult | undefined>;
}

export async function analyzeMobilePhoto({
  fileName,
  mime,
  dataUrl,
  preset,
  location,
  allowCloud,
  locale = "zh",
}: {
  fileName: string;
  mime: string;
  dataUrl?: string;
  preset: ReturnType<typeof inferPreset>;
  location?: GeoPoint;
  allowCloud: boolean;
  locale?: "zh" | "en";
}): Promise<MobilePhotoAnalysis> {
  const settings = await readMobileAiSettings();
  const profile = settings.aiConfig.profiles.imageUnderstanding;
  const apiKey = await secretForMobileAiProfile("imageUnderstanding", profile.providerId);
  return analyzePhotoWithProvider({ profile, apiKey, fileName, mime, dataUrl, preset, location, allowCloud, locale }) as Promise<MobilePhotoAnalysis>;
}

export async function inferMobileMissingInfoWithImage({
  dataUrl,
  mime,
  inferenceInput,
  locale = "zh",
}: {
  dataUrl?: string;
  mime: string;
  inferenceInput: unknown;
  locale?: "zh" | "en";
}) {
  const settings = await readMobileAiSettings();
  const profile = settings.aiConfig.profiles.imageUnderstanding;
  const apiKey = await secretForMobileAiProfile("imageUnderstanding", profile.providerId);
  return inferMissingInfoWithProvider({ profile, apiKey, dataUrl, mime, inferenceInput, locale });
}

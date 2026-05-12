import { envValue } from "../config/env.mjs";
import { firstRecommendedModel, listAiModelCatalog, modelEmbeddingDimensions } from "./model-catalog.mjs";

function normalizeModelSource(value) {
  return value === "custom" ? "custom" : "recommended";
}

function normalizeProfile(profile, fallback) {
  return {
    ...fallback,
    ...(profile && typeof profile === "object" ? profile : {}),
    modelSource: normalizeModelSource(profile?.modelSource ?? fallback.modelSource),
  };
}

function hasSecret(secretProvider, key) {
  return Boolean(secretProvider?.get?.(key));
}

export function defaultAiConfig(rootDir = process.cwd(), secretProvider) {
  const legacyEmbeddingEnabled =
    Boolean(secretProvider?.getProfileApiKey?.("crossModalEmbedding", "aliyun")) ||
    hasSecret(secretProvider, "aliyunApiKey") ||
    hasSecret(secretProvider, "qwenEmbeddingApiKey") ||
    Boolean(envValue(rootDir, "QWEN_VISION_EMBEDDING_MODEL", ""));
  return {
    profiles: {
      imageUnderstanding: {
        providerId: "aliyun",
        modelId: envValue(rootDir, "QWEN_CHAT_MODEL", firstRecommendedModel("imageUnderstanding", "aliyun") ?? "qwen3.5-flash"),
        modelSource: "recommended",
      },
      crossModalEmbedding: {
        enabled: legacyEmbeddingEnabled,
        providerId: "aliyun",
        modelId: envValue(rootDir, "QWEN_VISION_EMBEDDING_MODEL", firstRecommendedModel("crossModalEmbedding", "aliyun") ?? "tongyi-embedding-vision-flash-2026-03-06"),
        modelSource: "recommended",
      },
    },
  };
}

export function normalizeAiConfig(config, { rootDir = process.cwd(), secretProvider } = {}) {
  const fallback = defaultAiConfig(rootDir, secretProvider);
  const profiles = config?.profiles && typeof config.profiles === "object" ? config.profiles : {};
  const imageUnderstanding = normalizeProfile(profiles.imageUnderstanding, fallback.profiles.imageUnderstanding);
  const rawEmbedding = profiles.crossModalEmbedding && typeof profiles.crossModalEmbedding === "object" ? profiles.crossModalEmbedding : {};
  const crossModalEmbedding = {
    ...normalizeProfile(rawEmbedding, fallback.profiles.crossModalEmbedding),
    enabled: Boolean(rawEmbedding.enabled ?? fallback.profiles.crossModalEmbedding.enabled),
  };
  if (!crossModalEmbedding.enabled) {
    crossModalEmbedding.providerId = rawEmbedding.providerId ?? null;
    crossModalEmbedding.modelId = rawEmbedding.modelId ?? null;
    crossModalEmbedding.modelSource = rawEmbedding.modelSource ?? null;
  }
  return {
    catalog: listAiModelCatalog(),
    profiles: {
      imageUnderstanding,
      crossModalEmbedding,
    },
  };
}

export function getAiConfig({ rootDir = process.cwd(), secretProvider } = {}) {
  return normalizeAiConfig(secretProvider?.getAiConfig?.(), { rootDir, secretProvider });
}

export function embeddingSpaceId(profile) {
  if (!profile?.providerId || !profile?.modelId) return undefined;
  const dimensions = modelEmbeddingDimensions("crossModalEmbedding", profile.providerId, profile.modelId);
  return [profile.providerId, profile.modelId, dimensions ? `d${dimensions}` : undefined].filter(Boolean).join(":");
}

export function embeddingDimensions(profile) {
  if (!profile?.providerId || !profile?.modelId) return undefined;
  return modelEmbeddingDimensions("crossModalEmbedding", profile.providerId, profile.modelId);
}

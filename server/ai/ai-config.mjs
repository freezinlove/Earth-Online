import { envValue } from "../config/env.mjs";
import {
  defaultAiProfiles,
  embeddingDimensions,
  embeddingSpaceId,
  firstRecommendedModel,
  normalizeAiConfig as normalizeSharedAiConfig,
} from "../../shared/ai/ai-config.mjs";

function hasSecret(secretProvider, key) {
  return Boolean(secretProvider?.get?.(key));
}

function legacyEmbeddingEnabled(rootDir, secretProvider) {
  return (
    Boolean(secretProvider?.getProfileApiKey?.("crossModalEmbedding", "aliyun")) ||
    hasSecret(secretProvider, "aliyunApiKey") ||
    hasSecret(secretProvider, "qwenEmbeddingApiKey") ||
    Boolean(envValue(rootDir, "QWEN_VISION_EMBEDDING_MODEL", ""))
  );
}

export function defaultAiConfig(rootDir = process.cwd(), secretProvider) {
  return {
    profiles: defaultAiProfiles({
      legacyEmbeddingEnabled: legacyEmbeddingEnabled(rootDir, secretProvider),
      imageModelId: envValue(rootDir, "QWEN_CHAT_MODEL", firstRecommendedModel("imageUnderstanding", "aliyun") ?? "qwen3.5-flash"),
      embeddingModelId: envValue(rootDir, "QWEN_VISION_EMBEDDING_MODEL", firstRecommendedModel("crossModalEmbedding", "aliyun") ?? "tongyi-embedding-vision-flash-2026-03-06"),
    }),
  };
}

export function normalizeAiConfig(config, { rootDir = process.cwd(), secretProvider } = {}) {
  return normalizeSharedAiConfig(config, {
    fallbackProfiles: defaultAiConfig(rootDir, secretProvider).profiles,
  });
}

export function getAiConfig({ rootDir = process.cwd(), secretProvider } = {}) {
  return normalizeAiConfig(secretProvider?.getAiConfig?.(), { rootDir, secretProvider });
}

export { embeddingDimensions, embeddingSpaceId };

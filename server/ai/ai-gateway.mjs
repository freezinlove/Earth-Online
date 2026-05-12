import path from "node:path";
import { deterministicVector } from "../domain/vectors.mjs";
import { embeddingDimensions, embeddingSpaceId, getAiConfig } from "./ai-config.mjs";
import { getAiProvider, listAiProviders } from "./provider-registry.mjs";

function normalizeLocale(locale) {
  return locale === "en" ? "en" : "zh";
}

function inferTags(fileName, preset, locale = "zh") {
  const lower = fileName.toLowerCase();
  const sceneTags = [];
  const english = normalizeLocale(locale) === "en";
  if (/night|夜|evening|dusk|sunset|黄昏|日落/.test(lower)) sceneTags.push(...(english ? ["Night", "Sunset"] : ["夜景", "日落"]));
  if (/food|meal|cafe|餐|饭|coffee/.test(lower)) sceneTags.push(...(english ? ["Food", "Cafe"] : ["美食", "餐厅"]));
  if (/sea|beach|lake|海|湖|river/.test(lower)) sceneTags.push(english ? "Waterfront" : "海边");
  if (/temple|shrine|church|寺|社/.test(lower)) sceneTags.push(...(english ? ["Temple", "Architecture"] : ["寺庙", "建筑"]));
  if (/rain|雨/.test(lower)) sceneTags.push(english ? "Rainy day" : "雨天");
  if (/road|street|街|路/.test(lower)) sceneTags.push(english ? "Street" : "街道");
  if (/mountain|snow|山|雪/.test(lower)) sceneTags.push(...(english ? ["Mountain", "Snow"] : ["山", "雪景"]));
  return Array.from(new Set([...(preset?.tags ?? []), ...sceneTags])).slice(0, 8);
}

function fallbackPhotoAnalysis({ fileName, preset, locale = "zh" }) {
  const english = normalizeLocale(locale) === "en";
  const fallbackTags = inferTags(fileName, preset, locale);
  const fallbackTitle = english
    ? preset?.city && !preset.city.includes("待确认")
      ? `${preset.city} memory`
      : path.basename(fileName, path.extname(fileName))
    : preset?.city && !preset.city.includes("待确认")
      ? `${preset.city}记忆`
      : path.basename(fileName, path.extname(fileName));
  const fallbackCaption = english
    ? `A travel photo near ${preset?.city ?? "an unknown place"}; cloud AI can refine the scene details later.`
    : `${preset?.city ?? "未知地点"}附近的旅行照片，系统已根据 GPS/文件名生成「${fallbackTags.slice(0, 3).join(" / ")}」等搜索标签，画面细节需要云端 AI 进一步确认。`;

  return {
    provider: "qwen-mock",
    promptId: "photo-analysis",
    promptVersion: "1.0.0",
    title: fallbackTitle,
    tags: fallbackTags,
    caption: fallbackCaption,
    visiblePlaceNames: [],
    locationCandidates: [],
    uncertainties: [],
    embedding: deterministicVector([fileName, fallbackCaption, ...fallbackTags].join(" ")),
    embeddingProvider: "deterministic",
    embeddingDimension: 64,
    fallbackReason: undefined,
  };
}

function mergeVisionWithFallback(vision, fallback, providerId) {
  return {
    provider: vision.provider ?? providerId,
    model: vision.model,
    promptId: vision.promptId,
    promptVersion: vision.promptVersion,
    title: vision.title || fallback.title,
    tags: vision.tags,
    caption: vision.caption,
    visiblePlaceNames: vision.visiblePlaceNames,
    locationCandidates: vision.locationCandidates,
    uncertainties: vision.uncertainties,
    fallbackReason: undefined,
  };
}

function embeddingText({ fileName, title, caption, tags = [], visiblePlaceNames = [] }) {
  return [fileName, title, caption, ...tags, ...visiblePlaceNames].filter(Boolean).join(" ");
}

function withoutEmbeddingFields(analysis) {
  const result = { ...analysis };
  delete result.embedding;
  delete result.embeddingProvider;
  delete result.embeddingDimension;
  return result;
}

function friendlyAiError(error, fallback = "AI provider failed", locale = "zh") {
  const message = error instanceof Error ? error.message : String(error || fallback);
  const name = error instanceof Error ? error.name : "";
  if (/abort|timeout/i.test(`${name} ${message}`)) return normalizeLocale(locale) === "en" ? "AI request timed out. Retrying later usually recovers." : "AI 请求超时，稍后重试通常可恢复。";
  return message || fallback;
}

export { listAiProviders };

function profileConfig(rootDir, secretProvider, profileId) {
  return getAiConfig({ rootDir, secretProvider }).profiles[profileId];
}

function profileSecretProvider(secretProvider, profileId, providerId) {
  if (!secretProvider) return secretProvider;
  return {
    ...secretProvider,
    get(key) {
      return secretProvider.getProfileApiKey?.(profileId, providerId) ?? secretProvider.get?.(key);
    },
  };
}

export async function analyzeTravelImageVision({
  rootDir = process.cwd(),
  secretProvider,
  imageAnalysisProviderId,
  fileName,
  mime,
  dataUrl,
  preset,
  geoContext,
  allowCloud = true,
  locale = "zh",
}) {
  const normalizedLocale = normalizeLocale(locale);
  const fallback = fallbackPhotoAnalysis({ fileName, preset, locale: normalizedLocale });

  if (!allowCloud) {
    return withoutEmbeddingFields(fallback);
  }
  try {
    const profile = profileConfig(rootDir, secretProvider, "imageUnderstanding");
    const imageProvider = getAiProvider("imageUnderstanding", imageAnalysisProviderId ?? profile.providerId);
    if (!imageProvider) throw new Error("no image analysis provider configured");
    const providerSecretProvider = profileSecretProvider(secretProvider, "imageUnderstanding", imageProvider.id);

    const vision = await imageProvider.analyzeImage({ rootDir, secretProvider: providerSecretProvider, fileName, mime, dataUrl, preset, geoContext, locale: normalizedLocale, modelId: profile.modelId });
    return mergeVisionWithFallback(vision, fallback, imageProvider.id);
  } catch (error) {
    const visionFallback = withoutEmbeddingFields(fallback);
    return {
      ...visionFallback,
      fallbackReason: friendlyAiError(error, "AI provider failed", normalizedLocale),
    };
  }
}

export async function embedTravelImageAnalysis({
  rootDir = process.cwd(),
  secretProvider,
  embeddingProviderId,
  fileName,
  analysis,
  allowCloud = true,
  locale = "zh",
}) {
  const text = embeddingText({ fileName, ...analysis });
  if (allowCloud) {
    try {
      const profile = profileConfig(rootDir, secretProvider, "crossModalEmbedding");
      if (!profile.enabled) {
        return {
          embedding: undefined,
          embeddingProvider: undefined,
          embeddingModel: undefined,
          embeddingSpaceId: undefined,
          embeddingDimension: undefined,
          embeddingMode: "disabled",
          embeddingFallbackReason: undefined,
        };
      }
      const embeddingProvider = getAiProvider("crossModalEmbedding", embeddingProviderId ?? profile.providerId);
      if (!embeddingProvider) throw new Error("no embedding provider configured");
      const providerSecretProvider = profileSecretProvider(secretProvider, "crossModalEmbedding", embeddingProvider.id);
      const result = await embeddingProvider.embed({ rootDir, secretProvider: providerSecretProvider, fileName, text, modelId: profile.modelId, dimensions: embeddingDimensions(profile) });
      if (!Array.isArray(result.embedding)) throw new Error("embedding unavailable");

      return {
        embedding: result.embedding,
        embeddingProvider: result.embeddingProvider,
        embeddingModel: result.embeddingModel ?? profile.modelId,
        embeddingSpaceId: embeddingSpaceId(profile),
        embeddingDimension: result.embedding.length,
        embeddingMode: "cross_modal",
        embeddingFallbackReason: undefined,
      };
    } catch (error) {
      return {
        embedding: undefined,
        embeddingProvider: undefined,
        embeddingModel: undefined,
        embeddingSpaceId: undefined,
        embeddingDimension: undefined,
        embeddingMode: "failed",
        embeddingFallbackReason: friendlyAiError(error, "embedding provider failed", locale),
      };
    }
  }
  return {
    embedding: undefined,
    embeddingProvider: undefined,
    embeddingModel: undefined,
    embeddingSpaceId: undefined,
    embeddingDimension: undefined,
    embeddingMode: "disabled",
    embeddingFallbackReason: undefined,
  };
}

export async function embedTravelImageImage({
  rootDir = process.cwd(),
  secretProvider,
  embeddingProviderId,
  fileName,
  dataUrl,
  allowCloud = true,
}) {
  if (allowCloud) {
    try {
      const profile = profileConfig(rootDir, secretProvider, "crossModalEmbedding");
      if (!profile.enabled) {
        return {
          embedding: undefined,
          embeddingProvider: undefined,
          embeddingModel: undefined,
          embeddingSpaceId: undefined,
          embeddingDimension: undefined,
          embeddingMode: "disabled",
          embeddingFallbackReason: undefined,
        };
      }
      const embeddingProvider = getAiProvider("crossModalEmbedding", embeddingProviderId ?? profile.providerId);
      if (!embeddingProvider) throw new Error("no embedding provider configured");
      const providerSecretProvider = profileSecretProvider(secretProvider, "crossModalEmbedding", embeddingProvider.id);
      const result = await embeddingProvider.embed({ rootDir, secretProvider: providerSecretProvider, fileName, dataUrl, modelId: profile.modelId, dimensions: embeddingDimensions(profile) });
      if (!Array.isArray(result.embedding)) throw new Error("embedding unavailable");

      return {
        embedding: result.embedding,
        embeddingProvider: result.embeddingProvider,
        embeddingModel: result.embeddingModel ?? profile.modelId,
        embeddingSpaceId: embeddingSpaceId(profile),
        embeddingDimension: result.embedding.length,
        embeddingMode: "cross_modal",
        embeddingFallbackReason: undefined,
      };
    } catch (error) {
      return {
        embedding: undefined,
        embeddingProvider: undefined,
        embeddingModel: undefined,
        embeddingSpaceId: undefined,
        embeddingDimension: undefined,
        embeddingMode: "failed",
        embeddingFallbackReason: friendlyAiError(error, "image embedding provider failed"),
      };
    }
  }
  return {
    embedding: undefined,
    embeddingProvider: undefined,
    embeddingModel: undefined,
    embeddingSpaceId: undefined,
    embeddingDimension: undefined,
    embeddingMode: "disabled",
    embeddingFallbackReason: undefined,
  };
}

export async function analyzeTravelImage(input) {
  const analysis = await analyzeTravelImageVision(input);
  const embedding = await embedTravelImageImage(input);
  return { ...analysis, ...embedding };
}

export async function inferMissingInfoWithImage({
  rootDir = process.cwd(),
  secretProvider,
  missingInfoInferenceProviderId,
  dataUrl,
  mime,
  inferenceInput,
  allowCloud = true,
  locale = "zh",
}) {
  const normalizedLocale = normalizeLocale(locale);
  if (!allowCloud) {
    return {
      action: "keep_pending",
      confidence: 0,
      reason: normalizedLocale === "en" ? "Cloud AI is disabled, so context inference cannot run." : "云端 AI 未启用，无法执行当前照片的基于上下文推断。",
      provider: "mock",
      promptId: "missing-info-inference",
      promptVersion: "fallback",
    };
  }
  try {
    const profile = profileConfig(rootDir, secretProvider, "imageUnderstanding");
    const provider = getAiProvider("imageUnderstanding", missingInfoInferenceProviderId ?? profile.providerId);
    if (!provider) throw new Error("no missing info inference provider configured");
    const providerSecretProvider = profileSecretProvider(secretProvider, "imageUnderstanding", provider.id);
    return await provider.inferMissingInfo({ rootDir, secretProvider: providerSecretProvider, dataUrl, mime, inferenceInput, locale: normalizedLocale, modelId: profile.modelId });
  } catch (error) {
    return {
      action: "keep_pending",
      confidence: 0,
      reason: friendlyAiError(error, normalizedLocale === "en" ? "Context inference failed." : "基于上下文推断失败。", normalizedLocale),
      provider: "mock",
      promptId: "missing-info-inference",
      promptVersion: "fallback",
    };
  }
}

export async function embedSearchQuery(query, { rootDir = process.cwd(), allowCloud = true, secretProvider, embeddingProviderId } = {}) {
  if (allowCloud) {
    try {
      const profile = profileConfig(rootDir, secretProvider, "crossModalEmbedding");
      if (!profile.enabled) return { embedding: deterministicVector(query), embeddingMode: "disabled" };
      const embeddingProvider = getAiProvider("crossModalEmbedding", embeddingProviderId ?? profile.providerId);
      if (!embeddingProvider) throw new Error("no embedding provider configured");
      const providerSecretProvider = profileSecretProvider(secretProvider, "crossModalEmbedding", embeddingProvider.id);
      const result = await embeddingProvider.embed({ rootDir, secretProvider: providerSecretProvider, fileName: "search-query", text: query, modelId: profile.modelId, dimensions: embeddingDimensions(profile) });
      return {
        embedding: result.embedding,
        embeddingProvider: result.embeddingProvider,
        embeddingModel: result.embeddingModel ?? profile.modelId,
        embeddingSpaceId: embeddingSpaceId(profile),
        embeddingMode: "cross_modal",
      };
    } catch {
      // fall back below
    }
  }
  return { embedding: deterministicVector(query), embeddingMode: "disabled" };
}

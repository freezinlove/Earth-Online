import path from "node:path";
import { deterministicVector } from "../domain/vectors.mjs";
import { getAiProvider, listAiProviders } from "./provider-registry.mjs";

function inferTags(fileName, preset) {
  const lower = fileName.toLowerCase();
  const sceneTags = [];
  if (/night|夜|evening|dusk|sunset|黄昏|日落/.test(lower)) sceneTags.push("夜景", "日落");
  if (/food|meal|cafe|餐|饭|coffee/.test(lower)) sceneTags.push("美食", "餐厅");
  if (/sea|beach|lake|海|湖|river/.test(lower)) sceneTags.push("海边");
  if (/temple|shrine|church|寺|社/.test(lower)) sceneTags.push("寺庙", "建筑");
  if (/rain|雨/.test(lower)) sceneTags.push("雨天");
  if (/road|street|街|路/.test(lower)) sceneTags.push("街道");
  if (/mountain|snow|山|雪/.test(lower)) sceneTags.push("山", "雪景");
  return Array.from(new Set([...(preset?.tags ?? []), ...sceneTags])).slice(0, 8);
}

function fallbackPhotoAnalysis({ fileName, preset }) {
  const fallbackTags = inferTags(fileName, preset);
  const fallbackTitle = preset?.city && !preset.city.includes("待确认") ? `${preset.city}记忆` : path.basename(fileName, path.extname(fileName));
  const fallbackCaption = `${preset?.city ?? "未知地点"}附近的旅行照片，系统已根据 GPS/文件名生成「${fallbackTags.slice(0, 3).join(" / ")}」等搜索标签，画面细节需要云端 AI 进一步确认。`;

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

function friendlyAiError(error, fallback = "AI provider failed") {
  const message = error instanceof Error ? error.message : String(error || fallback);
  const name = error instanceof Error ? error.name : "";
  if (/abort|timeout/i.test(`${name} ${message}`)) return "AI 请求超时，稍后重试通常可恢复。";
  return message || fallback;
}

export { listAiProviders };

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
}) {
  const fallback = fallbackPhotoAnalysis({ fileName, preset });

  if (!allowCloud) {
    return withoutEmbeddingFields(fallback);
  }
  try {
    const imageProvider = getAiProvider("imageAnalysis", imageAnalysisProviderId);
    if (!imageProvider) throw new Error("no image analysis provider configured");

    const vision = await imageProvider.analyzeImage({ rootDir, secretProvider, fileName, mime, dataUrl, preset, geoContext });
    return mergeVisionWithFallback(vision, fallback, imageProvider.id);
  } catch (error) {
    const visionFallback = withoutEmbeddingFields(fallback);
    return {
      ...visionFallback,
      fallbackReason: friendlyAiError(error),
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
}) {
  const text = embeddingText({ fileName, ...analysis });
  if (allowCloud) {
    try {
      const embeddingProvider = getAiProvider("embedding", embeddingProviderId);
      if (!embeddingProvider) throw new Error("no embedding provider configured");
      const result = await embeddingProvider.embed({ rootDir, secretProvider, fileName, text });
      if (!Array.isArray(result.embedding)) throw new Error("embedding unavailable");

      return {
        embedding: result.embedding,
        embeddingProvider: result.embeddingProvider,
        embeddingDimension: result.embedding.length,
        embeddingFallbackReason: undefined,
      };
    } catch (error) {
      const embedding = deterministicVector(text);
      return {
        embedding,
        embeddingProvider: "deterministic",
        embeddingDimension: embedding.length,
        embeddingFallbackReason: friendlyAiError(error, "embedding provider failed"),
      };
    }
  }
  const embedding = deterministicVector(text);
  return {
    embedding,
    embeddingProvider: "deterministic",
    embeddingDimension: embedding.length,
    embeddingFallbackReason: allowCloud ? "embedding provider failed" : undefined,
  };
}

export async function embedTravelImageImage({
  rootDir = process.cwd(),
  secretProvider,
  embeddingProviderId,
  fileName,
  mime,
  dataUrl,
  allowCloud = true,
}) {
  const fallbackText = [fileName, mime].filter(Boolean).join(" ");
  if (allowCloud) {
    try {
      const embeddingProvider = getAiProvider("embedding", embeddingProviderId);
      if (!embeddingProvider) throw new Error("no embedding provider configured");
      const result = await embeddingProvider.embed({ rootDir, secretProvider, fileName, dataUrl });
      if (!Array.isArray(result.embedding)) throw new Error("embedding unavailable");

      return {
        embedding: result.embedding,
        embeddingProvider: result.embeddingProvider,
        embeddingDimension: result.embedding.length,
        embeddingFallbackReason: undefined,
      };
    } catch (error) {
      const embedding = deterministicVector(fallbackText);
      return {
        embedding,
        embeddingProvider: "deterministic",
        embeddingDimension: embedding.length,
        embeddingFallbackReason: friendlyAiError(error, "image embedding provider failed"),
      };
    }
  }
  const embedding = deterministicVector(fallbackText);
  return {
    embedding,
    embeddingProvider: "deterministic",
    embeddingDimension: embedding.length,
    embeddingFallbackReason: allowCloud ? "image embedding provider failed" : undefined,
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
}) {
  if (!allowCloud) {
    return {
      action: "keep_pending",
      confidence: 0,
      reason: "云端 AI 未启用，无法执行当前照片二次视觉推断。",
      provider: "mock",
      promptId: "missing-info-inference",
      promptVersion: "fallback",
    };
  }
  try {
    const provider = getAiProvider("missingInfoInference", missingInfoInferenceProviderId);
    if (!provider) throw new Error("no missing info inference provider configured");
    return await provider.inferMissingInfo({ rootDir, secretProvider, dataUrl, mime, inferenceInput });
  } catch (error) {
    return {
      action: "keep_pending",
      confidence: 0,
      reason: friendlyAiError(error, "AI 二次推断失败。"),
      provider: "mock",
      promptId: "missing-info-inference",
      promptVersion: "fallback",
    };
  }
}

export async function embedSearchQuery(query, { rootDir = process.cwd(), allowCloud = true, secretProvider, embeddingProviderId } = {}) {
  if (allowCloud) {
    try {
      const embeddingProvider = getAiProvider("embedding", embeddingProviderId);
      if (!embeddingProvider) throw new Error("no embedding provider configured");
      const result = await embeddingProvider.embed({ rootDir, secretProvider, fileName: "search-query", text: query });
      return result.embedding;
    } catch {
      // fall back below
    }
  }
  return deterministicVector(query);
}

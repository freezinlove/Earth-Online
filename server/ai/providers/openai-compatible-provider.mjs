import { collectRequestIds, emitAiDebugRecord } from "../ai-debug.mjs";
import { readProviderApiKey } from "../embedding-service.mjs";
import { loadPrompt } from "../prompt-registry.mjs";
import { analyzePhotoWithProviderCore, embedContentWithProvider, inferMissingInfoWithProviderCore } from "../../../shared/ai/provider-runtime.mjs";

async function emitProviderDebugRecord(record) {
  const { json, ...debugRecord } = record;
  await emitAiDebugRecord({
    ...debugRecord,
    requestIds: collectRequestIds({ headers: debugRecord.headers, json }),
  });
}

export function createOpenAiCompatibleProvider({
  id,
  displayName,
  baseUrl,
  referer,
  title,
  supportsEmbedding = false,
  supportsImageUnderstanding = true,
}) {
  const headers = {};
  if (referer) headers["HTTP-Referer"] = referer;
  if (title) headers["X-Title"] = title;
  return {
    id,
    displayName,
    capabilities: {
      imageUnderstanding: supportsImageUnderstanding,
      crossModalEmbedding: supportsEmbedding,
      imageAnalysis: supportsImageUnderstanding,
      missingInfoInference: supportsImageUnderstanding,
      embedding: supportsEmbedding,
    },
    async analyzeImage({ rootDir, secretProvider, fileName, mime, dataUrl, preset, geoContext, locale, modelId }) {
      const prompt = await loadPrompt("photoAnalysis", locale);
      const apiKey = readProviderApiKey(id, rootDir, secretProvider);
      return analyzePhotoWithProviderCore({
        providerId: id,
        apiKey,
        baseUrl,
        modelId,
        headers,
        prompt,
        fileName,
        mime,
        dataUrl,
        preset,
        geoContext,
        locale: prompt.locale,
        debugContext: {
          providerId: id,
          operation: "photoAnalysis",
          capability: "imageUnderstanding",
          fileName,
          promptId: prompt.id,
          promptVersion: prompt.version,
          locale: prompt.locale,
        },
        onDebugRecord: emitProviderDebugRecord,
      });
    },
    async inferMissingInfo({ rootDir, secretProvider, dataUrl, mime, inferenceInput, locale, modelId }) {
      const prompt = await loadPrompt("missingInfoInference", locale);
      const apiKey = readProviderApiKey(id, rootDir, secretProvider);
      return inferMissingInfoWithProviderCore({
        providerId: id,
        apiKey,
        baseUrl,
        modelId,
        headers,
        prompt,
        dataUrl,
        mime,
        inferenceInput,
        locale: prompt.locale,
        debugContext: {
          providerId: id,
          operation: "missingInfoInference",
          capability: "imageUnderstanding",
          fileName: inferenceInput?.targetPhoto?.fileName,
          promptId: prompt.id,
          promptVersion: prompt.version,
          locale: prompt.locale,
        },
        onDebugRecord: emitProviderDebugRecord,
      });
    },
    async embed({ rootDir, secretProvider, fileName, dataUrl, text, modelId, dimensions }) {
      const apiKey = readProviderApiKey(id, rootDir, secretProvider);
      const result = await embedContentWithProvider({
        profile: { enabled: true, providerId: id, modelId, modelSource: "custom" },
        apiKey,
        baseUrl,
        headers,
        fileName,
        dataUrl,
        text,
        dimensions,
      });
      if (!result) throw new Error("embedding unavailable");
      return result;
    },
  };
}

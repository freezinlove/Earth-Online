import { collectRequestIds, emitAiDebugRecord } from "../ai-debug.mjs";
import { readQwenChatApiKey, readQwenEmbeddingApiKey } from "../embedding-service.mjs";
import { loadPrompt } from "../prompt-registry.mjs";
import { analyzePhotoWithProviderCore, chatCompletionsBaseUrl, embedContentWithProvider, inferMissingInfoWithProviderCore } from "../../../shared/ai/provider-runtime.mjs";

async function emitProviderDebugRecord(record) {
  const { json, ...debugRecord } = record;
  await emitAiDebugRecord({
    ...debugRecord,
    requestIds: collectRequestIds({ headers: debugRecord.headers, json }),
  });
}

export const qwenProvider = {
  id: "qwen",
  displayName: "阿里 Qwen",
  capabilities: {
    imageUnderstanding: true,
    crossModalEmbedding: true,
    imageAnalysis: true,
    missingInfoInference: true,
    embedding: true,
  },
  async analyzeImage({ rootDir, secretProvider, fileName, mime, dataUrl, preset, geoContext, locale, modelId }) {
    const prompt = await loadPrompt("photoAnalysis", locale);
    const apiKey = readQwenChatApiKey(rootDir, secretProvider);
    const providerId = this.id;
    return analyzePhotoWithProviderCore({
      providerId,
      apiKey,
      baseUrl: chatCompletionsBaseUrl(providerId),
      modelId,
      prompt,
      fileName,
      mime,
      dataUrl,
      preset,
      geoContext,
      locale: prompt.locale,
      debugContext: {
        providerId,
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
    const apiKey = readQwenChatApiKey(rootDir, secretProvider);
    const providerId = this.id;
    return inferMissingInfoWithProviderCore({
      providerId,
      apiKey,
      baseUrl: chatCompletionsBaseUrl(providerId),
      modelId,
      prompt,
      dataUrl,
      mime,
      inferenceInput,
      locale: prompt.locale,
      debugContext: {
        providerId,
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
    const apiKey = readQwenEmbeddingApiKey(rootDir, secretProvider);
    const result = await embedContentWithProvider({
      profile: { enabled: true, providerId: this.id, modelId, modelSource: "custom" },
      apiKey,
      fileName,
      dataUrl,
      text,
      dimensions,
    });
    if (!result) throw new Error("embedding unavailable");
    return result;
  },
};

export const aliyunProvider = {
  ...qwenProvider,
  id: "aliyun",
  displayName: "阿里百炼",
};

import { validateMissingInfoInferenceResult, validatePhotoAnalysisResult } from "../ai-schemas.mjs";
import { readQwenChatApiKey, readQwenEmbeddingApiKey } from "../embedding-service.mjs";
import { loadPrompt } from "../prompt-registry.mjs";
import { qwenChatCompletion, qwenMultimodalEmbedding } from "../qwen-client.mjs";
import { parseJsonObject } from "../../../shared/ai/provider-runtime.mjs";

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
    const content = await qwenChatCompletion({
      rootDir,
      apiKey,
      model: modelId,
      debugContext: {
        providerId: this.id,
        operation: "photoAnalysis",
        capability: "imageUnderstanding",
        fileName,
        promptId: prompt.id,
        promptVersion: prompt.version,
        locale: prompt.locale,
      },
      messages: [
        {
          role: "system",
          content: prompt.content,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                exif: geoContext ?? { hasGps: false, cityHint: preset?.city ?? "待确认", countryHint: preset?.country ?? "待确认" },
              }),
            },
            { type: "image_url", image_url: { url: dataUrl || `data:${mime};base64,` } },
          ],
        },
      ],
    });
    const parsed = parseJsonObject(typeof content === "string" ? content : JSON.stringify(content));
    return {
      ...validatePhotoAnalysisResult(parsed, prompt.locale === "en" ? undefined : preset, { locale: prompt.locale }),
      provider: this.id,
      model: modelId,
      promptId: prompt.id,
      promptVersion: prompt.version,
    };
  },
  async inferMissingInfo({ rootDir, secretProvider, dataUrl, mime, inferenceInput, locale, modelId }) {
    const prompt = await loadPrompt("missingInfoInference", locale);
    const apiKey = readQwenChatApiKey(rootDir, secretProvider);
    const userInstruction =
      prompt.locale === "en"
        ? "Use the current missing-GPS photo image and the strictly sectioned JSON data below. Output one second-pass missing-information inference JSON."
        : "请根据当前待补照片图像和下方严格分区的 JSON 数据，输出一个待补信息二次推断 JSON。";
    const content = await qwenChatCompletion({
      rootDir,
      apiKey,
      model: modelId,
      temperature: 0.1,
      debugContext: {
        providerId: this.id,
        operation: "missingInfoInference",
        capability: "imageUnderstanding",
        fileName: inferenceInput?.targetPhoto?.fileName,
        promptId: prompt.id,
        promptVersion: prompt.version,
        locale: prompt.locale,
      },
      messages: [
        {
          role: "system",
          content: prompt.content,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                userInstruction,
                JSON.stringify(inferenceInput),
              ].join("\n\n"),
            },
            { type: "image_url", image_url: { url: dataUrl || `data:${mime};base64,` } },
          ],
        },
      ],
    });
    const parsed = parseJsonObject(typeof content === "string" ? content : JSON.stringify(content));
    return {
      ...validateMissingInfoInferenceResult(parsed, { locale: prompt.locale }),
      provider: this.id,
      model: modelId,
      promptId: prompt.id,
      promptVersion: prompt.version,
    };
  },
  async embed({ rootDir, secretProvider, fileName, dataUrl, text, modelId, dimensions }) {
    const apiKey = readQwenEmbeddingApiKey(rootDir, secretProvider);
    const embedding = await qwenMultimodalEmbedding({ apiKey, rootDir, model: modelId, fileName, dataUrl, text, dimension: dimensions });
    return {
      embedding,
      embeddingProvider: this.id,
      embeddingModel: modelId,
    };
  },
};

export const aliyunProvider = {
  ...qwenProvider,
  id: "aliyun",
  displayName: "阿里百炼",
};

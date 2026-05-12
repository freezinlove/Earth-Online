import { validateMissingInfoInferenceResult, validatePhotoAnalysisResult } from "../ai-schemas.mjs";
import { readProviderApiKey } from "../embedding-service.mjs";
import { openAiCompatibleChatCompletion, openAiCompatibleEmbedding } from "../openai-compatible-client.mjs";
import { loadPrompt } from "../prompt-registry.mjs";

function parseJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  } catch {
    // Extract below.
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}

export function createOpenAiCompatibleProvider({
  id,
  displayName,
  baseUrl,
  referer,
  title,
  supportsEmbedding = false,
  supportsImageUnderstanding = true,
  embeddingInput,
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
    async analyzeImage({ rootDir, secretProvider, mime, dataUrl, preset, geoContext, locale, modelId }) {
      const prompt = await loadPrompt("photoAnalysis", locale);
      const apiKey = readProviderApiKey(id, rootDir, secretProvider);
      const content = await openAiCompatibleChatCompletion({
        rootDir,
        apiKey,
        baseUrl,
        model: modelId,
        headers,
        messages: [
          { role: "system", content: prompt.content },
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
      const parsed = parseJsonObject(content);
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
      const apiKey = readProviderApiKey(id, rootDir, secretProvider);
      const userInstruction =
        prompt.locale === "en"
          ? "Use the current missing-GPS photo image and the strictly sectioned JSON data below. Output one second-pass missing-information inference JSON."
          : "请根据当前待补照片图像和下方严格分区的 JSON 数据，输出一个待补信息二次推断 JSON。";
      const content = await openAiCompatibleChatCompletion({
        rootDir,
        apiKey,
        baseUrl,
        model: modelId,
        temperature: 0.1,
        headers,
        messages: [
          { role: "system", content: prompt.content },
          {
            role: "user",
            content: [
              { type: "text", text: [userInstruction, JSON.stringify(inferenceInput)].join("\n\n") },
              { type: "image_url", image_url: { url: dataUrl || `data:${mime};base64,` } },
            ],
          },
        ],
      });
      const parsed = parseJsonObject(content);
      return {
        ...validateMissingInfoInferenceResult(parsed, { locale: prompt.locale }),
        provider: this.id,
        model: modelId,
        promptId: prompt.id,
        promptVersion: prompt.version,
      };
    },
    async embed({ rootDir, secretProvider, dataUrl, text, modelId, dimensions }) {
      const apiKey = readProviderApiKey(id, rootDir, secretProvider);
      const input = embeddingInput ? embeddingInput({ dataUrl, text }) : dataUrl || text;
      const embedding = await openAiCompatibleEmbedding({ rootDir, apiKey, baseUrl, model: modelId, input, dimensions, headers });
      return {
        embedding,
        embeddingProvider: this.id,
        embeddingModel: modelId,
      };
    },
  };
}

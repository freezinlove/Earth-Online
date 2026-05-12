import { validateMissingInfoInferenceResult, validatePhotoAnalysisResult } from "../ai-schemas.mjs";
import { readQwenChatApiKey, readQwenEmbeddingApiKey } from "../embedding-service.mjs";
import { loadPrompt } from "../prompt-registry.mjs";
import { qwenChatCompletion, qwenMultimodalEmbedding } from "../qwen-client.mjs";

function parseJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
    if (Array.isArray(direct)) return direct.find((item) => item && typeof item === "object" && !Array.isArray(item));
  } catch {
    // Fall through to extracting the first balanced object from wrapped text.
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return undefined;
  }
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
  async analyzeImage({ rootDir, secretProvider, mime, dataUrl, preset, geoContext, locale, modelId }) {
    const prompt = await loadPrompt("photoAnalysis", locale);
    const apiKey = readQwenChatApiKey(rootDir, secretProvider);
    const content = await qwenChatCompletion({
      rootDir,
      apiKey,
      model: modelId,
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

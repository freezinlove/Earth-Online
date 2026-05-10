import { validateMissingInfoInferenceResult, validatePhotoAnalysisResult } from "../ai-schemas.mjs";
import { readQwenChatApiKey, readQwenEmbeddingApiKey } from "../embedding-service.mjs";
import { loadPrompt } from "../prompt-registry.mjs";
import { qwenChatCompletion, qwenMultimodalEmbedding } from "../qwen-client.mjs";

function parseJsonObject(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}

export const qwenProvider = {
  id: "qwen",
  displayName: "阿里 Qwen",
  capabilities: {
    imageAnalysis: true,
    missingInfoInference: true,
    embedding: true,
  },
  async analyzeImage({ rootDir, secretProvider, mime, dataUrl, preset, geoContext }) {
    const prompt = await loadPrompt("photoAnalysis");
    const apiKey = readQwenChatApiKey(rootDir, secretProvider);
    const content = await qwenChatCompletion({
      rootDir,
      apiKey,
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
      ...validatePhotoAnalysisResult(parsed, preset),
      provider: this.id,
      promptId: prompt.id,
      promptVersion: prompt.version,
    };
  },
  async inferMissingInfo({ rootDir, secretProvider, dataUrl, mime, inferenceInput }) {
    const prompt = await loadPrompt("missingInfoInference");
    const apiKey = readQwenChatApiKey(rootDir, secretProvider);
    const content = await qwenChatCompletion({
      rootDir,
      apiKey,
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
                "请根据当前待补照片图像和下方严格分区的 JSON 数据，输出一个待补信息二次推断 JSON。",
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
      ...validateMissingInfoInferenceResult(parsed),
      provider: this.id,
      promptId: prompt.id,
      promptVersion: prompt.version,
    };
  },
  async embed({ rootDir, secretProvider, fileName, dataUrl, text }) {
    const apiKey = readQwenEmbeddingApiKey(rootDir, secretProvider);
    const embedding = await qwenMultimodalEmbedding({ apiKey, rootDir, fileName, dataUrl, text });
    return {
      embedding,
      embeddingProvider: this.id,
    };
  },
};

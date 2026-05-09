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
  async analyzeImage({ rootDir, secretProvider, fileName, mime, dataUrl, preset, geoContext }) {
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
              text: [
                `分析这张旅行照片，文件名：${fileName}。`,
                `EXIF/GPS 地理上下文：${JSON.stringify(geoContext ?? { cityHint: preset?.city ?? "未知" })}。`,
                "请给这张照片起一个简短中文名，并给出 6-10 个中文搜索标签。标签要具体，例如「哈尔施塔特湖畔」「布达佩斯多瑙河」「维也纳街景」「查理大桥」「山间湖泊」「教堂内景」「咖啡馆甜点」「蓝天积云」。",
                "如果 GPS 城市候选和画面明显冲突，可以保留画面判断，但不要把一个城市标签强行套到另一座城市；caption 里可以写“GPS 位于某地附近”。",
              ].join("\n"),
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
                "注意：neighborContext 只是参考，不能覆盖 currentPhoto 图像证据。",
                JSON.stringify(inferenceInput, null, 2),
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

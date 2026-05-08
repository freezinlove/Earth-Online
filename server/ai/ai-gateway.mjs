import path from "node:path";
import { deterministicVector } from "../domain/vectors.mjs";
import { validatePhotoAnalysisResult } from "./ai-schemas.mjs";
import { embedPhotoEvidence, embedSearchQuery, readProvidedApiKey } from "./embedding-service.mjs";
import { loadPrompt } from "./prompt-registry.mjs";
import { qwenChatCompletion } from "./qwen-client.mjs";

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

function parseJsonObject(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}

async function chatAnalyzeImage({ rootDir, apiKey, fileName, mime, dataUrl, preset, geoContext }) {
  const prompt = await loadPrompt("photoAnalysis");
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
    promptId: prompt.id,
    promptVersion: prompt.version,
  };
}

export async function analyzeTravelImage({ rootDir = process.cwd(), fileName, mime, dataUrl, preset, geoContext, allowCloud = true }) {
  const fallbackTags = inferTags(fileName, preset);
  const fallbackTitle = preset?.city && !preset.city.includes("待确认") ? `${preset.city}记忆` : path.basename(fileName, path.extname(fileName));
  const fallbackCaption = `${preset?.city ?? "未知地点"}附近的旅行照片，系统已根据 GPS/文件名生成「${fallbackTags.slice(0, 3).join(" / ")}」等搜索标签，画面细节需要云端 AI 进一步确认。`;
  const fallback = {
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

  if (!allowCloud) return fallback;
  try {
    const apiKey = readProvidedApiKey(rootDir);
    const vision = await chatAnalyzeImage({ rootDir, apiKey, fileName, mime, dataUrl, preset, geoContext });
    const text = [vision.caption, ...vision.tags].join(" ");
    const { embedding, embeddingProvider } = await embedPhotoEvidence({ rootDir, apiKey, fileName, dataUrl, text });
    return {
      provider: "qwen",
      promptId: vision.promptId,
      promptVersion: vision.promptVersion,
      title: vision.title || fallbackTitle,
      tags: vision.tags,
      caption: vision.caption,
      visiblePlaceNames: vision.visiblePlaceNames,
      locationCandidates: vision.locationCandidates,
      uncertainties: vision.uncertainties,
      embedding,
      embeddingProvider,
      embeddingDimension: embedding.length,
      fallbackReason: undefined,
    };
  } catch (error) {
    return {
      ...fallback,
      fallbackReason: error instanceof Error ? error.message : "qwen provider failed",
    };
  }
}

export { embedSearchQuery };

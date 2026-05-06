import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function readDotEnv(rootDir) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return {};
  const entries = {};
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    entries[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return entries;
}

function envValue(rootDir, key, fallback) {
  return process.env[key] ?? readDotEnv(rootDir)[key] ?? fallback;
}

const qwenCompatibleBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

function deterministicVector(text) {
  const hash = createHash("sha256").update(text).digest();
  return Array.from({ length: 64 }, (_, index) => (hash[index % hash.length] / 255) * 2 - 1);
}

async function readProvidedApiKey(rootDir) {
  return envValue(rootDir, "QWEN_API_KEY");
}

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

function normalizeTags(tags, preset) {
  const generic = new Set(["欧洲", "旅行", "城市", "建筑", "自然风光", "户外摄影"]);
  const normalized = tags
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .filter((tag) => !generic.has(tag));
  const seeded = normalized.length >= 4 ? normalized : [...normalized, ...(preset?.tags ?? [])];
  return Array.from(new Set(seeded)).slice(0, 10);
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

async function chatAnalyzeImage({ apiKey, fileName, mime, dataUrl, preset, geoContext }) {
  if (!apiKey) throw new Error("missing Qwen API key");
  const rootDir = process.cwd();
  const qwenChatModel = envValue(rootDir, "QWEN_CHAT_MODEL", "qwen3.5-flash");
  const response = await fetch(`${qwenCompatibleBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: qwenChatModel,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是 Earth_Online 的旅行照片理解模块。只输出 JSON，字段为 title:string、tags:string[] 和 caption:string。title 是 6-14 个中文字符的照片名，像私人旅行相册标题，不要用文件名。不要做人脸身份识别，不要推断敏感身份。标签必须用于旅行照片检索，优先具体地点、地标、自然/街景/室内场景、可见物体和时间氛围；禁止只输出「欧洲」「旅行」「城市」「建筑」这类泛标签，除非和具体城市/地标/场景组合。",
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
      temperature: 0.2,
    }),
  });
  if (!response.ok) throw new Error(`qwen chat failed: ${response.status}`);
  const json = await response.json();
  const content = json.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonObject(typeof content === "string" ? content : JSON.stringify(content));
  if (!parsed?.caption || !Array.isArray(parsed.tags)) throw new Error("qwen chat returned unexpected content");
  return {
    title: String(parsed.title || "").trim().slice(0, 24) || undefined,
    tags: normalizeTags(parsed.tags, preset),
    caption: String(parsed.caption),
  };
}

async function qwenMultimodalEmbedding({ apiKey, fileName, dataUrl, text }) {
  if (!apiKey) throw new Error("missing Qwen API key");
  const rootDir = process.cwd();
  const qwenVisionEmbeddingModel = envValue(rootDir, "QWEN_VISION_EMBEDDING_MODEL", "tongyi-embedding-vision-flash-2026-03-06");
  const response = await fetch("https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: qwenVisionEmbeddingModel,
      input: {
        contents: [
          dataUrl
            ? { image: dataUrl }
            : {
                text: text || fileName,
              },
        ],
      },
      parameters: {},
    }),
  });
  if (!response.ok) throw new Error(`qwen embedding failed: ${response.status}`);
  const json = await response.json();
  const embedding = json.output?.embeddings?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error("qwen embedding returned unexpected content");
  return embedding.map(Number);
}

export async function analyzeTravelImage({ rootDir, fileName, mime, dataUrl, preset, geoContext, allowCloud = true }) {
  const fallbackTags = inferTags(fileName, preset);
  const fallbackTitle = preset?.city && !preset.city.includes("待确认") ? `${preset.city}记忆` : path.basename(fileName, path.extname(fileName));
  const fallbackCaption = `${preset?.city ?? "未知地点"}附近的旅行照片，系统已根据 GPS/文件名生成「${fallbackTags.slice(0, 3).join(" / ")}」等搜索标签，画面细节需要云端 AI 进一步确认。`;
  const fallback = {
    provider: "qwen-mock",
    title: fallbackTitle,
    tags: fallbackTags,
    caption: fallbackCaption,
    embedding: deterministicVector([fileName, fallbackCaption, ...fallbackTags].join(" ")),
    embeddingProvider: "deterministic",
    embeddingDimension: 64,
    fallbackReason: undefined,
  };

  if (!allowCloud) return fallback;
  try {
    const apiKey = await readProvidedApiKey(rootDir);
    const vision = await chatAnalyzeImage({ apiKey, fileName, mime, dataUrl, preset, geoContext });
    let embedding;
    let embeddingProvider = "qwen";
    try {
      embedding = await qwenMultimodalEmbedding({ apiKey, fileName, dataUrl, text: [vision.caption, ...vision.tags].join(" ") });
    } catch {
      embedding = deterministicVector([fileName, vision.caption, ...vision.tags].join(" "));
      embeddingProvider = "deterministic";
    }
    return {
      provider: "qwen",
      title: vision.title || fallbackTitle,
      tags: vision.tags,
      caption: vision.caption,
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

export async function embedSearchQuery(query, { rootDir, allowCloud = true } = {}) {
  if (allowCloud) {
    try {
      const apiKey = await readProvidedApiKey(rootDir);
      return await qwenMultimodalEmbedding({ apiKey, fileName: "search-query", text: query });
    } catch {
      // fall back below
    }
  }
  return deterministicVector(query);
}

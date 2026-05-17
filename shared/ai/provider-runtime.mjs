import { embeddingDimensions, embeddingSpaceId } from "./ai-config.mjs";
import { validateMissingInfoInferenceResult, validatePhotoAnalysisResult } from "./ai-schemas.mjs";
import { geoContextFor, localizedGeoHint, normalizeLocale } from "../domain/geo.mjs";
import { normalizeTags } from "../domain/text-normalizer.mjs";

export function providerCredentialKey(providerId) {
  if (providerId === "aliyun" || providerId === "qwen") return "aliyunApiKey";
  if (providerId === "openai") return "openaiApiKey";
  if (providerId === "openrouter") return "openrouterApiKey";
  if (providerId === "siliconflow") return "siliconflowApiKey";
  if (providerId === "voyage") return "voyageApiKey";
  return undefined;
}

export function parseJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
    if (Array.isArray(direct)) return direct.find((item) => item && typeof item === "object" && !Array.isArray(item));
  } catch {
    // Extract the first JSON object below.
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
  return undefined;
}

export async function postJson({ fetchImpl = globalThis.fetch, url, apiKey, body, headers = {} } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => undefined);
  if (!response.ok || json?.error) throw new Error(json?.error?.message || json?.message || `AI request failed: ${response.status}`);
  return json;
}

export function photoAnalysisPrompt(locale = "zh") {
  if (normalizeLocale(locale) === "en") {
    return [
      "You analyze travel photos for a local-first photo archive.",
      "Return one JSON object only with: title, caption, tags, locationCandidate.",
      "title: short human title. caption: one concise sentence. tags: 4-10 useful search tags.",
      "locationCandidate: optional object {name,country,city,confidence,reason}; omit if uncertain.",
      "Do not invent exact coordinates.",
    ].join("\n");
  }
  return [
    "你是旅行照片归档系统的图像理解模型。",
    "只返回一个 JSON 对象，字段为：title、caption、tags、locationCandidate。",
    "title 是简短标题；caption 是一句画面描述；tags 是 4-10 个可搜索标签。",
    "locationCandidate 可选，格式 {name,country,city,confidence,reason}；不确定就不要给。",
    "不要编造精确经纬度。",
  ].join("\n");
}

export function missingInfoPrompt(locale = "zh") {
  if (normalizeLocale(locale) === "en") {
    return [
      "You are a second-pass understanding module for travel photos that are missing GPS.",
      "Output JSON only. The current image is primary evidence; previous/next photos and allowedPlaces are context only.",
      "Use action bind_photos_to_place only with a placeId from allowedPlaces.",
      "Use create_place_from_candidate for a concrete landmark/place/city outside allowedPlaces; do not output coordinates.",
      "Use keep_pending only when confidence is below 0.55 or there is no concrete place evidence.",
      "Include confidence, reason, and rewrittenInitialAnalysis when the second-pass location differs from the initial candidate.",
    ].join("\n");
  }
  return [
    "你是缺失GPS的旅行照片的二次推断理解模块。",
    "只输出 JSON。当前照片图像是最高优先级证据，前后照片和 allowedPlaces 只作为上下文。",
    "bind_photos_to_place 只能使用 allowedPlaces 中的 placeId。",
    "如果当前图像或初次候选给出 allowedPlaces 之外的具体地点/地标/城市，应输出 create_place_from_candidate，且不要输出经纬度。",
    "只有置信度低于 0.55 或没有具体地点证据时才输出 keep_pending。",
    "当二次地点与初次候选不同，必须给出 rewrittenInitialAnalysis。",
  ].join("\n");
}

export function fallbackPhotoAnalysis({ fileName, preset, locale = "zh" } = {}) {
  const english = normalizeLocale(locale) === "en";
  const title = english
    ? preset?.city && !preset.city.includes("待确认")
      ? `${localizedGeoHint(preset.city, "en")} memory`
      : String(fileName ?? "").replace(/\.[^.]+$/, "")
    : preset?.city && !preset.city.includes("待确认")
      ? `${preset.city}记忆`
      : String(fileName ?? "").replace(/\.[^.]+$/, "");
  const tags = normalizeTags([], preset);
  return {
    provider: "mobile-fallback",
    promptId: "photo-analysis",
    promptVersion: "1.0.0",
    title,
    tags,
    caption: english
      ? `A travel photo near ${localizedGeoHint(preset?.city ?? "an unknown place", "en")}; cloud AI can refine the scene details later.`
      : `${preset?.city ?? "未知地点"}附近的旅行照片，系统已根据 GPS/文件名地点线索生成搜索标签，画面细节需要云端 AI 进一步确认。`,
    visiblePlaceNames: [],
    locationCandidates: [],
    uncertainties: [],
    fallbackReason: undefined,
  };
}

export function chatCompletionsBaseUrl(providerId) {
  if (providerId === "aliyun") return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  if (providerId === "siliconflow") return "https://api.siliconflow.cn/v1";
  if (providerId === "openrouter") return "https://openrouter.ai/api/v1";
  if (providerId === "openai") return "https://api.openai.com/v1";
  return undefined;
}

export function providerHeaders(providerId) {
  return providerId === "openrouter" ? { "HTTP-Referer": "https://earth-online.local", "X-Title": "Earth Online" } : {};
}

export async function analyzePhotoWithProvider({
  fetchImpl = globalThis.fetch,
  profile,
  apiKey,
  fileName,
  mime = "image/jpeg",
  dataUrl,
  preset,
  location,
  allowCloud = true,
  locale = "zh",
} = {}) {
  const fallback = fallbackPhotoAnalysis({ fileName, preset, locale });
  if (!allowCloud || !profile?.providerId || !profile?.modelId || !apiKey) return fallback;
  const baseUrl = chatCompletionsBaseUrl(profile.providerId);
  if (!baseUrl) return fallback;
  const messages = [
    { role: "system", content: photoAnalysisPrompt(locale) },
    {
      role: "user",
      content: [
        { type: "text", text: JSON.stringify({ exif: geoContextFor(preset, location, locale) }) },
        { type: "image_url", image_url: { url: dataUrl || `data:${mime};base64,` } },
      ],
    },
  ];
  try {
    const json = await postJson({
      fetchImpl,
      url: `${baseUrl}/chat/completions`,
      apiKey,
      body: {
        model: profile.modelId,
        response_format: { type: "json_object" },
        messages,
        temperature: 0.2,
      },
      headers: providerHeaders(profile.providerId),
    });
    return {
      ...validatePhotoAnalysisResult(parseJsonObject(json?.choices?.[0]?.message?.content), normalizeLocale(locale) === "en" ? undefined : preset, { locale }),
      provider: profile.providerId,
      model: profile.modelId,
      promptId: "photo-analysis",
      promptVersion: "1.0.0",
    };
  } catch (error) {
    return {
      ...fallback,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inferMissingInfoWithProvider({
  fetchImpl = globalThis.fetch,
  profile,
  apiKey,
  dataUrl,
  mime = "image/jpeg",
  inferenceInput,
  locale = "zh",
} = {}) {
  if (!profile?.providerId || !profile?.modelId || !apiKey) return validateMissingInfoInferenceResult(undefined, { locale });
  const baseUrl = chatCompletionsBaseUrl(profile.providerId);
  if (!baseUrl) return validateMissingInfoInferenceResult(undefined, { locale });
  const json = await postJson({
    fetchImpl,
    url: `${baseUrl}/chat/completions`,
    apiKey,
    body: {
      model: profile.modelId,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: missingInfoPrompt(locale) },
        {
          role: "user",
          content: [
            { type: "text", text: JSON.stringify(inferenceInput) },
            { type: "image_url", image_url: { url: dataUrl || `data:${mime};base64,` } },
          ],
        },
      ],
      temperature: 0.2,
    },
    headers: providerHeaders(profile.providerId),
  });
  return validateMissingInfoInferenceResult(parseJsonObject(json?.choices?.[0]?.message?.content), { locale });
}

export async function embedContentWithProvider({
  fetchImpl = globalThis.fetch,
  profile,
  apiKey,
  dataUrl,
  text,
  fileName,
  allowCloud = true,
} = {}) {
  if (!allowCloud || !profile?.enabled || !profile.providerId || !profile.modelId || !apiKey) return undefined;
  const dimensions = embeddingDimensions(profile);
  const spaceId = embeddingSpaceId(profile);

  if (profile.providerId === "aliyun") {
    const json = await postJson({
      fetchImpl,
      url: "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
      apiKey,
      body: {
        model: profile.modelId,
        input: {
          contents: [
            dataUrl
              ? { image: dataUrl }
              : {
                  text: text || fileName || "",
                },
          ],
        },
        parameters: Number.isInteger(dimensions) && dimensions > 0 ? { dimension: dimensions } : {},
      },
    });
    const embedding = json?.output?.embeddings?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("embedding returned unexpected content");
    return embeddingResult({ embedding, profile, spaceId });
  }

  if (profile.providerId === "siliconflow" || profile.providerId === "openrouter") {
    const baseUrl = profile.providerId === "siliconflow" ? "https://api.siliconflow.cn/v1" : "https://openrouter.ai/api/v1";
    const input =
      profile.providerId === "openrouter" && dataUrl
        ? [
            {
              content: [{ type: "image_url", image_url: { url: dataUrl } }],
            },
          ]
        : dataUrl || text || fileName || "";
    const json = await postJson({
      fetchImpl,
      url: `${baseUrl}/embeddings`,
      apiKey,
      body: {
        model: profile.modelId,
        input,
        ...(Number.isInteger(dimensions) && dimensions > 0 ? { dimensions } : {}),
      },
      headers: providerHeaders(profile.providerId),
    });
    const embedding = json?.data?.[0]?.embedding ?? json?.output?.embeddings?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("embedding returned unexpected content");
    return embeddingResult({ embedding, profile, spaceId });
  }

  if (profile.providerId === "voyage") {
    const json = await postJson({
      fetchImpl,
      url: "https://api.voyageai.com/v1/multimodalembeddings",
      apiKey,
      body: {
        model: profile.modelId,
        inputs: [
          {
            content: dataUrl ? [{ type: "image_base64", image_base64: dataUrl }] : [{ type: "text", text: text || fileName || "" }],
          },
        ],
      },
    });
    const embedding = json?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("embedding returned unexpected content");
    return embeddingResult({ embedding, profile, spaceId });
  }

  return undefined;
}

function embeddingResult({ embedding, profile, spaceId }) {
  const normalized = embedding.map(Number);
  return {
    embedding: normalized,
    embeddingProvider: profile.providerId,
    embeddingModel: profile.modelId,
    embeddingSpaceId: spaceId,
    embeddingDimension: normalized.length,
    embeddingMode: "cross_modal",
  };
}

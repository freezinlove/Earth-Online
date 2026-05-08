import { envValue } from "../config/env.mjs";

const qwenCompatibleBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const qwenMultimodalEmbeddingUrl =
  "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";

export async function qwenChatCompletion({
  apiKey,
  rootDir = process.cwd(),
  model = envValue(rootDir, "QWEN_CHAT_MODEL", "qwen3.5-flash"),
  messages,
  responseFormat = { type: "json_object" },
  temperature = 0.2,
}) {
  if (!apiKey) throw new Error("missing Qwen API key");

  const response = await fetch(`${qwenCompatibleBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: responseFormat,
      messages,
      temperature,
    }),
  });
  if (!response.ok) throw new Error(`qwen chat failed: ${response.status}`);

  const json = await response.json();
  return json.choices?.[0]?.message?.content ?? "";
}

export async function qwenMultimodalEmbedding({
  apiKey,
  rootDir = process.cwd(),
  model = envValue(rootDir, "QWEN_VISION_EMBEDDING_MODEL", "tongyi-embedding-vision-flash-2026-03-06"),
  fileName,
  dataUrl,
  text,
}) {
  if (!apiKey) throw new Error("missing Qwen API key");

  const response = await fetch(qwenMultimodalEmbeddingUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
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

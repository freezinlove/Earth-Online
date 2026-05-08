import { envValue } from "../config/env.mjs";
import { deterministicVector } from "../domain/vectors.mjs";
import { qwenMultimodalEmbedding } from "./qwen-client.mjs";

export function readProvidedApiKey(rootDir = process.cwd()) {
  return envValue(rootDir, "QWEN_API_KEY");
}

export async function embedPhotoEvidence({ rootDir, apiKey, fileName, dataUrl, text }) {
  try {
    const embedding = await qwenMultimodalEmbedding({ apiKey, rootDir, fileName, dataUrl, text });
    return {
      embedding,
      embeddingProvider: "qwen",
    };
  } catch {
    return {
      embedding: deterministicVector([fileName, text].filter(Boolean).join(" ")),
      embeddingProvider: "deterministic",
    };
  }
}

export async function embedSearchQuery(query, { rootDir = process.cwd(), allowCloud = true } = {}) {
  if (allowCloud) {
    try {
      const apiKey = readProvidedApiKey(rootDir);
      return await qwenMultimodalEmbedding({ apiKey, rootDir, fileName: "search-query", text: query });
    } catch {
      // fall back below
    }
  }
  return deterministicVector(query);
}

import { createOpenAiCompatibleProvider } from "./openai-compatible-provider.mjs";

export const openrouterProvider = createOpenAiCompatibleProvider({
  id: "openrouter",
  displayName: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  referer: "https://earth-online.local",
  title: "Earth Online",
  supportsEmbedding: true,
});

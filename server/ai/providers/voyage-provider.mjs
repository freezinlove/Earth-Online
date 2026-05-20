import { readProviderApiKey } from "../embedding-service.mjs";
import { embedContentWithProvider } from "../../../shared/ai/provider-runtime.mjs";

export const voyageProvider = {
  id: "voyage",
  displayName: "Voyage",
  capabilities: {
    imageUnderstanding: false,
    crossModalEmbedding: true,
    imageAnalysis: false,
    missingInfoInference: false,
    embedding: true,
  },
  async embed({ rootDir, secretProvider, fileName, dataUrl, text, modelId }) {
    const apiKey = readProviderApiKey("voyage", rootDir, secretProvider);
    const result = await embedContentWithProvider({
      profile: { enabled: true, providerId: this.id, modelId, modelSource: "custom" },
      apiKey,
      fileName,
      dataUrl,
      text,
    });
    if (!result) throw new Error("embedding unavailable");
    return result;
  },
};

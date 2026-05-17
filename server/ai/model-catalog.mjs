import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("./model-catalog.json", import.meta.url), "utf8"));

export const aiModelCatalog = catalog.models;

export const aiProviders = catalog.providers;

export function firstRecommendedModel(profileId, providerId) {
  return aiModelCatalog[profileId]?.[providerId]?.find((model) => model.recommended)?.id;
}

export function modelEmbeddingDimensions(profileId, providerId, modelId) {
  const dimensions = aiModelCatalog[profileId]?.[providerId]?.find((model) => model.id === modelId)?.dimensions;
  return Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
}

export function listAiModelCatalog() {
  return {
    providers: aiProviders,
    models: aiModelCatalog,
  };
}

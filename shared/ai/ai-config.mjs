import catalog from "./model-catalog.json" with { type: "json" };

export const aiModelCatalog = catalog.models;
export const aiProviders = catalog.providers;

export function listAiModelCatalog() {
  return {
    providers: aiProviders,
    models: aiModelCatalog,
  };
}

export function firstRecommendedModel(profileId, providerId) {
  return aiModelCatalog[profileId]?.[providerId]?.find((model) => model.recommended)?.id ?? aiModelCatalog[profileId]?.[providerId]?.[0]?.id;
}

export function modelEmbeddingDimensions(profileId, providerId, modelId) {
  const dimensions = aiModelCatalog[profileId]?.[providerId]?.find((model) => model.id === modelId)?.dimensions;
  return Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
}

export function providerSupports(profileId, providerId) {
  return Boolean(providerId && aiProviders.find((provider) => provider.id === providerId)?.capabilities?.[profileId]);
}

export function recommendedModelExists(profileId, providerId, modelId) {
  if (!providerId || !modelId) return false;
  return Boolean(aiModelCatalog[profileId]?.[providerId]?.some((model) => model.id === modelId));
}

export function normalizeModelSource(value) {
  return value === "custom" ? "custom" : "recommended";
}

export function defaultAiProfiles({
  legacyEmbeddingEnabled = false,
  imageModelId,
  embeddingModelId,
} = {}) {
  return {
    imageUnderstanding: {
      providerId: "aliyun",
      modelId: imageModelId || firstRecommendedModel("imageUnderstanding", "aliyun") || "qwen3.5-flash",
      modelSource: "recommended",
    },
    crossModalEmbedding: {
      enabled: Boolean(legacyEmbeddingEnabled),
      providerId: "aliyun",
      modelId: embeddingModelId || firstRecommendedModel("crossModalEmbedding", "aliyun") || "tongyi-embedding-vision-flash-2026-03-06",
      modelSource: "recommended",
    },
  };
}

export function normalizeImageProfile(profile, fallback = defaultAiProfiles().imageUnderstanding) {
  const providerId = providerSupports("imageUnderstanding", profile?.providerId) ? profile.providerId : fallback.providerId;
  const modelSource = normalizeModelSource(profile?.modelSource ?? fallback.modelSource);
  const modelId =
    modelSource === "custom"
      ? profile?.modelId || fallback.modelId
      : recommendedModelExists("imageUnderstanding", providerId, profile?.modelId)
        ? profile.modelId
        : firstRecommendedModel("imageUnderstanding", providerId) || fallback.modelId;

  return {
    providerId,
    modelId,
    modelSource,
  };
}

export function normalizeEmbeddingProfile(profile, fallback = defaultAiProfiles().crossModalEmbedding) {
  const enabled = Boolean(profile?.enabled ?? fallback.enabled);

  if (!enabled) {
    return {
      enabled: false,
      providerId: profile?.providerId ?? null,
      modelId: profile?.modelId ?? null,
      modelSource: profile?.modelSource ?? null,
    };
  }

  const fallbackProvider = providerSupports("crossModalEmbedding", fallback.providerId) ? fallback.providerId : "aliyun";
  const providerId = providerSupports("crossModalEmbedding", profile?.providerId) ? profile.providerId : fallbackProvider;
  const modelSource = normalizeModelSource(profile?.modelSource ?? fallback.modelSource);
  const modelId =
    modelSource === "custom"
      ? profile?.modelId || firstRecommendedModel("crossModalEmbedding", providerId) || fallback.modelId
      : recommendedModelExists("crossModalEmbedding", providerId, profile?.modelId)
        ? profile.modelId
        : firstRecommendedModel("crossModalEmbedding", providerId) || fallback.modelId;

  return {
    enabled,
    providerId,
    modelId,
    modelSource,
  };
}

export function normalizeAiConfig(config, { fallbackProfiles = defaultAiProfiles() } = {}) {
  const profiles = config?.profiles && typeof config.profiles === "object" ? config.profiles : {};
  return {
    catalog: listAiModelCatalog(),
    profiles: {
      imageUnderstanding: normalizeImageProfile(profiles.imageUnderstanding, fallbackProfiles.imageUnderstanding),
      crossModalEmbedding: normalizeEmbeddingProfile(profiles.crossModalEmbedding, fallbackProfiles.crossModalEmbedding),
    },
  };
}

export function embeddingSpaceId(profile) {
  if (!profile?.providerId || !profile?.modelId) return undefined;
  const dimensions = modelEmbeddingDimensions("crossModalEmbedding", profile.providerId, profile.modelId);
  return [profile.providerId, profile.modelId, dimensions ? `d${dimensions}` : undefined].filter(Boolean).join(":");
}

export function embeddingDimensions(profile) {
  if (!profile?.providerId || !profile?.modelId) return undefined;
  return modelEmbeddingDimensions("crossModalEmbedding", profile.providerId, profile.modelId);
}

export function preferredEmbeddingDimensions(profile) {
  return embeddingDimensions(profile);
}

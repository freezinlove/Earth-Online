export const promptDefinitions = {
  photoAnalysis: {
    id: "photo-analysis",
    version: "1.0.0",
    files: {
      zh: "photo-analysis.v1.zh.md",
      en: "photo-analysis.v1.en.md",
    },
  },
  missingInfoInference: {
    id: "missing-info-inference",
    version: "1.0.0",
    files: {
      zh: "missing-info-inference.v1.zh.md",
      en: "missing-info-inference.v1.en.md",
    },
  },
};

export function normalizePromptLocale(locale) {
  return locale === "en" ? "en" : "zh";
}

export function promptDefinition(name) {
  const definition = promptDefinitions[name];
  if (!definition) throw new Error(`Unknown AI prompt: ${name}`);
  return definition;
}


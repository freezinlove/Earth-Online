import { normalizePromptLocale, promptDefinition } from "../../shared/ai/prompt-definitions.mjs";
import photoAnalysisEn from "../../shared/ai/prompts/photo-analysis.v1.en.md?raw";
import photoAnalysisZh from "../../shared/ai/prompts/photo-analysis.v1.zh.md?raw";
import missingInfoInferenceEn from "../../shared/ai/prompts/missing-info-inference.v1.en.md?raw";
import missingInfoInferenceZh from "../../shared/ai/prompts/missing-info-inference.v1.zh.md?raw";

const promptContent = {
  photoAnalysis: {
    zh: photoAnalysisZh,
    en: photoAnalysisEn,
  },
  missingInfoInference: {
    zh: missingInfoInferenceZh,
    en: missingInfoInferenceEn,
  },
};

export function loadMobilePrompt(name: keyof typeof promptContent, locale: "zh" | "en" = "zh") {
  const definition = promptDefinition(name);
  const normalizedLocale = normalizePromptLocale(locale) as "zh" | "en";
  return {
    id: definition.id,
    version: definition.version,
    locale: normalizedLocale,
    content: promptContent[name][normalizedLocale],
  };
}


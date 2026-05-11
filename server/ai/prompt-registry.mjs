import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const promptDefinitions = {
  photoAnalysis: {
    id: "photo-analysis",
    version: "1.0.0",
    paths: {
      zh: path.join(__dirname, "prompts", "photo-analysis.v1.zh.md"),
      en: path.join(__dirname, "prompts", "photo-analysis.v1.en.md"),
    },
  },
  missingInfoInference: {
    id: "missing-info-inference",
    version: "1.0.0",
    paths: {
      zh: path.join(__dirname, "prompts", "missing-info-inference.v1.zh.md"),
      en: path.join(__dirname, "prompts", "missing-info-inference.v1.en.md"),
    },
  },
};

function normalizeLocale(locale) {
  return locale === "en" ? "en" : "zh";
}

export async function loadPrompt(name, locale = "zh") {
  const definition = promptDefinitions[name];
  if (!definition) throw new Error(`Unknown AI prompt: ${name}`);
  const normalizedLocale = normalizeLocale(locale);
  return {
    id: definition.id,
    version: definition.version,
    locale: normalizedLocale,
    path: definition.paths[normalizedLocale],
    content: await fs.readFile(definition.paths[normalizedLocale], "utf8"),
  };
}

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { normalizePromptLocale, promptDefinition } from "../../shared/ai/prompt-definitions.mjs";

export { normalizePromptLocale };

export async function loadPrompt(name, locale = "zh") {
  const definition = promptDefinition(name);
  const normalizedLocale = normalizePromptLocale(locale);
  const fileName = definition.files[normalizedLocale];
  const url = new URL(`../../shared/ai/prompts/${fileName}`, import.meta.url);
  return {
    id: definition.id,
    version: definition.version,
    locale: normalizedLocale,
    path: fileURLToPath(url),
    content: await fs.readFile(url, "utf8"),
  };
}

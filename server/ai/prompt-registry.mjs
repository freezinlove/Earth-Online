import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const promptDefinitions = {
  photoAnalysis: {
    id: "photo-analysis",
    version: "1.0.0",
    path: path.join(__dirname, "prompts", "photo-analysis.v1.zh.md"),
  },
};

export async function loadPrompt(name) {
  const definition = promptDefinitions[name];
  if (!definition) throw new Error(`Unknown AI prompt: ${name}`);
  return {
    ...definition,
    content: await fs.readFile(definition.path, "utf8"),
  };
}

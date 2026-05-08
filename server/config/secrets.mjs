import fs from "node:fs";
import path from "node:path";
import { readDotEnv } from "./env.mjs";

const localAiKeyMap = {
  qwenChatApiKey: ["QWEN_CHAT_API_KEY", "QWEN_API_KEY"],
  qwenEmbeddingApiKey: ["QWEN_EMBEDDING_API_KEY", "QWEN_API_KEY"],
};

function normalizeSecret(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 8) return "已设置";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function createSecretProvider({ rootDir = process.cwd(), dataDir }) {
  const localAiPath = path.join(dataDir, "secrets", "local-ai.json");

  function readLocalAiSecrets() {
    const local = readJsonFile(localAiPath);
    return Object.fromEntries(
      Object.keys(localAiKeyMap).map((key) => [key, normalizeSecret(local[key])]).filter(([, value]) => Boolean(value)),
    );
  }

  function readEnvSecret(key) {
    const dotEnv = readDotEnv(rootDir);
    for (const envKey of localAiKeyMap[key] ?? []) {
      const value = normalizeSecret(process.env[envKey] ?? dotEnv[envKey]);
      if (value) return { source: "env", value };
    }
    return { source: "none", value: undefined };
  }

  function resolveLocalAiSecret(key) {
    const local = readLocalAiSecrets();
    if (local[key]) return { source: "local", value: local[key] };
    return readEnvSecret(key);
  }

  return {
    get(key) {
      return resolveLocalAiSecret(key).value;
    },
    getLocalAiSettings() {
      return Object.fromEntries(
        Object.keys(localAiKeyMap).map((key) => {
          const resolved = resolveLocalAiSecret(key);
          return [
            key,
            {
              isSet: Boolean(resolved.value),
              preview: maskSecret(resolved.value),
              source: resolved.source,
            },
          ];
        }),
      );
    },
    updateLocalAiSettings(body) {
      const current = readLocalAiSecrets();
      for (const key of Object.keys(localAiKeyMap)) {
        if (!Object.hasOwn(body ?? {}, key)) continue;
        if (typeof body[key] !== "string") throw new Error(`${key} must be a string`);
        if (body[key].length > 4096) throw new Error(`${key} is too long`);
        const normalized = normalizeSecret(body[key]);
        if (normalized) {
          current[key] = normalized;
        } else {
          delete current[key];
        }
      }
      writeJsonFile(localAiPath, current);
      return this.getLocalAiSettings();
    },
  };
}

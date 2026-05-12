import fs from "node:fs";
import path from "node:path";
import { readDotEnv } from "./env.mjs";

const localAiKeyMap = {
  aliyunApiKey: ["ALIYUN_API_KEY", "BAILIAN_API_KEY", "QWEN_API_KEY"],
  siliconflowApiKey: ["SILICONFLOW_API_KEY"],
  openaiApiKey: ["OPENAI_API_KEY"],
  openrouterApiKey: ["OPENROUTER_API_KEY"],
  voyageApiKey: ["VOYAGE_API_KEY"],
  qwenChatApiKey: ["QWEN_CHAT_API_KEY", "QWEN_API_KEY"],
  qwenEmbeddingApiKey: ["QWEN_EMBEDDING_API_KEY", "QWEN_API_KEY"],
};

const providerKeys = ["aliyunApiKey", "siliconflowApiKey", "openaiApiKey", "openrouterApiKey", "voyageApiKey"];
const aiProfileKeys = ["imageUnderstanding", "crossModalEmbedding"];

const providerApiKeyById = {
  aliyun: "aliyunApiKey",
  openai: "openaiApiKey",
  openrouter: "openrouterApiKey",
  siliconflow: "siliconflowApiKey",
  voyage: "voyageApiKey",
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

  function readProfileAiSecrets(profileId) {
    const local = readJsonFile(localAiPath);
    const profileCredentials = local.profileCredentials?.[profileId];
    if (!profileCredentials || typeof profileCredentials !== "object" || Array.isArray(profileCredentials)) return {};
    return Object.fromEntries(
      providerKeys.map((key) => [key, normalizeSecret(profileCredentials[key])]).filter(([, value]) => Boolean(value)),
    );
  }

  function readLocalAiConfig() {
    const local = readJsonFile(localAiPath);
    return local.aiConfig && typeof local.aiConfig === "object" && !Array.isArray(local.aiConfig) ? local.aiConfig : undefined;
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

  function resolveProfileAiSecret(profileId, key) {
    const local = readProfileAiSecrets(profileId);
    if (local[key]) return { source: "local", value: local[key] };
    return readEnvSecret(key);
  }

  function profileCredentialSettings() {
    return Object.fromEntries(
      aiProfileKeys.map((profileId) => [
        profileId,
        Object.fromEntries(
          providerKeys.map((key) => {
            const resolved = resolveProfileAiSecret(profileId, key);
            return [
              key,
              {
                isSet: Boolean(resolved.value),
                preview: maskSecret(resolved.value),
                source: resolved.source,
              },
            ];
          }),
        ),
      ]),
    );
  }

  return {
    get(key) {
      return resolveLocalAiSecret(key).value;
    },
    getProfileApiKey(profileId, providerId) {
      const key = providerApiKeyById[providerId];
      if (!key) return undefined;
      return resolveProfileAiSecret(profileId, key).value ?? resolveLocalAiSecret(key).value;
    },
    getAiConfig() {
      return readLocalAiConfig();
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
    getAiSettings() {
      const credentials = Object.fromEntries(
        providerKeys.map((key) => {
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
      return {
        credentials,
        profileCredentials: profileCredentialSettings(),
        aiConfig: readLocalAiConfig(),
      };
    },
    updateLocalAiSettings(body) {
      const local = readJsonFile(localAiPath);
      const current = { ...local, ...readLocalAiSecrets() };
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
      if (body?.aiConfig && typeof body.aiConfig === "object" && !Array.isArray(body.aiConfig)) {
        current.aiConfig = body.aiConfig;
      }
      writeJsonFile(localAiPath, current);
      return this.getLocalAiSettings();
    },
    updateAiSettings(body) {
      const local = readJsonFile(localAiPath);
      const current = { ...local, ...readLocalAiSecrets() };
      for (const key of providerKeys) {
        if (!Object.hasOwn(body?.credentials ?? {}, key)) continue;
        if (typeof body.credentials[key] !== "string") throw new Error(`${key} must be a string`);
        if (body.credentials[key].length > 4096) throw new Error(`${key} is too long`);
        const normalized = normalizeSecret(body.credentials[key]);
        if (normalized) current[key] = normalized;
        else delete current[key];
      }
      if (body?.profileCredentials && typeof body.profileCredentials === "object" && !Array.isArray(body.profileCredentials)) {
        const profileCredentials =
          current.profileCredentials && typeof current.profileCredentials === "object" && !Array.isArray(current.profileCredentials) ? current.profileCredentials : {};
        for (const profileId of aiProfileKeys) {
          const incoming = body.profileCredentials[profileId];
          if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) continue;
          const currentProfile = profileCredentials[profileId] && typeof profileCredentials[profileId] === "object" && !Array.isArray(profileCredentials[profileId]) ? profileCredentials[profileId] : {};
          for (const key of providerKeys) {
            if (!Object.hasOwn(incoming, key)) continue;
            if (typeof incoming[key] !== "string") throw new Error(`${profileId}.${key} must be a string`);
            if (incoming[key].length > 4096) throw new Error(`${profileId}.${key} is too long`);
            const normalized = normalizeSecret(incoming[key]);
            if (normalized) currentProfile[key] = normalized;
            else delete currentProfile[key];
          }
          profileCredentials[profileId] = currentProfile;
        }
        current.profileCredentials = profileCredentials;
      }
      if (body?.aiConfig && typeof body.aiConfig === "object" && !Array.isArray(body.aiConfig)) {
        current.aiConfig = body.aiConfig;
      }
      writeJsonFile(localAiPath, current);
      return this.getAiSettings();
    },
  };
}

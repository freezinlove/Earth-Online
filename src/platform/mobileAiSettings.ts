import type { AiConfig, AiSettings, ProviderCredentialKey } from "@/services/apiClient";
import { readNativeSecrets, writeNativeSecrets } from "@/platform/nativeSecrets";
import { normalizeAiConfig as normalizeSharedAiConfig } from "../../shared/ai/ai-config.mjs";
import { providerCredentialKey } from "../../shared/ai/provider-runtime.mjs";

export type MobileAiSettingsUpdateBody = {
  credentials?: Partial<Record<ProviderCredentialKey, string>>;
  profileCredentials?: Partial<Record<"imageUnderstanding" | "crossModalEmbedding", Partial<Record<ProviderCredentialKey, string>>>>;
  aiConfig?: Partial<AiConfig> | AiConfig;
};

type MobileAiSecrets = {
  credentials?: Partial<Record<ProviderCredentialKey, string>>;
  profileCredentials?: Partial<Record<"imageUnderstanding" | "crossModalEmbedding", Partial<Record<ProviderCredentialKey, string>>>>;
};

const aiSettingsKey = "earth-online-mobile-ai-settings-v1";
const aiSecretsKey = "earth-online-mobile-ai-secrets-v1";
const providerKeys: ProviderCredentialKey[] = ["aliyunApiKey", "openaiApiKey", "openrouterApiKey", "siliconflowApiKey", "voyageApiKey"];

let cachedAiSecrets: MobileAiSecrets | undefined;
let aiSecretsHydration: Promise<MobileAiSecrets> | undefined;

function hasOwn(object: object | undefined, key: string) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

export function normalizeMobileAiConfig(config?: Partial<AiConfig> | AiConfig): AiConfig {
  return normalizeSharedAiConfig(config) as AiConfig;
}

export function emptyCredential(source: "local" | "env" | "none" = "none") {
  return { isSet: source !== "none", preview: source === "none" ? "" : "已设置", source };
}

function credentialPreview(value?: string) {
  if (!value) return emptyCredential();
  const suffix = value.length > 4 ? value.slice(-4) : "";
  return { isSet: true, preview: suffix ? `••••${suffix}` : "已设置", source: "local" as const };
}

function readLocalAiSecrets(): MobileAiSecrets {
  try {
    return JSON.parse(window.localStorage.getItem(aiSecretsKey) || "{}") as MobileAiSecrets;
  } catch {
    return {};
  }
}

function writeLocalAiSecrets(secrets: MobileAiSecrets) {
  window.localStorage.setItem(aiSecretsKey, JSON.stringify(secrets));
}

function clearLocalAiSecrets() {
  try {
    window.localStorage.removeItem(aiSecretsKey);
  } catch {
    // Ignore local cleanup failures.
  }
}

function hasAiSecrets(secrets: MobileAiSecrets | undefined) {
  if (!secrets) return false;
  const hasGlobal = providerKeys.some((key) => Boolean(secrets.credentials?.[key]));
  const hasProfile = providerKeys.some((key) => Boolean(secrets.profileCredentials?.imageUnderstanding?.[key] || secrets.profileCredentials?.crossModalEmbedding?.[key]));
  return hasGlobal || hasProfile;
}

async function getAiSecrets(): Promise<MobileAiSecrets> {
  if (cachedAiSecrets) return cachedAiSecrets;
  aiSecretsHydration ??= (async () => {
    const native = await readNativeSecrets<MobileAiSecrets>().catch(() => undefined);
    if (hasAiSecrets(native)) {
      cachedAiSecrets = native ?? {};
      return cachedAiSecrets;
    }
    const local = readLocalAiSecrets();
    if (hasAiSecrets(local)) {
      const migrated = await writeNativeSecrets(local).catch(() => false);
      if (migrated) clearLocalAiSecrets();
      cachedAiSecrets = local;
      return cachedAiSecrets;
    }
    cachedAiSecrets = native ?? {};
    return cachedAiSecrets;
  })();
  return aiSecretsHydration;
}

async function writeAiSecrets(secrets: MobileAiSecrets) {
  cachedAiSecrets = secrets;
  aiSecretsHydration = Promise.resolve(secrets);
  const wroteNative = await writeNativeSecrets(secrets).catch(() => false);
  if (wroteNative) clearLocalAiSecrets();
  else writeLocalAiSecrets(secrets);
}

function credentialKeyForProvider(providerId?: string | null): ProviderCredentialKey | undefined {
  return providerCredentialKey(providerId) as ProviderCredentialKey | undefined;
}

export async function secretForMobileAiProfile(profile: "imageUnderstanding" | "crossModalEmbedding", providerId?: string | null) {
  const key = credentialKeyForProvider(providerId);
  if (!key) return undefined;
  const secrets = await getAiSecrets();
  return secrets.profileCredentials?.[profile]?.[key] || secrets.credentials?.[key];
}

export async function readMobileAiSettings(): Promise<AiSettings> {
  const secrets = await getAiSecrets();
  const fallback: AiSettings = {
    credentials: Object.fromEntries(providerKeys.map((key) => [key, credentialPreview(secrets.credentials?.[key])])) as AiSettings["credentials"],
    profileCredentials: {
      imageUnderstanding: Object.fromEntries(providerKeys.map((key) => [key, credentialPreview(secrets.profileCredentials?.imageUnderstanding?.[key] || secrets.credentials?.[key])])) as AiSettings["profileCredentials"]["imageUnderstanding"],
      crossModalEmbedding: Object.fromEntries(providerKeys.map((key) => [key, credentialPreview(secrets.profileCredentials?.crossModalEmbedding?.[key] || secrets.credentials?.[key])])) as AiSettings["profileCredentials"]["crossModalEmbedding"],
    },
    aiConfig: normalizeMobileAiConfig(),
  };
  const raw = window.localStorage.getItem(aiSettingsKey);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      ...fallback,
      ...parsed,
      credentials: fallback.credentials,
      profileCredentials: fallback.profileCredentials,
      aiConfig: normalizeMobileAiConfig(parsed.aiConfig),
    };
  } catch {
    return fallback;
  }
}

function writeAiSettings(settings: AiSettings) {
  window.localStorage.setItem(aiSettingsKey, JSON.stringify(settings));
}

export async function updateMobileAiSettings(body: MobileAiSettingsUpdateBody) {
  const current = await readMobileAiSettings();
  const secrets = await getAiSecrets();
  const nextSecrets: MobileAiSecrets = {
    credentials: { ...(secrets.credentials ?? {}) },
    profileCredentials: {
      imageUnderstanding: { ...(secrets.profileCredentials?.imageUnderstanding ?? {}) },
      crossModalEmbedding: { ...(secrets.profileCredentials?.crossModalEmbedding ?? {}) },
    },
  };
  const nextCredentials = { ...current.credentials };
  for (const key of providerKeys) {
    if (!hasOwn(body.credentials, key)) continue;
    const value = body.credentials?.[key]?.trim() ?? "";
    if (value) nextSecrets.credentials![key] = value;
    else delete nextSecrets.credentials![key];
    nextCredentials[key] = credentialPreview(value);
  }
  const nextProfileCredentials = {
    imageUnderstanding: { ...current.profileCredentials.imageUnderstanding },
    crossModalEmbedding: { ...current.profileCredentials.crossModalEmbedding },
  };
  for (const profile of ["imageUnderstanding", "crossModalEmbedding"] as const) {
    for (const key of providerKeys) {
      if (!hasOwn(body.profileCredentials?.[profile], key)) continue;
      const value = body.profileCredentials?.[profile]?.[key]?.trim() ?? "";
      if (value) nextSecrets.profileCredentials![profile]![key] = value;
      else delete nextSecrets.profileCredentials![profile]![key];
      nextProfileCredentials[profile][key] = credentialPreview(value || nextSecrets.credentials?.[key]);
    }
  }
  const next: AiSettings = {
    ...current,
    credentials: nextCredentials,
    profileCredentials: nextProfileCredentials,
    aiConfig: body.aiConfig ? normalizeMobileAiConfig(body.aiConfig) : normalizeMobileAiConfig(current.aiConfig),
  };
  await writeAiSecrets(nextSecrets);
  writeAiSettings(next);
  return next;
}

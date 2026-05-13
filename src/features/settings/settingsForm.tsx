import { Check, ChevronDown, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, type AiConfig, type AiModelOption, type AiProviderOption, type ImportJobProgress, type LocalAiCredential, type ProviderCredentialKey } from "@/services/apiClient";
import type { Locale } from "@/store/appStore";

export type FieldStatus = "idle" | "loading" | "saving" | "saved" | "cleared" | "unchanged" | "error";
export type ProfileKey = "imageUnderstanding" | "crossModalEmbedding";

type ModelProfileDraft = {
  enabled?: boolean;
  providerId: string | null;
  modelId: string | null;
  modelSource: "recommended" | "custom" | null;
};

export type ModelProfileText = {
  chooseModel: string;
  chooseProviderFirst: string;
  concreteModel: string;
  customModelHelp: string;
  customModelId: string;
  delete: string;
  disable: string;
  enable: string;
  enterFullModelId: string;
  modelProvider: string;
  save: string;
  savedApiKey: string;
};

const providerCredentialKeyById: Record<string, ProviderCredentialKey> = {
  aliyun: "aliyunApiKey",
  openai: "openaiApiKey",
  openrouter: "openrouterApiKey",
  siliconflow: "siliconflowApiKey",
  voyage: "voyageApiKey",
};

export const emptyCredential: LocalAiCredential = { isSet: false, preview: "", source: "none" };

const emptyProviderValues: Record<ProviderCredentialKey, string> = {
  aliyunApiKey: "",
  openaiApiKey: "",
  openrouterApiKey: "",
  siliconflowApiKey: "",
  voyageApiKey: "",
};

const loadingProviderStatuses: Record<ProviderCredentialKey, FieldStatus> = {
  aliyunApiKey: "loading",
  openaiApiKey: "loading",
  openrouterApiKey: "loading",
  siliconflowApiKey: "loading",
  voyageApiKey: "loading",
};

const idleProviderStatuses: Record<ProviderCredentialKey, FieldStatus> = {
  aliyunApiKey: "idle",
  openaiApiKey: "idle",
  openrouterApiKey: "idle",
  siliconflowApiKey: "idle",
  voyageApiKey: "idle",
};

const errorProviderStatuses: Record<ProviderCredentialKey, FieldStatus> = {
  aliyunApiKey: "error",
  openaiApiKey: "error",
  openrouterApiKey: "error",
  siliconflowApiKey: "error",
  voyageApiKey: "error",
};

export function firstModel(config: AiConfig | undefined, profile: ProfileKey, providerId: string) {
  return config?.catalog.models[profile]?.[providerId]?.[0]?.id ?? "";
}

function profileProviderOptions(config: AiConfig | undefined, profile: ProfileKey) {
  return (config?.catalog.providers ?? []).filter((provider) => provider.capabilities[profile]);
}

export function profileModels(config: AiConfig | undefined, profile: ProfileKey, providerId: string | null) {
  if (!providerId) return [];
  return config?.catalog.models[profile]?.[providerId] ?? [];
}

function providerCredentialKey(providerId: string | null | undefined) {
  return providerId ? providerCredentialKeyById[providerId] : undefined;
}

function providerDisplayName(provider: AiProviderOption, locale: Locale) {
  if (provider.id === "aliyun") return locale === "en" ? "Aliyun Bailian" : "阿里百炼";
  if (provider.id === "siliconflow") return locale === "en" ? "SiliconFlow" : "硅基流动";
  return provider.displayName;
}

function modelLabel(models: AiModelOption[], modelId: string | null | undefined) {
  return models.find((model) => model.id === modelId)?.label ?? modelId ?? "";
}

function modelDimensionsLabel(models: AiModelOption[], modelId: string | null | undefined) {
  const dimensions = models.find((model) => model.id === modelId)?.dimensions;
  return Number.isInteger(dimensions) && dimensions ? `${dimensions}D` : "";
}

export function embeddingProgressPercent(progress?: ImportJobProgress) {
  const done = progress?.steps?.embedding?.done ?? progress?.done ?? 0;
  const total = Math.max(progress?.steps?.embedding?.total ?? progress?.total ?? 0, 1);
  return Math.round((Math.min(done, total) / total) * 100);
}

export function ModelProfileSection({
  description,
  disabled = false,
  credential = emptyCredential,
  credentialStatus,
  credentialValue,
  locale,
  models,
  onApiKeyChange,
  onClearApiKey,
  onCustomModelChange,
  onModelChange,
  onProviderChange,
  onSaveApiKey,
  onToggle,
  optional = false,
  profile,
  providers,
  footer,
  sourceLabel,
  statusText,
  text,
  title,
}: {
  credential?: LocalAiCredential;
  credentialStatus: FieldStatus;
  credentialValue: string;
  description: string;
  disabled?: boolean;
  locale: Locale;
  models: AiModelOption[];
  onApiKeyChange: (value: string) => void;
  onClearApiKey: () => void;
  onCustomModelChange: (modelId: string) => void;
  onModelChange: (modelId: string) => void;
  onProviderChange: (providerId: string) => void;
  onSaveApiKey: () => void;
  onToggle?: (enabled: boolean) => void;
  optional?: boolean;
  profile?: ModelProfileDraft;
  providers: AiProviderOption[];
  footer?: ReactNode;
  sourceLabel: Record<LocalAiCredential["source"], string>;
  statusText: Record<FieldStatus, string>;
  text: ModelProfileText;
  title: string;
}) {
  const enabled = optional ? Boolean(profile?.enabled) : true;
  const providerId = profile?.providerId ?? "";
  const modelSource = profile?.modelSource ?? "recommended";
  const selectedModel = modelLabel(models, profile?.modelId);
  const selectedDimensions = modelDimensionsLabel(models, profile?.modelId);
  const isCredentialSaving = credentialStatus === "saving";
  const canSaveCredential = Boolean(providerId && credentialValue.trim()) && !disabled && !isCredentialSaving;
  const canClearCredential = providerId && credential.source === "local" && !disabled && !isCredentialSaving;
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const menuValue = modelSource === "custom" ? text.customModelId : selectedModel || text.chooseModel;

  return (
    <section className="ai-model-card" data-disabled={!enabled || disabled ? "true" : "false"}>
      <div className="ai-model-card-heading">
        <div>
          <h3>{title}</h3>
        </div>
        {optional && onToggle ? (
          <div className="ai-model-toggle-group" aria-label={`${title} enablement`}>
            <button className={!enabled ? "is-active" : ""} disabled={disabled} onClick={() => onToggle(false)} type="button">
              {text.disable}
            </button>
            <button className={enabled ? "is-active" : ""} disabled={disabled} onClick={() => onToggle(true)} type="button">
              {text.enable}
            </button>
          </div>
        ) : null}
      </div>
      <p className="ai-model-copy">{description}</p>

      {enabled ? (
        <>
          <div className="ai-model-step">
            <span>{text.modelProvider}</span>
            <div className="ai-provider-pills">
              {providers.map((provider) => (
                <button className={provider.id === providerId ? "is-active" : ""} disabled={disabled} key={provider.id} onClick={() => onProviderChange(provider.id)} type="button">
                  {providerDisplayName(provider, locale)}
                </button>
              ))}
            </div>
          </div>

          <div className="ai-model-step">
            <span>API Key</span>
            <div className="ai-key-row">
              <label className="local-secret-input-shell">
                <KeyRound size={18} />
                <input
                  aria-label={`${title} API key`}
                  autoComplete="off"
                  className="local-secret-input"
                  disabled={disabled || !providerId || isCredentialSaving}
                  onChange={(event) => onApiKeyChange(event.target.value)}
                  placeholder={credential.isSet ? `${text.savedApiKey}: ${credential.preview}` : providerId ? "Paste API key" : text.chooseProviderFirst}
                  spellCheck={false}
                  type="password"
                  value={credentialValue}
                />
              </label>
              <button className="local-secret-action" disabled={!canSaveCredential} onClick={onSaveApiKey} type="button">
                {isCredentialSaving ? <LoaderCircle className="animate-spin" size={16} /> : <Check size={16} />}
                {text.save}
              </button>
              <button className="local-secret-action local-secret-action-subtle" disabled={!canClearCredential} onClick={onClearApiKey} type="button">
                <Trash2 size={16} />
                {text.delete}
              </button>
            </div>
            <div className="local-secret-state">
              <span>{sourceLabel[credential.source]}</span>
              {statusText[credentialStatus] ? <span>{statusText[credentialStatus]}</span> : null}
            </div>
          </div>

          <div className="ai-model-step">
            <span>{text.concreteModel}</span>
            <div className="ai-model-picker">
              <div className="ai-model-menu" data-open={modelMenuOpen ? "true" : "false"}>
                <button
                  aria-expanded={modelMenuOpen}
                  aria-label={`${title} model`}
                  className="ai-model-menu-trigger"
                  disabled={disabled || !providerId}
                  onClick={() => setModelMenuOpen((open) => !open)}
                  type="button"
                >
                  <span>
                    {menuValue}
                    {modelSource !== "custom" && selectedDimensions ? <em>{selectedDimensions}</em> : null}
                  </span>
                  <ChevronDown size={16} />
                </button>
                {modelMenuOpen ? (
                  <div className="ai-model-menu-popover" role="listbox">
                    {models.map((model) => (
                      <button
                        className={modelSource !== "custom" && profile?.modelId === model.id ? "is-selected" : ""}
                        key={model.id}
                        onClick={() => {
                          onModelChange(model.id);
                          setModelMenuOpen(false);
                        }}
                        role="option"
                        type="button"
                      >
                        <span>
                          {model.label}
                          {model.dimensions ? <em>{model.dimensions}D</em> : null}
                        </span>
                        <small>{model.id}</small>
                      </button>
                    ))}
                    <button
                      className={modelSource === "custom" ? "is-selected" : ""}
                      onClick={() => {
                        onCustomModelChange(profile?.modelId ?? "");
                        setModelMenuOpen(false);
                      }}
                      role="option"
                      type="button"
                    >
                      <span>{text.customModelId}</span>
                      <small>{text.customModelHelp}</small>
                    </button>
                  </div>
                ) : null}
              </div>
              {modelSource === "custom" ? (
                <label className="local-secret-input-shell">
                  <input
                    aria-label={`${title} custom model id`}
                    className="local-secret-input"
                    disabled={disabled}
                    onChange={(event) => onCustomModelChange(event.target.value)}
                    placeholder={text.enterFullModelId}
                    spellCheck={false}
                    value={profile?.modelId ?? ""}
                  />
                </label>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
      {footer}
    </section>
  );
}

function makeEmptyValues(): Record<ProfileKey, Record<ProviderCredentialKey, string>> {
  return {
    crossModalEmbedding: { ...emptyProviderValues },
    imageUnderstanding: { ...emptyProviderValues },
  };
}

function makeLoadingStatuses(): Record<ProfileKey, Record<ProviderCredentialKey, FieldStatus>> {
  return {
    crossModalEmbedding: { ...loadingProviderStatuses },
    imageUnderstanding: { ...loadingProviderStatuses },
  };
}

export function useAiSettingsForm(enabled = true) {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof apiClient.getAiSettings>>>();
  const [values, setValues] = useState<Record<ProfileKey, Record<ProviderCredentialKey, string>>>(() => makeEmptyValues());
  const [statuses, setStatuses] = useState<Record<ProfileKey, Record<ProviderCredentialKey, FieldStatus>>>(() => makeLoadingStatuses());
  const [profileDraft, setProfileDraft] = useState<AiConfig["profiles"]>();
  const [profileStatus, setProfileStatus] = useState<FieldStatus>("loading");
  const profileSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const profileSaveSeq = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setStatuses({ crossModalEmbedding: { ...loadingProviderStatuses }, imageUnderstanding: { ...loadingProviderStatuses } });
      setProfileStatus("loading");
      return;
    }
    let alive = true;
    apiClient
      .getAiSettings()
      .then((nextSettings) => {
        if (!alive) return;
        setSettings(nextSettings);
        setProfileDraft(nextSettings.aiConfig.profiles);
        setStatuses({ crossModalEmbedding: { ...idleProviderStatuses }, imageUnderstanding: { ...idleProviderStatuses } });
        setProfileStatus("idle");
      })
      .catch(() => {
        if (!alive) return;
        setStatuses({ crossModalEmbedding: { ...errorProviderStatuses }, imageUnderstanding: { ...errorProviderStatuses } });
        setProfileStatus("error");
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  useEffect(() => {
    return () => {
      if (profileSaveTimer.current) clearTimeout(profileSaveTimer.current);
    };
  }, []);

  const imageProviders = useMemo(() => profileProviderOptions(settings?.aiConfig, "imageUnderstanding"), [settings]);
  const embeddingProviders = useMemo(() => profileProviderOptions(settings?.aiConfig, "crossModalEmbedding"), [settings]);
  const imageProfile = profileDraft?.imageUnderstanding;
  const embeddingProfile = profileDraft?.crossModalEmbedding;
  const imageCredentialKey = providerCredentialKey(imageProfile?.providerId);
  const embeddingCredentialKey = providerCredentialKey(embeddingProfile?.providerId);

  const updateValue = (profile: ProfileKey, key: ProviderCredentialKey, value: string) => {
    setValues((current) => ({ ...current, [profile]: { ...current[profile], [key]: value } }));
    setStatuses((current) => ({ ...current, [profile]: { ...current[profile], [key]: "idle" } }));
  };

  const saveField = async (profile: ProfileKey, key: ProviderCredentialKey) => {
    const nextValue = values[profile][key].trim();
    if (!nextValue) {
      setStatuses((current) => ({ ...current, [profile]: { ...current[profile], [key]: "unchanged" } }));
      return;
    }
    setStatuses((current) => ({ ...current, [profile]: { ...current[profile], [key]: "saving" } }));
    try {
      const nextSettings = await apiClient.updateAiSettings({ profileCredentials: { [profile]: { [key]: nextValue } } });
      setSettings(nextSettings);
      setProfileDraft((current) => current ?? nextSettings.aiConfig.profiles);
      setValues((current) => ({ ...current, [profile]: { ...current[profile], [key]: "" } }));
      setStatuses((current) => ({ ...current, [profile]: { ...current[profile], [key]: "saved" } }));
    } catch {
      setStatuses((current) => ({ ...current, [profile]: { ...current[profile], [key]: "error" } }));
    }
  };

  const clearField = async (profile: ProfileKey, key: ProviderCredentialKey) => {
    setStatuses((current) => ({ ...current, [profile]: { ...current[profile], [key]: "saving" } }));
    try {
      const nextSettings = await apiClient.updateAiSettings({ profileCredentials: { [profile]: { [key]: "" } } });
      setSettings(nextSettings);
      setProfileDraft((current) => current ?? nextSettings.aiConfig.profiles);
      setValues((current) => ({ ...current, [profile]: { ...current[profile], [key]: "" } }));
      setStatuses((current) => ({ ...current, [profile]: { ...current[profile], [key]: "cleared" } }));
    } catch {
      setStatuses((current) => ({ ...current, [profile]: { ...current[profile], [key]: "error" } }));
    }
  };

  const persistProfiles = useCallback(
    async (profiles: AiConfig["profiles"]) => {
      if (!settings) return;
      const saveSeq = profileSaveSeq.current + 1;
      profileSaveSeq.current = saveSeq;
      setProfileStatus("saving");
      try {
        const nextSettings = await apiClient.updateAiSettings({ aiConfig: { catalog: settings.aiConfig.catalog, profiles } as AiConfig });
        if (profileSaveSeq.current !== saveSeq) return;
        setSettings(nextSettings);
        setProfileDraft(nextSettings.aiConfig.profiles);
        setProfileStatus("saved");
      } catch {
        if (profileSaveSeq.current === saveSeq) setProfileStatus("error");
      }
    },
    [settings],
  );

  const applyProfiles = (profiles: AiConfig["profiles"], { debounce = false } = {}) => {
    setProfileDraft(profiles);
    if (profileSaveTimer.current) clearTimeout(profileSaveTimer.current);
    if (debounce) {
      profileSaveTimer.current = setTimeout(() => void persistProfiles(profiles), 650);
      setProfileStatus("idle");
      return;
    }
    void persistProfiles(profiles);
  };

  const updateImageProvider = (providerId: string) => {
    if (!profileDraft || !settings) return;
    applyProfiles({
      ...profileDraft,
      imageUnderstanding: {
        providerId,
        modelId: firstModel(settings.aiConfig, "imageUnderstanding", providerId),
        modelSource: "recommended",
      },
    });
  };

  const updateEmbeddingProvider = (providerId: string) => {
    if (!profileDraft || !settings) return;
    applyProfiles({
      ...profileDraft,
      crossModalEmbedding: {
        enabled: true,
        providerId,
        modelId: firstModel(settings.aiConfig, "crossModalEmbedding", providerId),
        modelSource: "recommended",
      },
    });
  };

  return {
    applyProfiles,
    clearField,
    embeddingCredentialKey,
    embeddingProfile,
    embeddingProviders,
    imageCredentialKey,
    imageProfile,
    imageProviders,
    profileDraft,
    profileStatus,
    saveField,
    settings,
    statuses,
    updateEmbeddingProvider,
    updateImageProvider,
    updateValue,
    values,
  };
}

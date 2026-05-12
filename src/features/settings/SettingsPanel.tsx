import { Check, ChevronDown, KeyRound, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n/useI18n";
import { apiClient, type AiConfig, type AiModelOption, type AiProviderOption, type AiSettings, type EmbeddingRebuildReport, type ImportJobProgress, type LocalAiCredential, type ProviderCredentialKey } from "@/services/apiClient";
import { useAppStore, type Locale } from "@/store/appStore";

type FieldStatus = "idle" | "loading" | "saving" | "saved" | "cleared" | "unchanged" | "error";
type ProfileKey = "imageUnderstanding" | "crossModalEmbedding";

const providerCredentialKeyById: Record<string, ProviderCredentialKey> = {
  aliyun: "aliyunApiKey",
  openai: "openaiApiKey",
  openrouter: "openrouterApiKey",
  siliconflow: "siliconflowApiKey",
  voyage: "voyageApiKey",
};

const emptyCredential: LocalAiCredential = { isSet: false, preview: "", source: "none" };

function firstModel(config: AiConfig | undefined, profile: ProfileKey, providerId: string) {
  return config?.catalog.models[profile]?.[providerId]?.[0]?.id ?? "";
}

function profileProviderOptions(config: AiConfig | undefined, profile: ProfileKey) {
  return (config?.catalog.providers ?? []).filter((provider) => provider.capabilities[profile]);
}

function profileModels(config: AiConfig | undefined, profile: ProfileKey, providerId: string | null) {
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

type ModelProfileDraft = {
  enabled?: boolean;
  providerId: string | null;
  modelId: string | null;
  modelSource: "recommended" | "custom" | null;
};

function modelLabel(models: AiModelOption[], modelId: string | null | undefined) {
  return models.find((model) => model.id === modelId)?.label ?? modelId ?? "";
}

function modelDimensionsLabel(models: AiModelOption[], modelId: string | null | undefined) {
  const dimensions = models.find((model) => model.id === modelId)?.dimensions;
  return Number.isInteger(dimensions) && dimensions ? `${dimensions}D` : "";
}

function ModelProfileSection({
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
  text: {
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

function embeddingProgressPercent(progress?: ImportJobProgress) {
  const done = progress?.steps?.embedding?.done ?? progress?.done ?? 0;
  const total = Math.max(progress?.steps?.embedding?.total ?? progress?.total ?? 0, 1);
  return Math.round((Math.min(done, total) / total) * 100);
}

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

export function SettingsPanel({ isClosing = false }: { isClosing?: boolean }) {
  const { locale, t } = useI18n();
  const setLocale = useAppStore((state) => state.setLocale);
  const photoCount = useAppStore((state) => state.photos.length);
  const loadState = useAppStore((state) => state.loadState);
  const [settings, setSettings] = useState<AiSettings>();
  const [values, setValues] = useState<Record<ProfileKey, Record<ProviderCredentialKey, string>>>({
    crossModalEmbedding: emptyProviderValues,
    imageUnderstanding: emptyProviderValues,
  });
  const [statuses, setStatuses] = useState<Record<ProfileKey, Record<ProviderCredentialKey, FieldStatus>>>({
    crossModalEmbedding: loadingProviderStatuses,
    imageUnderstanding: loadingProviderStatuses,
  });
  const [profileDraft, setProfileDraft] = useState<AiConfig["profiles"]>();
  const [profileStatus, setProfileStatus] = useState<FieldStatus>("loading");
  const [isRebuildingEmbeddings, setIsRebuildingEmbeddings] = useState(false);
  const [embeddingRebuildProgress, setEmbeddingRebuildProgress] = useState<ImportJobProgress>();
  const [embeddingRebuildError, setEmbeddingRebuildError] = useState<string>();
  const [embeddingRebuildReport, setEmbeddingRebuildReport] = useState<EmbeddingRebuildReport>();
  const profileSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const profileSaveSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    apiClient
      .getAiSettings()
      .then((nextSettings) => {
        if (!alive) return;
        setSettings(nextSettings);
        setProfileDraft(nextSettings.aiConfig.profiles);
        setStatuses({ crossModalEmbedding: idleProviderStatuses, imageUnderstanding: idleProviderStatuses });
        setProfileStatus("idle");
      })
      .catch(() => {
        if (!alive) return;
        setStatuses({ crossModalEmbedding: errorProviderStatuses, imageUnderstanding: errorProviderStatuses });
        setProfileStatus("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (profileSaveTimer.current) clearTimeout(profileSaveTimer.current);
    };
  }, []);

  const sourceLabel: Record<LocalAiCredential["source"], string> = {
    env: t("sourceEnv"),
    local: t("sourceLocal"),
    none: t("sourceNone"),
  };
  const statusText: Record<FieldStatus, string> = {
    cleared: t("statusCleared"),
    error: t("statusError"),
    idle: "",
    loading: t("statusLoading"),
    saved: t("statusSaved"),
    saving: t("statusSaving"),
    unchanged: t("statusUnchanged"),
  };

  const imageProviders = useMemo(() => profileProviderOptions(settings?.aiConfig, "imageUnderstanding"), [settings]);
  const embeddingProviders = useMemo(() => profileProviderOptions(settings?.aiConfig, "crossModalEmbedding"), [settings]);
  const modelText = {
    chooseModel: t("chooseModel"),
    chooseProviderFirst: t("chooseProviderFirst"),
    concreteModel: t("concreteModel"),
    customModelHelp: t("customModelHelp"),
    customModelId: t("customModelId"),
    delete: t("delete"),
    disable: t("disable"),
    enable: t("enable"),
    enterFullModelId: t("enterFullModelId"),
    modelProvider: t("modelProvider"),
    save: t("save"),
    savedApiKey: t("savedApiKey"),
  };

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

  const rebuildEmbeddings = async (photoIds?: string[]) => {
    if (isRebuildingEmbeddings) return;
    const retryCount = photoIds?.length ?? photoCount;
    setIsRebuildingEmbeddings(true);
    setEmbeddingRebuildError(undefined);
    setEmbeddingRebuildProgress({ phase: "queued", done: 0, total: retryCount, steps: { embedding: { done: 0, total: retryCount } } });
    try {
      const snapshot = await apiClient.rebuildPhotoEmbeddings(
        (progress) => {
          setEmbeddingRebuildProgress(progress);
        },
        photoIds,
      );
      setEmbeddingRebuildReport(snapshot.embeddingRebuild);
      await loadState();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("rebuildVectorsFailed");
      setEmbeddingRebuildError(message === "Not found" ? t("rebuildVectorsNotFound") : message);
    } finally {
      setIsRebuildingEmbeddings(false);
    }
  };

  const imageProfile = profileDraft?.imageUnderstanding;
  const embeddingProfile = profileDraft?.crossModalEmbedding;
  const imageCredentialKey = providerCredentialKey(imageProfile?.providerId);
  const embeddingCredentialKey = providerCredentialKey(embeddingProfile?.providerId);

  return (
    <section
      className="settings-panel fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12"
      data-state={isClosing ? "closing" : "open"}
    >
      <div className="mx-auto max-w-6xl">
        <div className="settings-heading mb-8 md:mb-12">
          <h2 className="font-serif text-4xl font-semibold leading-tight text-primary md:text-6xl">{t("settings")}</h2>
        </div>

        <div className="local-settings-form">
          <article className="local-secret-row local-language-row" style={{ "--local-secret-delay": "0ms" } as CSSProperties}>
            <div className="local-secret-index">00</div>
            <div className="min-w-0">
              <div className="settings-section-header">
                <h3>{t("language")}</h3>
                {(["zh", "en"] satisfies Locale[]).map((item) => (
                  <button className={`local-secret-action ${locale === item ? "" : "local-secret-action-subtle"}`} key={item} onClick={() => setLocale(item)} type="button">
                    {item === "zh" ? t("simplifiedChinese") : t("english")}
                  </button>
                ))}
              </div>
              <p className="settings-inline-note">{t("languageSwitchWarning")}</p>
            </div>
          </article>

          <article className="local-secret-row local-model-row" style={{ "--local-secret-delay": "90ms" } as CSSProperties}>
            <div className="local-secret-index">01</div>
            <div className="min-w-0">
              <div className="settings-section-header">
                <h3>{t("modelRouting")}</h3>
              </div>
              <div className="ai-model-grid">
                <ModelProfileSection
                  credential={imageCredentialKey ? settings?.profileCredentials.imageUnderstanding[imageCredentialKey] : emptyCredential}
                  credentialStatus={imageCredentialKey ? statuses.imageUnderstanding[imageCredentialKey] : profileStatus}
                  credentialValue={imageCredentialKey ? values.imageUnderstanding[imageCredentialKey] : ""}
                  description={t("visionDescription")}
                  disabled={!profileDraft}
                  locale={locale}
                  models={profileModels(settings?.aiConfig, "imageUnderstanding", imageProfile?.providerId ?? null)}
                  onApiKeyChange={(value) => {
                    if (imageCredentialKey) updateValue("imageUnderstanding", imageCredentialKey, value);
                  }}
                  onClearApiKey={() => {
                    if (imageCredentialKey) void clearField("imageUnderstanding", imageCredentialKey);
                  }}
                  onCustomModelChange={(modelId) => {
                    if (!profileDraft) return;
                    applyProfiles({ ...profileDraft, imageUnderstanding: { ...profileDraft.imageUnderstanding, modelId, modelSource: "custom" } }, { debounce: true });
                  }}
                  onModelChange={(modelId) => {
                    if (!profileDraft) return;
                    applyProfiles({ ...profileDraft, imageUnderstanding: { ...profileDraft.imageUnderstanding, modelId, modelSource: "recommended" } });
                  }}
                  onProviderChange={updateImageProvider}
                  onSaveApiKey={() => {
                    if (imageCredentialKey) void saveField("imageUnderstanding", imageCredentialKey);
                  }}
                  profile={imageProfile}
                  providers={imageProviders}
                  sourceLabel={sourceLabel}
                  statusText={statusText}
                  text={modelText}
                  title={t("vision")}
                />
                <ModelProfileSection
                  credential={embeddingCredentialKey ? settings?.profileCredentials.crossModalEmbedding[embeddingCredentialKey] : emptyCredential}
                  credentialStatus={embeddingCredentialKey ? statuses.crossModalEmbedding[embeddingCredentialKey] : profileStatus}
                  credentialValue={embeddingCredentialKey ? values.crossModalEmbedding[embeddingCredentialKey] : ""}
                  description={t("embeddingDescription")}
                  disabled={!profileDraft}
                  footer={
                    <>
                      <p className="settings-inline-note settings-inline-note-strong">{t("embeddingSwitchWarning")}</p>
                      <div className="embedding-rebuild-panel">
                        <button className="local-secret-action" disabled={isRebuildingEmbeddings || !photoCount} onClick={() => void rebuildEmbeddings()} type="button">
                          {isRebuildingEmbeddings ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                          {t("rebuildVectors")}
                        </button>
                        {embeddingRebuildProgress ? (
                          <div className="embedding-rebuild-progress" data-active={isRebuildingEmbeddings ? "true" : "false"}>
                            <div className="embedding-rebuild-track">
                              <span style={{ width: `${embeddingProgressPercent(embeddingRebuildProgress)}%` }} />
                            </div>
                            <p>
                              {t("generateVectors")} {embeddingRebuildProgress.steps?.embedding?.done ?? embeddingRebuildProgress.done} / {embeddingRebuildProgress.steps?.embedding?.total ?? embeddingRebuildProgress.total}
                              {embeddingRebuildProgress.currentFileName ? ` · ${embeddingRebuildProgress.currentFileName}` : ""}
                            </p>
                          </div>
                        ) : null}
                        {embeddingRebuildError ? <p className="embedding-rebuild-error">{embeddingRebuildError}</p> : null}
                        {embeddingRebuildReport ? (
                          <div className="embedding-rebuild-summary">
                            <p>
                              {embeddingRebuildReport.failedCount > 0
                                ? t("rebuildVectorsFailedCount").replace("{count}", String(embeddingRebuildReport.failedCount))
                                : t("rebuildVectorsComplete").replace("{count}", String(embeddingRebuildReport.successCount))}
                            </p>
                            {embeddingRebuildReport.failedCount > 0 ? (
                              <button className="local-secret-action" disabled={isRebuildingEmbeddings} onClick={() => void rebuildEmbeddings(embeddingRebuildReport.failedPhotoIds)} type="button">
                                {isRebuildingEmbeddings ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                                {t("retryFailedVectors")}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </>
                  }
                  locale={locale}
                  models={profileModels(settings?.aiConfig, "crossModalEmbedding", embeddingProfile?.providerId ?? null)}
                  onApiKeyChange={(value) => {
                    if (embeddingCredentialKey) updateValue("crossModalEmbedding", embeddingCredentialKey, value);
                  }}
                  onClearApiKey={() => {
                    if (embeddingCredentialKey) void clearField("crossModalEmbedding", embeddingCredentialKey);
                  }}
                  onCustomModelChange={(modelId) => {
                    if (!profileDraft) return;
                    applyProfiles({ ...profileDraft, crossModalEmbedding: { ...profileDraft.crossModalEmbedding, enabled: true, modelId, modelSource: "custom" } }, { debounce: true });
                  }}
                  onModelChange={(modelId) => {
                    if (!profileDraft) return;
                    applyProfiles({ ...profileDraft, crossModalEmbedding: { ...profileDraft.crossModalEmbedding, enabled: true, modelId, modelSource: "recommended" } });
                  }}
                  onProviderChange={updateEmbeddingProvider}
                  onSaveApiKey={() => {
                    if (embeddingCredentialKey) void saveField("crossModalEmbedding", embeddingCredentialKey);
                  }}
                  onToggle={(enabled) => {
                    if (!profileDraft) return;
                    if (!enabled) {
                      applyProfiles({ ...profileDraft, crossModalEmbedding: { enabled: false, providerId: null, modelId: null, modelSource: null } });
                      return;
                    }
                    const providerId = profileDraft.crossModalEmbedding.providerId ?? embeddingProviders[0]?.id ?? "aliyun";
                    applyProfiles({
                      ...profileDraft,
                      crossModalEmbedding: {
                        enabled: true,
                        providerId,
                        modelId: profileDraft.crossModalEmbedding.modelId ?? firstModel(settings?.aiConfig, "crossModalEmbedding", providerId),
                        modelSource: profileDraft.crossModalEmbedding.modelSource ?? "recommended",
                      },
                    });
                  }}
                  optional
                  profile={embeddingProfile}
                  providers={embeddingProviders}
                  sourceLabel={sourceLabel}
                  statusText={statusText}
                  text={modelText}
                  title={t("embedding")}
                />
              </div>
              {statusText[profileStatus] ? <div className="local-secret-state"><span>{statusText[profileStatus]}</span></div> : null}
            </div>
          </article>

        </div>
      </div>
    </section>
  );
}

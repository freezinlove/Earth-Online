import { LoaderCircle, RefreshCw } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import { useI18n } from "@/i18n/useI18n";
import type { EmbeddingRebuildReport, ImportJobProgress, LocalAiCredential } from "@/services/apiClient";
import { isAndroidRuntime, platformApi } from "@/platform";
import { useAppStore, type Locale } from "@/store/appStore";
import { DataStorageSection } from "@/features/settings/DataStorageSection";
import { emptyCredential, embeddingProgressPercent, firstModel, ModelProfileSection, profileModels, type FieldStatus, useAiSettingsForm } from "@/features/settings/settingsForm";

export function SettingsPanel({ isClosing = false }: { isClosing?: boolean }) {
  const { locale, t } = useI18n();
  const setLocale = useAppStore((state) => state.setLocale);
  const photoCount = useAppStore((state) => state.photos.length);
  const loadState = useAppStore((state) => state.loadState);
  const androidRuntime = isAndroidRuntime();
  const {
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
  } = useAiSettingsForm();
  const [isRebuildingEmbeddings, setIsRebuildingEmbeddings] = useState(false);
  const [embeddingRebuildProgress, setEmbeddingRebuildProgress] = useState<ImportJobProgress>();
  const [embeddingRebuildError, setEmbeddingRebuildError] = useState<string>();
  const [embeddingRebuildReport, setEmbeddingRebuildReport] = useState<EmbeddingRebuildReport>();

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
  const modelSectionIndex = androidRuntime ? "01" : "02";
  const modelSectionDelay = androidRuntime ? "90ms" : "180ms";

  const rebuildEmbeddings = async (photoIds?: string[]) => {
    if (isRebuildingEmbeddings) return;
    const retryCount = photoIds?.length ?? photoCount;
    setIsRebuildingEmbeddings(true);
    setEmbeddingRebuildError(undefined);
    setEmbeddingRebuildProgress({ phase: "queued", done: 0, total: retryCount, steps: { embedding: { done: 0, total: retryCount } } });
    try {
      const snapshot = await platformApi.rebuildPhotoEmbeddings(
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
                <div className="settings-language-actions">
                  {(["zh", "en"] satisfies Locale[]).map((item) => (
                    <button className={`local-secret-action ${locale === item ? "" : "local-secret-action-subtle"}`} key={item} onClick={() => setLocale(item)} type="button">
                      {item === "zh" ? t("simplifiedChinese") : t("english")}
                    </button>
                  ))}
                </div>
              </div>
              <p className="settings-inline-note">{t("languageSwitchWarning")}</p>
            </div>
          </article>

          {!androidRuntime ? <article className="local-secret-row local-storage-row" style={{ "--local-secret-delay": "90ms" } as CSSProperties}>
            <div className="local-secret-index">01</div>
            <div className="min-w-0">
              <div className="settings-section-header">
                <h3>{t("dataStorage")}</h3>
              </div>
              <DataStorageSection />
            </div>
          </article> : null}

          <article className="local-secret-row local-model-row" style={{ "--local-secret-delay": modelSectionDelay } as CSSProperties}>
            <div className="local-secret-index">{modelSectionIndex}</div>
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

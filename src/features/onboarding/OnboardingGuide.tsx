import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/useI18n";
import type { LocalAiCredential } from "@/services/apiClient";
import { isAndroidRuntime } from "@/platform";
import { useAppStore, type Locale } from "@/store/appStore";
import { DataStorageSection } from "@/features/settings/DataStorageSection";
import { emptyCredential, firstModel, ModelProfileSection, profileModels, type FieldStatus, useAiSettingsForm } from "@/features/settings/settingsForm";

const onboardingStorageKey = "earth-online-onboarding-complete";
const pageFadeDuration = 220;
const welcomeExitDuration = 620;
const completeHoldDuration = 1360;
const cardExitDuration = 700;

function shouldShowOnboarding() {
  if (typeof window === "undefined") return false;
  if (window.earthOnlineDesktop?.preferences?.onboardingComplete === true) return false;
  return window.localStorage.getItem(onboardingStorageKey) !== "true";
}

export function OnboardingGuide() {
  const [shouldRender, setShouldRender] = useState(() => shouldShowOnboarding());

  if (!shouldRender) return null;

  return <OnboardingGuideDialog onDismiss={() => setShouldRender(false)} />;
}

function OnboardingGuideDialog({ onDismiss }: { onDismiss: () => void }) {
  const { locale, t } = useI18n();
  const setLocale = useAppStore((state) => state.setLocale);
  const loadState = useAppStore((state) => state.loadState);
  const [isStorageReady, setIsStorageReady] = useState(() => {
    if (typeof window === "undefined") return false;
    if (isAndroidRuntime()) return true;
    const desktopStorage = window.earthOnlineDesktop?.getStorage?.() ?? window.earthOnlineDesktop?.storage;
    if (desktopStorage) return desktopStorage.backendReady === true && desktopStorage.restartRequired !== true;
    return false;
  });
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
  } = useAiSettingsForm(isStorageReady);
  const [isClosing, setIsClosing] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [stage, setStage] = useState<"welcome" | "setup">("welcome");
  const [isWelcomeClosing, setIsWelcomeClosing] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [isPageClosing, setIsPageClosing] = useState(false);
  const [hasChosenLanguage, setHasChosenLanguage] = useState(() => {
    if (typeof window === "undefined") return true;
    const storedLocale = window.localStorage.getItem("earth-online-locale");
    return storedLocale === "zh" || storedLocale === "en";
  });
  const pageTimer = useRef<number | undefined>(undefined);
  const welcomeTimer = useRef<number | undefined>(undefined);
  const completeTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const androidRuntime = isAndroidRuntime();
  const storagePageIndex = androidRuntime ? -1 : 1;
  const lastSetupPageIndex = androidRuntime ? 2 : 3;
  const visionStep = androidRuntime ? "01" : "02";
  const embeddingStep = androidRuntime ? "02" : "03";

  useEffect(() => {
    return () => {
      window.clearTimeout(pageTimer.current);
      window.clearTimeout(welcomeTimer.current);
      window.clearTimeout(completeTimer.current);
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (isStorageReady) void loadState();
  }, [isStorageReady, loadState]);

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

  const moveToPage = (nextPage: number) => {
    if (stage !== "setup" || nextPage === pageIndex || isPageClosing || isComplete) return;
    window.clearTimeout(pageTimer.current);
    setIsPageClosing(true);
    pageTimer.current = window.setTimeout(() => {
      setPageIndex(nextPage);
      setIsPageClosing(false);
    }, pageFadeDuration);
  };

  const enterSetup = () => {
    if (stage !== "welcome" || isWelcomeClosing || isComplete) return;
    window.clearTimeout(welcomeTimer.current);
    setIsWelcomeClosing(true);
    welcomeTimer.current = window.setTimeout(() => {
      setStage("setup");
      setIsWelcomeClosing(false);
    }, welcomeExitDuration);
  };

  const finishOnboarding = () => {
    if (isClosing || isComplete) return;
    window.localStorage.setItem(onboardingStorageKey, "true");
    window.earthOnlineDesktop?.setOnboardingComplete?.(true);
    setIsComplete(true);
    window.clearTimeout(completeTimer.current);
    window.clearTimeout(closeTimer.current);
    completeTimer.current = window.setTimeout(() => {
      setIsClosing(true);
      closeTimer.current = window.setTimeout(onDismiss, cardExitDuration);
    }, completeHoldDuration);
  };

  const goNext = () => {
    if (stage === "welcome") {
      enterSetup();
      return;
    }
    if (pageIndex === storagePageIndex && !isStorageReady) return;
    if (pageIndex === lastSetupPageIndex) {
      finishOnboarding();
      return;
    }
    moveToPage(pageIndex + 1);
  };

  const chooseLocale = (nextLocale: Locale) => {
    setLocale(nextLocale);
    setHasChosenLanguage(true);
  };
  const languageTitle = hasChosenLanguage ? t("language") : "语言 / Language";

  const pages = [
    <div className="onboarding-language-page" key="language">
      <p className="onboarding-kicker">00</p>
      <div className="onboarding-language-body">
        <div className="onboarding-language-heading">
          <h2>{languageTitle}</h2>
        </div>
        <p>{t("onboardingLanguageCopy")}</p>
        <div className="onboarding-language-selector">
          <div className="onboarding-language-actions">
            {(["zh", "en"] satisfies Locale[]).map((item) => (
              <button
                aria-pressed={hasChosenLanguage && locale === item}
                className={`local-secret-action ${hasChosenLanguage && locale === item ? "" : "local-secret-action-subtle"}`}
                key={item}
                onClick={() => chooseLocale(item)}
                type="button"
              >
                {item === "zh" ? t("simplifiedChinese") : t("english")}
              </button>
            ))}
          </div>
        </div>
        <p className="settings-inline-note">{t("languageSwitchWarning")}</p>
      </div>
    </div>,
    ...(!androidRuntime
      ? [
          <div className="onboarding-storage-page" key="storage">
            <p className="onboarding-kicker">01</p>
            <DataStorageSection onReadyChange={setIsStorageReady} variant="onboarding" />
          </div>,
        ]
      : []),
    <div className="onboarding-model-page" key="vision">
      <p className="onboarding-kicker">{visionStep}</p>
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
        title={t("onboardingVisionTitle")}
      />
      {statusText[profileStatus] ? <div className="local-secret-state"><span>{statusText[profileStatus]}</span></div> : null}
    </div>,
    <div className="onboarding-model-page" key="embedding">
      <p className="onboarding-kicker">{embeddingStep}</p>
      <ModelProfileSection
        credential={embeddingCredentialKey ? settings?.profileCredentials.crossModalEmbedding[embeddingCredentialKey] : emptyCredential}
        credentialStatus={embeddingCredentialKey ? statuses.crossModalEmbedding[embeddingCredentialKey] : profileStatus}
        credentialValue={embeddingCredentialKey ? values.crossModalEmbedding[embeddingCredentialKey] : ""}
        description={`${t("onboardingEmbeddingOptional")} ${t("embeddingDescription")}`}
        disabled={!profileDraft}
        footer={<p className="settings-inline-note settings-inline-note-strong">{t("embeddingSwitchWarning")}</p>}
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
        title={t("onboardingEmbeddingTitle")}
      />
      {statusText[profileStatus] ? <div className="local-secret-state"><span>{statusText[profileStatus]}</span></div> : null}
    </div>,
  ];

  return (
    <div className="onboarding-overlay" data-state={isClosing ? "closing" : "open"}>
      <section className="onboarding-card" data-mode={isComplete ? "complete" : stage} data-state={isClosing ? "closing" : "open"} aria-modal="true" role="dialog">
        {isComplete ? (
          <div className="onboarding-complete">
            <h2>{t("startJourney")}</h2>
          </div>
        ) : stage === "welcome" ? (
          <>
            <div className="onboarding-page-viewport onboarding-welcome-viewport">
              <div className="onboarding-welcome" data-state={isWelcomeClosing ? "closing" : "open"}>
                <h1 aria-label={t("onboardingWelcomeTitle")}>
                  <span>Welcome to</span>
                  <span>Earth_Online</span>
                </h1>
              </div>
            </div>
            <div className="onboarding-footer onboarding-footer-welcome">
              <button aria-label={t("onboardingNext")} className="onboarding-icon-button" disabled={isWelcomeClosing} onClick={goNext} type="button">
                <ChevronRight size={26} strokeWidth={1.9} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="onboarding-page-viewport">
              <div className="onboarding-page" data-state={isPageClosing ? "closing" : "open"} key={pageIndex}>
                {pages[pageIndex]}
              </div>
            </div>
            <div className="onboarding-footer">
              {pageIndex > 0 ? (
                <button aria-label={t("onboardingPrevious")} className="onboarding-icon-button" disabled={isPageClosing} onClick={() => moveToPage(pageIndex - 1)} type="button">
                  <ChevronLeft size={24} strokeWidth={1.9} />
                </button>
              ) : (
                <span className="onboarding-icon-button-spacer" />
              )}
              <div className="onboarding-dots" aria-hidden="true">
                {pages.map((_page, item) => (
                  <span className={item === pageIndex ? "is-active" : ""} key={item} />
                ))}
              </div>
              <button
                aria-label={pageIndex === lastSetupPageIndex ? t("onboardingFinish") : t("onboardingNext")}
                className="onboarding-icon-button"
                disabled={isPageClosing || (pageIndex === storagePageIndex && !isStorageReady)}
                onClick={goNext}
                type="button"
              >
                {pageIndex === lastSetupPageIndex ? <Check size={24} strokeWidth={2} /> : <ChevronRight size={24} strokeWidth={1.9} />}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

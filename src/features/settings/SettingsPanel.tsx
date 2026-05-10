import { Check, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n/useI18n";
import { apiClient, type LocalAiCredential, type LocalAiSettings } from "@/services/apiClient";
import { useAppStore, type Locale } from "@/store/appStore";

type SecretField = keyof LocalAiSettings;
type FieldStatus = "idle" | "loading" | "saving" | "saved" | "cleared" | "unchanged" | "error";

const fields: Array<{
  key: SecretField;
  title: string;
  model: string;
}> = [
  { key: "qwenChatApiKey", title: "Qwen 3.5 Flash", model: "LLM" },
  { key: "qwenEmbeddingApiKey", title: "Qwen Vision Embedding", model: "Embedding" },
];

const emptyCredential: LocalAiCredential = { isSet: false, preview: "", source: "none" };

export function SettingsPanel({ isClosing = false }: { isClosing?: boolean }) {
  const { locale, t } = useI18n();
  const setLocale = useAppStore((state) => state.setLocale);
  const [settings, setSettings] = useState<LocalAiSettings>();
  const [values, setValues] = useState<Record<SecretField, string>>({
    qwenChatApiKey: "",
    qwenEmbeddingApiKey: "",
  });
  const [statuses, setStatuses] = useState<Record<SecretField, FieldStatus>>({
    qwenChatApiKey: "loading",
    qwenEmbeddingApiKey: "loading",
  });

  useEffect(() => {
    let alive = true;

    apiClient
      .getLocalAiSettings()
      .then((nextSettings) => {
        if (!alive) return;
        setSettings(nextSettings);
        setStatuses({ qwenChatApiKey: "idle", qwenEmbeddingApiKey: "idle" });
      })
      .catch(() => {
        if (!alive) return;
        setStatuses({ qwenChatApiKey: "error", qwenEmbeddingApiKey: "error" });
      });

    return () => {
      alive = false;
    };
  }, []);

  const updateValue = (key: SecretField, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setStatuses((current) => ({ ...current, [key]: "idle" }));
  };

  const saveField = async (key: SecretField) => {
    const nextValue = values[key].trim();
    if (!nextValue) {
      setStatuses((current) => ({ ...current, [key]: "unchanged" }));
      return;
    }

    setStatuses((current) => ({ ...current, [key]: "saving" }));
    try {
      const nextSettings = await apiClient.updateLocalAiSettings({ [key]: nextValue });
      setSettings(nextSettings);
      setValues((current) => ({ ...current, [key]: "" }));
      setStatuses((current) => ({ ...current, [key]: "saved" }));
    } catch {
      setStatuses((current) => ({ ...current, [key]: "error" }));
    }
  };

  const clearField = async (key: SecretField) => {
    setStatuses((current) => ({ ...current, [key]: "saving" }));
    try {
      const nextSettings = await apiClient.updateLocalAiSettings({ [key]: "" });
      setSettings(nextSettings);
      setValues((current) => ({ ...current, [key]: "" }));
      setStatuses((current) => ({ ...current, [key]: "cleared" }));
    } catch {
      setStatuses((current) => ({ ...current, [key]: "error" }));
    }
  };
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
          <article className="local-secret-row" style={{ "--local-secret-delay": "0ms" } as CSSProperties}>
            <div className="local-secret-index">00</div>
            <div className="min-w-0">
              <h3 className="font-serif text-2xl font-semibold leading-tight text-on-surface md:text-3xl">{t("language")}</h3>
              <div className="mt-5 flex flex-wrap gap-3">
                {(["zh", "en"] satisfies Locale[]).map((item) => (
                  <button
                    className={`local-secret-action ${locale === item ? "" : "local-secret-action-subtle"}`}
                    key={item}
                    onClick={() => setLocale(item)}
                    type="button"
                  >
                    {item === "zh" ? t("simplifiedChinese") : t("english")}
                  </button>
                ))}
              </div>
            </div>
          </article>
          {fields.map((field, index) => {
            const credential = settings?.[field.key] ?? emptyCredential;
            const status = statuses[field.key];
            const isSaving = status === "saving";
            const canClearLocal = credential.source === "local" && !isSaving;
            const canSave = Boolean(values[field.key].trim()) && !isSaving;

            return (
              <article className="local-secret-row" key={field.key} style={{ "--local-secret-delay": `${(index + 1) * 90}ms` } as CSSProperties}>
                <div className="local-secret-index">0{index + 1}</div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <h3 className="font-serif text-2xl font-semibold leading-tight text-on-surface md:text-3xl">{field.title}</h3>
                    <span className="local-secret-model">{field.model}</span>
                  </div>
                  <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
                    <label className="local-secret-input-shell">
                      <KeyRound size={18} />
                      <input
                        className="local-secret-input"
                        value={values[field.key]}
                        onChange={(event) => updateValue(field.key, event.target.value)}
                        placeholder={credential.isSet ? `${t("savedApiKey")}: ${credential.preview}` : t("pasteApiKey")}
                        aria-label={field.title}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <button className="local-secret-action" disabled={!canSave} onClick={() => void saveField(field.key)} type="button">
                      {isSaving ? <LoaderCircle className="animate-spin" size={16} /> : <Check size={16} />}
                      {t("save")}
                    </button>
                    <button className="local-secret-action local-secret-action-subtle" disabled={!canClearLocal} onClick={() => void clearField(field.key)} type="button">
                      <Trash2 size={16} />
                      {t("clear")}
                    </button>
                  </div>
                  <div className="local-secret-state">
                    <span>{sourceLabel[credential.source]}</span>
                    {statusText[status] ? <span>{statusText[status]}</span> : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

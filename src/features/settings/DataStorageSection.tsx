import { FolderOpen, HardDrive, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { apiClient, type DesktopStorageSettings, type StorageSettings } from "@/services/apiClient";
import { useI18n } from "@/i18n/useI18n";

type StorageStatus = "idle" | "loading" | "saved" | "unchanged" | "error" | "restarting";

function desktopStorage() {
  if (typeof window === "undefined") return undefined;
  return window.earthOnlineDesktop?.getStorage?.() ?? window.earthOnlineDesktop?.storage;
}

function PathLine({ label, value }: { label: string; value?: string }) {
  return (
    <div className="data-storage-path-line">
      <span>{label}</span>
      <code title={value}>{value || "..."}</code>
    </div>
  );
}

export function DataStorageSection({ onReadyChange, variant = "settings" }: { onReadyChange?: (ready: boolean) => void; variant?: "settings" | "onboarding" }) {
  const { t } = useI18n();
  const [backendStorage, setBackendStorage] = useState<StorageSettings>();
  const [desktopStorageState, setDesktopStorageState] = useState<DesktopStorageSettings | undefined>(() => desktopStorage());
  const [status, setStatus] = useState<StorageStatus>(() => (desktopStorage()?.backendReady === false ? "idle" : "loading"));
  const desktopBridge = typeof window === "undefined" ? undefined : window.earthOnlineDesktop;
  const shouldReadBackendStorage = !desktopStorageState || desktopStorageState.backendReady;

  useEffect(() => {
    if (!shouldReadBackendStorage) {
      setStatus("idle");
      return;
    }
    let alive = true;
    apiClient
      .getStorageSettings()
      .then((storage) => {
        if (!alive) return;
        setBackendStorage(storage);
        setStatus("idle");
      })
      .catch(() => {
        if (!alive) return;
        setStatus("error");
      });
    return () => {
      alive = false;
    };
  }, [shouldReadBackendStorage]);

  const activeDataDir = desktopStorageState?.currentDataDir ?? backendStorage?.dataDir;
  const configuredDataDir = desktopStorageState?.configuredDataDir;
  const restartRequired = Boolean(desktopStorageState?.restartRequired);
  const storageReady = desktopStorageState ? desktopStorageState.backendReady && !restartRequired : Boolean(backendStorage?.dataDir);
  const canChooseDirectory = Boolean(desktopStorageState?.canChooseDirectory && desktopBridge?.chooseDataDirectory);
  const canOpenDirectory = Boolean(desktopBridge?.openDataDirectory && activeDataDir);
  const statusText =
    status === "loading"
      ? t("dataStorageLoading")
      : status === "saved"
        ? t("dataStorageSaved")
        : status === "unchanged"
          ? t("dataStorageUnchanged")
          : status === "error"
            ? t("dataStorageError")
            : status === "restarting"
              ? t("dataStorageRestart")
              : "";

  useEffect(() => {
    onReadyChange?.(storageReady);
  }, [onReadyChange, storageReady]);

  const chooseDirectory = async () => {
    if (!desktopBridge?.chooseDataDirectory || status === "loading") return;
    setStatus("loading");
    try {
      const nextStorage = await desktopBridge.chooseDataDirectory();
      setDesktopStorageState(nextStorage);
      onReadyChange?.(nextStorage.backendReady && !nextStorage.restartRequired);
      setStatus(nextStorage.restartRequired || nextStorage.backendReady ? "saved" : "unchanged");
    } catch {
      setStatus("error");
    }
  };

  const openDirectory = async () => {
    if (!desktopBridge?.openDataDirectory) return;
    try {
      await desktopBridge.openDataDirectory();
    } catch {
      setStatus("error");
    }
  };

  const restartApp = () => {
    if (!desktopBridge?.relaunch) return;
    setStatus("restarting");
    desktopBridge.relaunch();
  };

  return (
    <section className={`data-storage-section data-storage-section-${variant}`}>
      {variant === "onboarding" ? (
        <div className="data-storage-heading">
          <h2>{t("onboardingStorageTitle")}</h2>
          <p>{t("onboardingStorageCopy")}</p>
        </div>
      ) : (
        <p className="data-storage-copy">{t("dataStorageDescription")}</p>
      )}

      <div className="data-storage-paths">
        <PathLine label={t("dataStorageCurrent")} value={activeDataDir ?? (desktopStorageState?.needsInitialDataDir ? t("dataStorageNotConfigured") : undefined)} />
        {restartRequired ? <PathLine label={t("dataStorageNext")} value={configuredDataDir} /> : null}
      </div>

      {variant === "settings" ? <p className="settings-inline-note settings-inline-note-strong">{t("dataStorageNoMigration")}</p> : null}
      {desktopStorageState?.envOverride ? <p className="settings-inline-note settings-inline-note-strong">{t("dataStorageEnvOverride")}</p> : null}
      {!desktopStorageState ? <p className="settings-inline-note">{t("dataStorageDesktopOnly")}</p> : null}

      <div className="data-storage-actions">
        <button className="local-secret-action" disabled={!canChooseDirectory || status === "loading"} onClick={() => void chooseDirectory()} type="button">
          <HardDrive size={16} />
          {t("dataStorageChoose")}
        </button>
        <button className="local-secret-action local-secret-action-subtle" disabled={!canOpenDirectory} onClick={() => void openDirectory()} type="button">
          <FolderOpen size={16} />
          {t("dataStorageOpen")}
        </button>
        {restartRequired ? (
          <button className="local-secret-action" onClick={restartApp} type="button">
            <RotateCcw size={16} />
            {t("dataStorageRestart")}
          </button>
        ) : null}
      </div>

      {statusText ? (
        <div className="local-secret-state">
          <span>{statusText}</span>
        </div>
      ) : null}
    </section>
  );
}

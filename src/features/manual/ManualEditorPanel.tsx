import { MapPinned, X } from "lucide-react";
import { useI18n } from "@/i18n/useI18n";
import { useAppStore } from "@/store/appStore";

export function ManualEditorPanel() {
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const { t } = useI18n();

  return (
    <section className="fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12">
      <div className="mx-auto flex min-h-[70vh] max-w-4xl items-center justify-center">
        <div className="safe-panel w-full rounded-[28px] p-8 text-center md:p-12">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-primary-fixed text-primary">
            <MapPinned size={24} />
          </div>
          <h2 className="mt-6 font-serif text-4xl font-semibold text-primary md:text-5xl">{t("manualPlaceholderTitle")}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-on-surface-variant">{t("manualPlaceholderBody")}</p>
          <button
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white shadow-soft"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            <X size={16} />
            {t("back")}
          </button>
        </div>
      </div>
    </section>
  );
}

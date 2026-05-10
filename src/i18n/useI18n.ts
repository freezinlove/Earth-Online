import { messages, type MessageKey } from "@/i18n/messages";
import { useAppStore } from "@/store/appStore";

export function useI18n() {
  const locale = useAppStore((state) => state.locale);
  return {
    locale,
    t: (key: MessageKey) => messages[locale][key] ?? messages.zh[key],
  };
}

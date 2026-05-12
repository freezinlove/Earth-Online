import { getAiConfig } from "../ai/ai-config.mjs";

export function createSettingsService({ rootDir, secretProvider }) {
  return {
    localAiSettings() {
      return secretProvider.getLocalAiSettings();
    },
    updateLocalAiSettings(body) {
      return secretProvider.updateLocalAiSettings(body);
    },
    aiSettings() {
      const settings = secretProvider.getAiSettings();
      return {
        ...settings,
        aiConfig: getAiConfig({ rootDir, secretProvider }),
      };
    },
    updateAiSettings(body) {
      secretProvider.updateAiSettings(body);
      const settings = secretProvider.getAiSettings();
      return {
        ...settings,
        aiConfig: getAiConfig({ rootDir, secretProvider }),
      };
    },
  };
}

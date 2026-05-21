import { getAiConfig } from "../ai/ai-config.mjs";

export function createSettingsService({ rootDir, secretProvider, paths }) {
  return {
    storageSettings() {
      return {
        dataDir: paths.dataDir,
        dbPath: paths.dbPath,
        aiInputDir: paths.aiInputDir,
        displayDir: paths.displayDir,
        importJobDir: paths.importJobDir,
        photoDir: paths.photoDir,
        rootDir,
        source: process.env.EARTH_ONLINE_DESKTOP === "1" ? "desktop" : process.env.EARTH_ONLINE_DATA_DIR ? "env" : "project",
        thumbDir: paths.thumbDir,
        vectorPath: paths.vectorPath,
      };
    },
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

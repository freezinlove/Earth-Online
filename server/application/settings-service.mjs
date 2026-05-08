export function createSettingsService({ secretProvider }) {
  return {
    localAiSettings() {
      return secretProvider.getLocalAiSettings();
    },
    updateLocalAiSettings(body) {
      return secretProvider.updateLocalAiSettings(body);
    },
  };
}

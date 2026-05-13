const { contextBridge, ipcRenderer } = require("electron");

const desktopConfig = ipcRenderer.sendSync("earth-online:get-desktop-config");
let currentStorage = desktopConfig.storage;
let currentApiBaseUrl = desktopConfig.storage?.apiBaseUrl;

const desktopBridge = {
  apiBaseUrl: currentApiBaseUrl,
  apiToken: desktopConfig.apiToken,
  platform: process.platform,
  preferences: {
    onboardingComplete: desktopConfig.preferences?.onboardingComplete === true,
  },
  storage: currentStorage,
  getApiBaseUrl() {
    return currentApiBaseUrl;
  },
  getStorage() {
    return currentStorage;
  },
  async chooseDataDirectory() {
    const storage = await ipcRenderer.invoke("earth-online:choose-data-dir");
    currentStorage = storage;
    currentApiBaseUrl = storage?.apiBaseUrl;
    desktopBridge.storage = storage;
    desktopBridge.apiBaseUrl = currentApiBaseUrl;
    return storage;
  },
  async openDataDirectory() {
    return ipcRenderer.invoke("earth-online:open-data-dir");
  },
  relaunch() {
    ipcRenderer.send("earth-online:relaunch");
  },
  setOnboardingComplete(complete) {
    ipcRenderer.send("earth-online:set-onboarding-complete", complete === true);
  },
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld("earthOnlineDesktop", desktopBridge);

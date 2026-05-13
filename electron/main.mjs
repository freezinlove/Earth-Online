import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDevelopment = !app.isPackaged || Boolean(process.env.ELECTRON_DEV_SERVER_URL);
const devServerUrl = process.env.ELECTRON_DEV_SERVER_URL;
const desktopToken = process.env.EARTH_ONLINE_DESKTOP_TOKEN || randomBytes(32).toString("hex");
let desktopPrefsPath;
let desktopPrefs = {};
let activeDataDir;
let externalDataDirOverride;
let api;
let bootstrapServer;
let bootstrapAddress;
let mainWindow;
let isQuitting = false;

if (process.env.EARTH_ONLINE_USER_DATA_DIR) {
  mkdirSync(process.env.EARTH_ONLINE_USER_DATA_DIR, { recursive: true });
  app.setPath("userData", process.env.EARTH_ONLINE_USER_DATA_DIR);
}

function sourceGeodataPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "geodata", "geonames.sqlite");
  return path.resolve(__dirname, "..", "external", "geodata", "geonames.sqlite");
}

async function ensureDesktopGeodata(userDataPath) {
  if (process.env.EARTH_ONLINE_GEODATA_PATH) return process.env.EARTH_ONLINE_GEODATA_PATH;

  const source = sourceGeodataPath();
  const targetDir = path.join(userDataPath, "geodata");
  const target = path.join(targetDir, "geonames.sqlite");
  if (!existsSync(target) && existsSync(source)) {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(source, target);
  }
  return existsSync(target) ? target : source;
}

function readDesktopPrefs(userDataPath) {
  desktopPrefsPath = path.join(userDataPath, "desktop-preferences.json");
  if (!existsSync(desktopPrefsPath)) {
    desktopPrefs = {};
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(desktopPrefsPath, "utf8"));
    desktopPrefs = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    desktopPrefs = {};
  }
}

function writeDesktopPrefs() {
  if (!desktopPrefsPath) return;
  mkdirSync(path.dirname(desktopPrefsPath), { recursive: true });
  writeFileSync(desktopPrefsPath, `${JSON.stringify(desktopPrefs, null, 2)}\n`, "utf8");
}

function normalizeDataDir(value) {
  return typeof value === "string" && value.trim() ? path.resolve(value.trim()) : undefined;
}

function defaultDesktopDataDir(userDataPath) {
  return path.join(userDataPath, "data");
}

function savedDesktopDataDir() {
  return externalDataDirOverride ?? normalizeDataDir(desktopPrefs.dataDir);
}

function configuredDesktopDataDir(userDataPath) {
  return savedDesktopDataDir() ?? defaultDesktopDataDir(userDataPath);
}

async function ensureDataDirManifest(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const manifestPath = path.join(dataDir, "earth-online-data.json");
  if (existsSync(manifestPath)) return;
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        app: "Earth_Online",
        version: 1,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function dataDirStorageConfig() {
  const userDataPath = app.getPath("userData");
  const savedDataDir = savedDesktopDataDir();
  const configuredDataDir = configuredDesktopDataDir(userDataPath);
  const currentDataDir = normalizeDataDir(activeDataDir);
  const envOverride = Boolean(externalDataDirOverride);
  const restartRequired = Boolean(api && savedDataDir && currentDataDir && normalizeDataDir(savedDataDir) !== normalizeDataDir(currentDataDir));

  return {
    apiBaseUrl: api?.url,
    backendReady: Boolean(api && currentDataDir),
    canChooseDirectory: !envOverride,
    configuredDataDir,
    currentDataDir,
    defaultDataDir: defaultDesktopDataDir(userDataPath),
    envOverride,
    isConfigured: Boolean(savedDataDir),
    needsInitialDataDir: !currentDataDir && !api,
    restartRequired,
    userDataDir: userDataPath,
  };
}

async function configureDesktopEnvironment() {
  const userDataPath = app.getPath("userData");
  readDesktopPrefs(userDataPath);
  process.env.EARTH_ONLINE_DESKTOP = "1";
  process.env.EARTH_ONLINE_DESKTOP_TOKEN = desktopToken;
  externalDataDirOverride = normalizeDataDir(process.env.EARTH_ONLINE_DATA_DIR);
  activeDataDir = savedDesktopDataDir();
  if (activeDataDir) process.env.EARTH_ONLINE_DATA_DIR = activeDataDir;
  process.env.EARTH_ONLINE_GEODATA_PATH = await ensureDesktopGeodata(userDataPath);
  process.env.EARTH_ONLINE_PORT ||= isDevelopment ? "8787" : "0";
}

function appIconPath() {
  return path.resolve(__dirname, "..", "docs", "gugugaga.png");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeRunSmokeRendererChecks(window) {
  const reportPath = process.env.EARTH_ONLINE_SMOKE_RENDERER_REPORT;
  if (!reportPath) return;

  await wait(1500);
  const before = await window.webContents.executeJavaScript(`({
    title: document.title,
    onboardingVisible: Boolean(document.querySelector(".onboarding-overlay")),
    desktopPreferenceComplete: window.earthOnlineDesktop?.preferences?.onboardingComplete === true,
    desktopStorageCurrentDataDir: window.earthOnlineDesktop?.storage?.currentDataDir,
    desktopStorageCanChooseDirectory: window.earthOnlineDesktop?.storage?.canChooseDirectory === true,
    desktopStorageEnvOverride: window.earthOnlineDesktop?.storage?.envOverride === true
  })`);

  if (process.env.EARTH_ONLINE_SMOKE_MARK_ONBOARDING_COMPLETE === "1") {
    await window.webContents.executeJavaScript(`
      window.earthOnlineDesktop?.setOnboardingComplete?.(true);
      window.localStorage.setItem("earth-online-onboarding-complete", "true");
      true;
    `);
    await wait(300);
  }

  let storageFlow;
  if (process.env.EARTH_ONLINE_SMOKE_INITIAL_STORAGE_FLOW === "1") {
    storageFlow = await window.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const nextButton = () => document.querySelector(".onboarding-footer .onboarding-icon-button:last-child");
        nextButton()?.click();
        await wait(760);
        nextButton()?.click();
        await wait(360);
        const beforeChoose = {
          nextDisabled: nextButton()?.disabled === true,
          storageReady: window.earthOnlineDesktop?.getStorage?.()?.backendReady === true,
          dotCount: document.querySelectorAll(".onboarding-dots span").length
        };
        document.querySelector(".data-storage-actions .local-secret-action")?.click();
        await wait(1200);
        const storage = window.earthOnlineDesktop?.getStorage?.();
        const afterChoose = {
          nextDisabled: nextButton()?.disabled === true,
          storageReady: window.earthOnlineDesktop?.getStorage?.()?.backendReady === true,
          currentDataDir: storage?.currentDataDir,
          apiBaseUrl: window.earthOnlineDesktop?.getApiBaseUrl?.()
        };
        nextButton()?.click();
        await wait(520);
        return {
          beforeChoose,
          afterChoose,
          afterNext: {
            visionVisible: document.body.innerText.includes("AI 视觉理解模型") || document.body.innerText.includes("AI vision model")
          }
        };
      })()
    `);
  }

  const after = await window.webContents.executeJavaScript(`({
    title: document.title,
    onboardingVisible: Boolean(document.querySelector(".onboarding-overlay")),
    desktopPreferenceComplete: window.earthOnlineDesktop?.preferences?.onboardingComplete === true,
    desktopStorageCurrentDataDir: window.earthOnlineDesktop?.storage?.currentDataDir,
    desktopStorageCanChooseDirectory: window.earthOnlineDesktop?.storage?.canChooseDirectory === true,
    desktopStorageEnvOverride: window.earthOnlineDesktop?.storage?.envOverride === true
  })`);

  appendFileSync(reportPath, `${JSON.stringify({ before, after, markOnboardingComplete: process.env.EARTH_ONLINE_SMOKE_MARK_ONBOARDING_COMPLETE === "1", storageFlow })}\n`, "utf8");
}

function allowedNavigationOrigins(loadUrl, apiUrl) {
  return new Set(
    [loadUrl, apiUrl, devServerUrl]
      .filter(Boolean)
      .map((url) => {
        try {
          return new URL(url).origin;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean),
  );
}

function guardExternalNavigation(window, loadUrl, apiUrl) {
  const allowedOrigins = allowedNavigationOrigins(loadUrl, apiUrl);
  const allowUrl = (targetUrl) => {
    try {
      return allowedOrigins.has(new URL(targetUrl).origin);
    } catch {
      return false;
    }
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!allowUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (allowUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
}

async function startApi() {
  if (!activeDataDir) throw new Error("Earth_Online data directory is not configured.");
  process.env.EARTH_ONLINE_DATA_DIR = activeDataDir;
  const { startEarthOnlineApiServer } = await import("../server/create-server.mjs");
  api = await startEarthOnlineApiServer({ host: "127.0.0.1", port: Number(process.env.EARTH_ONLINE_PORT) });
  console.log(`Earth_Online desktop API listening on ${api.url}`);
  return api;
}

async function startBootstrapServer() {
  if (devServerUrl) return { url: devServerUrl };
  const { serveStatic } = await import("../server/storage/file-storage.mjs");
  const distDir = path.resolve(__dirname, "..", "dist");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "GET" && (await serveStatic(req, res, url.pathname, { distDir }))) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.EARTH_ONLINE_PORT), "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : Number(process.env.EARTH_ONLINE_PORT);
  bootstrapServer = server;
  bootstrapAddress = { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}` };
  process.env.EARTH_ONLINE_PORT = String(port);
  return bootstrapAddress;
}

async function closeBootstrapServer() {
  const current = bootstrapServer;
  bootstrapServer = undefined;
  bootstrapAddress = undefined;
  if (!current) return;
  await new Promise((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())));
}

async function createMainWindow(loadUrl, apiUrl) {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    autoHideMenuBar: true,
    show: false,
    title: "Earth_Online",
    backgroundColor: "#faf9f5",
    icon: appIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.setMenuBarVisibility(false);
  guardExternalNavigation(mainWindow, loadUrl, apiUrl);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  await mainWindow.loadURL(loadUrl);
  void maybeRunSmokeRendererChecks(mainWindow);
  if (isDevelopment) mainWindow.webContents.openDevTools({ mode: "detach" });
}

async function closeApi() {
  const currentApi = api;
  api = undefined;
  if (currentApi) await currentApi.close();
}

async function startApiAfterInitialDataDirSelection() {
  if (api) return api;
  await closeBootstrapServer();
  return startApi();
}

ipcMain.on("earth-online:get-desktop-config", (event) => {
  event.returnValue = {
    apiToken: desktopToken,
    preferences: {
      onboardingComplete: desktopPrefs.onboardingComplete === true,
    },
    storage: dataDirStorageConfig(),
  };
});

ipcMain.on("earth-online:set-onboarding-complete", (_event, complete) => {
  desktopPrefs = { ...desktopPrefs, onboardingComplete: complete === true };
  writeDesktopPrefs();
});

ipcMain.handle("earth-online:choose-data-dir", async () => {
  const storage = dataDirStorageConfig();
  if (!storage.canChooseDirectory) return storage;

  let selectedDataDir = normalizeDataDir(process.env.EARTH_ONLINE_SMOKE_SELECT_DATA_DIR);
  if (!selectedDataDir) {
    const options = {
      title: "选择 Earth_Online 数据存储位置",
      defaultPath: storage.configuredDataDir,
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return storage;
    selectedDataDir = path.resolve(result.filePaths[0]);
  }
  await ensureDataDirManifest(selectedDataDir);
  desktopPrefs = { ...desktopPrefs, dataDir: selectedDataDir };
  writeDesktopPrefs();

  if (!api) {
    activeDataDir = selectedDataDir;
    await startApiAfterInitialDataDirSelection();
    return dataDirStorageConfig();
  }

  return dataDirStorageConfig();
});

ipcMain.handle("earth-online:open-data-dir", async () => {
  const storage = dataDirStorageConfig();
  const targetDir = storage.currentDataDir ?? storage.configuredDataDir;
  await fs.mkdir(targetDir, { recursive: true });
  const error = await shell.openPath(targetDir);
  return !error;
});

ipcMain.on("earth-online:relaunch", () => {
  app.relaunch();
  app.quit();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady()
    .then(async () => {
      await configureDesktopEnvironment();
      if (activeDataDir) {
        const startedApi = await startApi();
        await createMainWindow(devServerUrl || startedApi.url, startedApi.url);
        return;
      }
      const bootstrap = await startBootstrapServer();
      await createMainWindow(bootstrap.url);
    })
    .catch((error) => {
      console.error(error);
      void dialog.showErrorBox("Earth Online 启动失败", error instanceof Error ? error.message : String(error));
      app.quit();
    });

  app.on("activate", () => {
    if (!mainWindow && api) void createMainWindow(devServerUrl || api.url, api.url);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    void Promise.allSettled([closeApi(), closeBootstrapServer()]).finally(() => app.quit());
  });
}

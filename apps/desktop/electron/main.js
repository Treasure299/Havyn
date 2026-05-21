import { app, BrowserView, BrowserWindow, dialog, ipcMain, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
let mainWindow;
let activeTabId;
let currentBounds;
let mediaEventTimer;
const tabs = new Map();
const loadedExtensions = new Map();
let adBlockEnabled = false;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
app.userAgentFallback = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

const profileName = process.env.HAVYN_PROFILE;
if (profileName) {
  app.setPath("userData", path.join(app.getPath("userData"), `profile-${profileName}`));
}

function browserPartition() {
  return `persist:havyn-embedded-browser-${profileName || "default"}`;
}

function browserSession() {
  return session.fromPartition(browserPartition());
}

async function setAdBlockState(enabled) {
  adBlockEnabled = Boolean(enabled);
  return adBlockEnabled;
}

function isYouTubeUrl(url = "") {
  return /(^https?:\/\/)?([^/]+\.)?(youtube\.com|youtu\.be)\b/i.test(url);
}

function shouldBlockRequest(url = "", resourceType = "") {
  if (!adBlockEnabled || isYouTubeUrl(url)) return false;
  if (resourceType === "mainFrame") return false;
  return [
    /(^|\.)doubleclick\.net\//i,
    /(^|\.)googlesyndication\.com\//i,
    /(^|\.)google-analytics\.com\//i,
    /(^|\.)adnxs\.com\//i,
    /(^|\.)popads\.net\//i,
    /(^|\.)popcash\.net\//i,
    /(^|\.)propellerads\.com\//i,
    /(^|\.)onclickads\.net\//i,
    /(^|\.)exoclick\.com\//i,
    /\/ads?[/.?=&_-]/i,
    /[?&](ad_|ads=|utm_)/i
  ].some((pattern) => pattern.test(url));
}

function installRequestGuard() {
  browserSession().webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: shouldBlockRequest(details.url, details.resourceType) });
  });
}

async function resetTroubledSiteData(url) {
  const targetSession = browserSession();
  const origin = new URL(url).origin;
  await targetSession.clearStorageData({
    origin,
    storages: ["appcache", "cookies", "filesystem", "indexdb", "localstorage", "shadercache", "websql", "serviceworkers", "cachestorage"]
  }).catch(() => {});
  await targetSession.clearCache().catch(() => {});
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    title: "Havyn",
    icon: path.join(__dirname, "../public/brand/havyn-icon.png"),
    backgroundColor: "#0B0B0F",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadURL(isDev ? "http://127.0.0.1:5173" : `file://${path.join(__dirname, "../dist/index.html")}`);
  mainWindow.on("closed", () => {
    if (mediaEventTimer) clearInterval(mediaEventTimer);
    mainWindow = null;
    tabs.clear();
    activeTabId = null;
  });
}

function activeTab() {
  return tabs.get(activeTabId);
}

function serializeTabs() {
  return Array.from(tabs.values()).map(({ id, title, url }) => ({
    id,
    title: title || "New tab",
    url: url || ""
  }));
}

function emitTabs() {
  mainWindow?.webContents.send("browser:tabs", {
    activeTabId,
    tabs: serializeTabs()
  });
}

function showActiveTab() {
  if (!mainWindow || !activeTabId) return;
  for (const tab of tabs.values()) {
    try {
      mainWindow.removeBrowserView(tab.view);
    } catch {
      // Ignore stale view removal during tab switches.
    }
  }
  const tab = activeTab();
  if (!tab) return;
  mainWindow.setBrowserView(tab.view);
  if (currentBounds) tab.view.setBounds(currentBounds);
  tab.view.setAutoResize({ width: false, height: false });
  tab.view.webContents.focus();
  emitTabs();
}

function createBrowserTab(initialUrl = "about:blank") {
  if (!mainWindow) return null;
  const id = crypto.randomUUID();
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "browserPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      nodeIntegrationInSubFrames: true,
      javascript: true,
      webSecurity: true,
      additionalArguments: [`--havyn-tab-id=${id}`],
      partition: browserPartition()
    }
  });

  const tab = { id, view, title: "New tab", url: "" };
  tabs.set(id, tab);
  activeTabId = id;

  const wc = view.webContents;
  wc.setUserAgent(app.userAgentFallback);
  wc.setWindowOpenHandler(({ url }) => {
    if (adBlockEnabled) {
      if (tab.id === activeTabId) {
        mainWindow?.webContents.send("browser:load-state", {
          type: "warning",
          url,
          message: "Popup blocked."
        });
      }
      return { action: "deny" };
    }
    createBrowserTab(url);
    return { action: "deny" };
  });

  wc.on("page-title-updated", (_event, title) => {
    tab.title = title;
    emitTabs();
  });
  wc.on("did-finish-load", () => scanTabMedia(tab));
  wc.on("dom-ready", () => scanTabMedia(tab));
  wc.on("did-navigate-in-page", () => scanTabMedia(tab));
  wc.on("media-started-playing", () => scanTabMedia(tab));
  wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (errorCode === -400) {
      if (!tab.cacheMissRetried) {
        tab.cacheMissRetried = true;
        browserSession().clearCache().finally(() => {
          if (!wc.isDestroyed()) wc.reloadIgnoringCache();
        });
      }
      if (tab.id === activeTabId) {
        mainWindow?.webContents.send("browser:load-state", {
          type: "warning",
          url: validatedURL,
          message: "Refreshing player cache..."
        });
      }
      return;
    }
    if (tab.id === activeTabId) {
      mainWindow?.webContents.send("browser:load-state", {
        type: "error",
        url: validatedURL,
        message: `Load error ${errorCode}: ${errorDescription || "Page could not be loaded."}`
      });
    }
  });
  wc.on("render-process-gone", (_event, details) => {
    if (tab.id === activeTabId) {
      mainWindow?.webContents.send("browser:load-state", {
        type: "error",
        url: tab.url,
        message: `Page renderer stopped: ${details.reason || "unknown reason"}`
      });
    }
  });
  wc.on("unresponsive", () => {
    if (tab.id === activeTabId) {
      mainWindow?.webContents.send("browser:load-state", {
        type: "error",
        url: tab.url,
        message: "Page became unresponsive."
      });
    }
  });
  wc.on("console-message", async (_event, _level, _message) => {
    const payload = await wc.executeJavaScript("window.__havynReadMediaEvent?.()", true).catch(() => null);
    if (payload && tab.id === activeTabId) mainWindow?.webContents.send("browser:media-event", payload);
  });
  wc.on("did-navigate", (_event, url) => {
    tab.cacheMissRetried = false;
    tab.url = url;
    if (tab.id === activeTabId) mainWindow?.webContents.send("browser:navigation", { url });
    emitTabs();
  });
  wc.on("did-navigate-in-page", (_event, url) => {
    tab.cacheMissRetried = false;
    tab.url = url;
    if (tab.id === activeTabId) mainWindow?.webContents.send("browser:navigation", { url });
    emitTabs();
  });

  showActiveTab();
  if (initialUrl && initialUrl !== "about:blank") wc.loadURL(initialUrl).catch(() => {});
  return tab;
}

function ensureActiveTab() {
  return activeTab() || createBrowserTab();
}

async function scanTabMedia(tab = activeTab()) {
  if (!tab) return [];
  tab.view.webContents.send("browser:scan-media");
  const media = await tab.view.webContents.executeJavaScript("window.__havynScanMedia?.() || window.__havynMediaDetected || []", true).catch(() => []);
  const normalizedMedia = normalizeDetectedMedia(tab, media);
  if (normalizedMedia?.length && tab.id === activeTabId) mainWindow?.webContents.send("browser:media-detected", normalizedMedia);
  return normalizedMedia || [];
}

function normalizeDetectedMedia(tab, media = []) {
  return (media || []).map((item) => ({
    ...item,
    frameUrl: item.frameUrl || item.url,
    url: tab?.url || item.pageUrl || item.url
  }));
}

ipcMain.handle("browser:create", (_event, bounds) => {
  currentBounds = bounds || currentBounds;
  ensureActiveTab();
  showActiveTab();
  scanTabMedia();
  return { activeTabId, tabs: serializeTabs() };
});

ipcMain.handle("browser:destroy", () => {
  for (const tab of tabs.values()) {
    try {
      mainWindow?.removeBrowserView(tab.view);
      tab.view.webContents.destroy();
    } catch {
      // Ignore destroyed views during shutdown.
    }
  }
  tabs.clear();
  activeTabId = null;
  return true;
});

ipcMain.handle("browser:set-bounds", (_event, bounds) => {
  currentBounds = bounds;
  activeTab()?.view.setBounds(bounds);
  return true;
});

ipcMain.handle("browser:new-tab", async (_event, url) => {
  const normalized = url ? (/^https?:\/\//i.test(url) ? url : `https://${url}`) : "about:blank";
  createBrowserTab(normalized);
  return { activeTabId, tabs: serializeTabs() };
});

ipcMain.handle("browser:switch-tab", (_event, tabId) => {
  if (!tabs.has(tabId)) return { activeTabId, tabs: serializeTabs() };
  activeTabId = tabId;
  showActiveTab();
  const tab = activeTab();
  if (tab?.url) mainWindow?.webContents.send("browser:navigation", { url: tab.url });
  scanTabMedia(tab);
  return { activeTabId, tabs: serializeTabs() };
});

ipcMain.handle("browser:close-tab", (_event, tabId) => {
  const tab = tabs.get(tabId);
  if (!tab) return { activeTabId, tabs: serializeTabs() };
  try {
    mainWindow?.removeBrowserView(tab.view);
    tab.view.webContents.destroy();
  } catch {
    // Ignore close races.
  }
  tabs.delete(tabId);
  if (activeTabId === tabId) activeTabId = tabs.keys().next().value || null;
  if (!activeTabId) createBrowserTab();
  else showActiveTab();
  return { activeTabId, tabs: serializeTabs() };
});

ipcMain.handle("browser:load-url", async (_event, url) => {
  const tab = ensureActiveTab();
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  mainWindow?.webContents.send("browser:load-state", { type: "loading", url: normalized });
  if (isYouTubeUrl(normalized)) {
    await resetTroubledSiteData(normalized);
  }
  if (isYouTubeUrl(normalized) && adBlockEnabled) {
    await setAdBlockState(false).catch(() => {});
    mainWindow?.webContents.send("browser:adblock-state", { enabled: adBlockEnabled });
    mainWindow?.webContents.send("browser:load-state", {
      type: "warning",
      url: normalized,
      message: "Ad blocker bypassed for YouTube so the page can render normally."
    });
  }
  await tab.view.webContents.loadURL(normalized).catch((error) => {
    if (error?.code === "ERR_ABORTED" || error?.code === "ERR_CACHE_MISS" || /ERR_ABORTED|-3|ERR_CACHE_MISS|-400/.test(error?.message || "")) return;
    mainWindow?.webContents.send("browser:load-state", {
      type: "warning",
      url: normalized,
      message: `${error.message || "Page could not be loaded."} Try reload or open a new tab.`
    });
  });
  tab.url = normalized;
  emitTabs();
  setTimeout(() => scanTabMedia(tab), 1200);
  setTimeout(() => scanTabMedia(tab), 3000);
  setTimeout(() => scanTabMedia(tab), 6000);
  return normalized;
});

ipcMain.handle("browser:back", () => {
  const wc = activeTab()?.view.webContents;
  if (wc?.canGoBack()) wc.goBack();
  return true;
});

ipcMain.handle("browser:forward", () => {
  const wc = activeTab()?.view.webContents;
  if (wc?.canGoForward()) wc.goForward();
  return true;
});

ipcMain.handle("browser:reload", () => {
  activeTab()?.view.webContents.reload();
  return true;
});

ipcMain.handle("browser:focus", () => {
  activeTab()?.view.webContents.focus();
  return true;
});

ipcMain.handle("browser:open-web-store", () => {
  createBrowserTab("https://chromewebstore.google.com/category/extensions");
  return { activeTabId, tabs: serializeTabs() };
});

ipcMain.handle("browser:load-unpacked-extension", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Load unpacked Chromium extension",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };

  const extension = await browserSession().loadExtension(result.filePaths[0], {
    allowFileAccess: true
  });
  loadedExtensions.set(extension.id, extension);

  return {
    ok: true,
    extension: {
      id: extension.id,
      name: extension.name
    }
  };
});

ipcMain.handle("browser:toggle-adblock", async () => {
  try {
    const tab = activeTab();
    if (!adBlockEnabled && isYouTubeUrl(tab?.url)) {
      return {
        enabled: false,
        error: "Ad blocker is bypassed on YouTube because it breaks the embedded page."
      };
    }
    await setAdBlockState(!adBlockEnabled);
    tab?.view.webContents.reload();
    return { enabled: adBlockEnabled };
  } catch (error) {
    return { enabled: adBlockEnabled, error: error.message || "Ad blocker could not be updated." };
  }
});

ipcMain.handle("browser:get-adblock-state", () => ({ enabled: adBlockEnabled }));

ipcMain.handle("browser:apply-playback", async (_event, state) => {
  const tab = activeTab();
  if (!tab) return false;
  tab.view.webContents.send("browser:apply-playback", state);
  return tab.view.webContents.executeJavaScript(
    `window.__havynApplyPlayback?.(${JSON.stringify(state)})`,
    true
  ).catch(() => false);
});

ipcMain.handle("browser:scan-media", async () => scanTabMedia());

ipcMain.on("browser:media-detected-from-page", (_event, { tabId, media }) => {
  const tab = tabs.get(tabId);
  if (tabId === activeTabId) mainWindow?.webContents.send("browser:media-detected", normalizeDetectedMedia(tab, media));
});

ipcMain.on("browser:media-event-from-page", (_event, payload) => {
  if (payload?.tabId === activeTabId) {
    const tab = tabs.get(payload.tabId);
    mainWindow?.webContents.send("browser:media-event", {
      eventName: payload.eventName,
      media: normalizeDetectedMedia(tab, [payload.media])[0],
      controlledByHavyn: payload.controlledByHavyn
    });
  }
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media"].includes(permission));
  });
  browserSession().setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media"].includes(permission));
  });
  installRequestGuard();
  createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

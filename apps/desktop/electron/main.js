import { app, BrowserWindow, WebContentsView, dialog, ipcMain, session, webContents } from "electron";
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
let adBlockDesired = true;
let browserVisible = true;
const registeredWebviews = new Set();

const FRAME_DETECTOR_SCRIPT = String.raw`
(() => {
  if (window.__havynFrameDetectorInstalled) {
    window.__havynScanMedia?.();
    return true;
  }
  window.__havynFrameDetectorInstalled = true;
  let lastMediaEvent = null;
  let applyingRemoteUntil = 0;
  let pendingPlayback = null;
  let playbackRetryTimer = null;
  let scanTimer = null;
  let lastTimeUpdateAt = 0;

  const allRoots = (root = document) => {
    const roots = [root];
    for (const node of root.querySelectorAll?.("*") || []) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
    return roots;
  };

  const findVideos = () => {
    const found = [];
    for (const root of allRoots(document)) {
      found.push(...Array.from(root.querySelectorAll?.("video") || []));
    }
    return [...new Set(found)];
  };

  const describeVideo = (video, index) => {
    video.dataset.havynMediaId = video.dataset.havynMediaId || "video-" + index;
    let pageUrl = window.location.href;
    try {
      pageUrl = window.top?.location?.href || pageUrl;
    } catch {
      pageUrl = document.referrer || pageUrl;
    }
    return {
      id: video.dataset.havynMediaId,
      index,
      title: document.querySelector("meta[property='og:title']")?.content || document.title || video.getAttribute("title") || "Detected video",
      currentTime: video.currentTime || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      paused: video.paused,
      playbackRate: video.playbackRate || 1,
      ended: video.ended,
      readyState: video.readyState,
      width: video.videoWidth || video.clientWidth || 0,
      height: video.videoHeight || video.clientHeight || 0,
      src: video.currentSrc || video.src || "",
      frameUrl: window.location.href,
      pageUrl,
      url: window.location.href
    };
  };

  const emitEvent = (eventName, video) => {
    if (eventName === "timeupdate" && Date.now() - lastTimeUpdateAt < 1000) return;
    if (eventName === "timeupdate") lastTimeUpdateAt = Date.now();
    const index = findVideos().indexOf(video);
    lastMediaEvent = {
      eventName,
      media: describeVideo(video, index),
      controlledByHavyn: Date.now() < applyingRemoteUntil
    };
    console.debug("__HAVYN_FRAME_MEDIA_EVENT__");
  };

  const attach = (video) => {
    if (!video || video.dataset.havynFrameAttached) return;
    video.dataset.havynFrameAttached = "true";
    ["play", "pause", "seeking", "seeked", "timeupdate", "loadedmetadata", "canplay", "playing", "ended", "ratechange"].forEach((eventName) => {
      video.addEventListener(eventName, () => emitEvent(eventName, video), true);
    });
  };

  const scan = () => {
    const videos = findVideos();
    videos.forEach(attach);
    return videos.map(describeVideo);
  };

  const scheduleScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
      console.debug("__HAVYN_FRAME_MEDIA_SCAN__");
    }, 250);
  };

  window.__havynScanMedia = scan;
  window.__havynReadMediaEvent = () => {
    const event = lastMediaEvent;
    lastMediaEvent = null;
    return event;
  };
  const schedulePlaybackRetry = () => {
    if (playbackRetryTimer || !pendingPlayback) return;
    playbackRetryTimer = setTimeout(() => {
      playbackRetryTimer = null;
      if (pendingPlayback) window.__havynApplyPlayback(pendingPlayback);
    }, 700);
  };

  window.__havynApplyPlayback = ({ action, currentTime, playbackRate }) => {
    const video = findVideos().find((item) => item.readyState > 0) || findVideos()[0];
    if (!video) {
      pendingPlayback = { action, currentTime, playbackRate };
      schedulePlaybackRetry();
      return false;
    }
    applyingRemoteUntil = Date.now() + 1200;
    if (action !== "play") pendingPlayback = null;
    if (typeof playbackRate === "number") video.playbackRate = playbackRate;
    if (typeof currentTime === "number" && Math.abs((video.currentTime || 0) - currentTime) > 0.35) {
      video.currentTime = Math.max(0, currentTime);
    }
    if (action === "play" && video.paused) {
      pendingPlayback = { action, currentTime, playbackRate };
      video.play()
        .then(() => {
          pendingPlayback = null;
        })
        .catch(() => schedulePlaybackRetry());
    }
    if (action === "pause" && !video.paused) video.pause();
    return true;
  };

  new MutationObserver(scheduleScan).observe(document.documentElement || document, { childList: true, subtree: true });
  scan();
  setTimeout(scheduleScan, 500);
  setTimeout(scheduleScan, 1800);
  setInterval(scheduleScan, 4000);
  return true;
})();
`;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
app.setAppUserModelId("app.havyn.desktop");
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
  adBlockDesired = Boolean(enabled);
  emitAdBlockState();
  return adBlockDesired;
}

function isMainstreamStreamingUrl(url = "") {
  return /(^https?:\/\/)?([^/]+\.)?(youtube\.com|youtu\.be)\b/i.test(url);
}

function isAdBlockBypassUrl(url = "") {
  return [
    /(^https?:\/\/)?([^/]+\.)?(youtube\.com|youtu\.be)\b/i,
    /(^https?:\/\/)?([^/]+\.)?netflix\.com\b/i,
    /(^https?:\/\/)?([^/]+\.)?(primevideo\.com|amazon\.[^/]+\/gp\/video|amazon\.[^/]+\/Prime-Video)\b/i,
    /(^https?:\/\/)?([^/]+\.)?(hulu\.com|disneyplus\.com|max\.com|hbomax\.com|peacocktv\.com|paramountplus\.com|twitch\.tv|apple\.com\/tv)\b/i
  ].some((pattern) => pattern.test(url));
}

function adBlockStateForUrl(url = activeTab()?.url || "") {
  const bypassed = adBlockDesired && isAdBlockBypassUrl(url);
  return {
    enabled: adBlockDesired && !bypassed,
    desiredEnabled: adBlockDesired,
    bypassed,
    bypassReason: bypassed ? "Ad blocker is bypassed on this streaming site for playback stability." : ""
  };
}

function emitAdBlockState(url) {
  mainWindow?.webContents.send("browser:adblock-state", adBlockStateForUrl(url));
}

function shouldBlockRequest(url = "", resourceType = "") {
  if (!adBlockDesired || isAdBlockBypassUrl(url)) return false;
  const adPatterns = [
    /(^|\.)doubleclick\.net\//i,
    /(^|\.)googlesyndication\.com\//i,
    /(^|\.)google-analytics\.com\//i,
    /(^|\.)googletagmanager\.com\//i,
    /(^|\.)googletagservices\.com\//i,
    /(^|\.)adnxs\.com\//i,
    /(^|\.)popads\.net\//i,
    /(^|\.)popcash\.net\//i,
    /(^|\.)propellerads\.com\//i,
    /(^|\.)onclickads\.net\//i,
    /(^|\.)exoclick\.com\//i,
    /(^|\.)adsterra\.com\//i,
    /(^|\.)adsterratools\.com\//i,
    /(^|\.)juicyads\.com\//i,
    /(^|\.)trafficjunky\.net\//i,
    /(^|\.)popunder/i,
    /(^|\.)clickadu\.com\//i,
    /(^|\.)hilltopads\.net\//i,
    /(^|\.)yllix\.com\//i,
    /(^|\.)mgid\.com\//i,
    /(^|\.)taboola\.com\//i,
    /(^|\.)outbrain\.com\//i,
    /(^|\.)revcontent\.com\//i,
    /(^|\.)adskeeper\.co(m)?\//i,
    /(^|\.)criteo\.com\//i,
    /\/ads?[/.?=&_-]/i,
    /\/pop(?:up|under)[/.?=&_-]/i,
    /\/vast[/.?=&_-]/i,
    /\/prebid[/.?=&_-]/i,
    /[?&](ad_|ads=|utm_)/i
  ];

  if (resourceType === "mainFrame") {
    return [
      /(^|\.)popads\.net\//i,
      /(^|\.)popcash\.net\//i,
      /(^|\.)propellerads\.com\//i,
      /(^|\.)onclickads\.net\//i,
      /(^|\.)exoclick\.com\//i,
      /(^|\.)adsterra\.com\//i,
      /(^|\.)adsterratools\.com\//i,
      /(^|\.)clickadu\.com\//i,
      /(^|\.)hilltopads\.net\//i,
      /\/pop(?:up|under)[/.?=&_-]/i
    ].some((pattern) => pattern.test(url));
  }

  return adPatterns.some((pattern) => pattern.test(url));
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
    icon: path.join(__dirname, "../public/brand/havyn-icon.ico"),
    backgroundColor: "#0B0B0F",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
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
  const contentView = mainWindow.contentView;
  for (const tab of tabs.values()) {
    try {
      contentView.removeChildView(tab.view);
    } catch {
      // Ignore stale view removal during tab switches.
    }
  }
  if (!browserVisible) return;
  const tab = activeTab();
  if (!tab) return;
  contentView.addChildView(tab.view);
  if (currentBounds) tab.view.setBounds(currentBounds);
  tab.view.webContents.focus();
  emitTabs();
}

function createBrowserTab(initialUrl = "about:blank") {
  if (!mainWindow) return null;
  const id = crypto.randomUUID();
  const view = new WebContentsView({
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
    if (adBlockStateForUrl(tab.url).enabled) {
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
    if (tab.id === activeTabId) emitAdBlockState(url);
    emitTabs();
  });
  wc.on("did-navigate-in-page", (_event, url) => {
    tab.cacheMissRetried = false;
    tab.url = url;
    if (tab.id === activeTabId) mainWindow?.webContents.send("browser:navigation", { url });
    if (tab.id === activeTabId) emitAdBlockState(url);
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
    pageUrl: item.pageUrl || tab?.url || item.url,
    url: item.url || item.frameUrl || tab?.url
  }));
}

function normalizeWebviewMedia(wc, media = []) {
  return (media || []).map((item) => ({
    ...item,
    frameUrl: item.frameUrl || item.url,
    pageUrl: item.pageUrl || wc?.getURL?.() || item.url,
    url: item.url || item.frameUrl || wc?.getURL?.()
  }));
}

function webviewFrames(wc) {
  const frames = [];
  const visit = (frame) => {
    if (!frame || frame.detached) return;
    frames.push(frame);
    for (const child of frame.frames || []) visit(child);
  };
  visit(wc?.mainFrame);
  return frames;
}

async function installDetectorInWebviewFrames(wc) {
  if (!wc || wc.isDestroyed()) return [];
  const frames = webviewFrames(wc);
  await Promise.all(frames.map((frame) => frame.executeJavaScript(FRAME_DETECTOR_SCRIPT, true).catch(() => false)));
  return frames;
}

async function scanWebviewMedia(webContentsId) {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) return [];
  const frames = await installDetectorInWebviewFrames(wc);
  const mediaByFrame = await Promise.all(frames.map((frame) => (
    frame.executeJavaScript("window.__havynScanMedia?.() || []", true).catch(() => [])
  )));
  return normalizeWebviewMedia(wc, mediaByFrame.flat().filter(Boolean));
}

async function readWebviewMediaEvent(wc) {
  if (!wc || wc.isDestroyed()) return null;
  const frames = webviewFrames(wc);
  for (const frame of frames) {
    const payload = await frame.executeJavaScript("window.__havynReadMediaEvent?.()", true).catch(() => null);
    if (payload) return normalizeWebviewMedia(wc, [payload.media]).map((media) => ({ ...payload, media }))[0];
  }
  return null;
}

async function applyWebviewPlayback(webContentsId, state) {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) return false;
  const frames = await installDetectorInWebviewFrames(wc);
  const results = await Promise.all(frames.map((frame) => (
    frame.executeJavaScript(`window.__havynApplyPlayback?.(${JSON.stringify(state)}) || false`, true).catch(() => false)
  )));
  return results.some(Boolean);
}

ipcMain.handle("browser:create", (_event, bounds) => {
  currentBounds = bounds || currentBounds;
  ensureActiveTab();
  showActiveTab();
  scanTabMedia();
  return { activeTabId, tabs: serializeTabs() };
});

ipcMain.handle("browser:destroy", () => {
  const contentView = mainWindow?.contentView;
  for (const tab of tabs.values()) {
    try {
      contentView?.removeChildView(tab.view);
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
  if (browserVisible) activeTab()?.view.setBounds(bounds);
  return true;
});

ipcMain.handle("browser:set-visible", (_event, visible) => {
  browserVisible = Boolean(visible);
  if (browserVisible) {
    showActiveTab();
  } else {
    const contentView = mainWindow?.contentView;
    for (const tab of tabs.values()) {
      try {
        contentView?.removeChildView(tab.view);
      } catch {
        // Ignore stale view removal while hiding the native browser layer.
      }
    }
  }
  return { visible: browserVisible };
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
  emitAdBlockState(tab?.url);
  scanTabMedia(tab);
  return { activeTabId, tabs: serializeTabs() };
});

ipcMain.handle("browser:close-tab", (_event, tabId) => {
  const tab = tabs.get(tabId);
  if (!tab) return { activeTabId, tabs: serializeTabs() };
  try {
    mainWindow?.contentView.removeChildView(tab.view);
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
  if (isMainstreamStreamingUrl(normalized)) {
    await resetTroubledSiteData(normalized);
  }
  if (adBlockStateForUrl(normalized).bypassed) {
    emitAdBlockState(normalized);
    mainWindow?.webContents.send("browser:load-state", {
      type: "warning",
      url: normalized,
      message: "Ad blocker bypassed on this streaming site for playback stability."
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
    await setAdBlockState(!adBlockDesired);
    tab?.view.webContents.reload();
    return adBlockStateForUrl(tab?.url);
  } catch (error) {
    return { ...adBlockStateForUrl(), error: error.message || "Ad blocker could not be updated." };
  }
});

ipcMain.handle("browser:get-adblock-state", () => adBlockStateForUrl());

ipcMain.handle("app:get-browser-preload-url", () => `file://${path.join(__dirname, "browserPreload.js").replace(/\\/g, "/")}`);
ipcMain.handle("app:get-browser-partition", () => browserPartition());

ipcMain.handle("browser:register-webview", (_event, webContentsId) => {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || registeredWebviews.has(wc.id)) return Boolean(wc);
  registeredWebviews.add(wc.id);
  wc.on("console-message", async (_event, _level, message) => {
    if (!String(message || "").includes("__HAVYN_FRAME_MEDIA_")) return;
    const payload = await readWebviewMediaEvent(wc);
    if (payload) mainWindow?.webContents.send("browser:media-event", payload);
    if (String(message || "").includes("__HAVYN_FRAME_MEDIA_SCAN__")) {
      const media = await scanWebviewMedia(wc.id);
      if (media.length) mainWindow?.webContents.send("browser:media-detected", media);
    }
  });
  wc.on("destroyed", () => registeredWebviews.delete(wc.id));
  return true;
});

ipcMain.handle("browser:scan-webview-media", async (_event, webContentsId) => {
  const media = await scanWebviewMedia(webContentsId);
  if (media.length) mainWindow?.webContents.send("browser:media-detected", media);
  return media;
});

ipcMain.handle("browser:apply-webview-playback", (_event, webContentsId, state) => applyWebviewPlayback(webContentsId, state));

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

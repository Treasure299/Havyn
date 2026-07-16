import { app, BrowserWindow, WebContentsView, desktopCapturer, dialog, ipcMain, screen, session, shell, webContents } from "electron";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRemotePlaybackExpectation, matchesRemotePlaybackEvent } from "./playbackEventClassifier.js";
import { createCallMediaPermissionGate } from "./callMediaPermission.js";
import { createScreenSharePermissionGate } from "./screenSharePermission.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
let mainWindow;
const callMediaPermission = createCallMediaPermissionGate(() => mainWindow?.webContents?.id);
const screenSharePermission = createScreenSharePermissionGate(() => mainWindow?.webContents?.id);
let activeTabId;
let currentBounds;
let mediaEventTimer;
const tabs = new Map();
const loadedExtensions = new Map();
let adBlockDesired = true;
let browserVisible = true;
const registeredWebviews = new Set();
const createRemotePlaybackExpectationSource = createRemotePlaybackExpectation.toString();
const matchesRemotePlaybackEventSource = matchesRemotePlaybackEvent.toString();
// Keep diagnostics available in tester builds until the watch-room behavior is
// signed off. Set HAVYN_DIAGNOSTICS=0 only when shipping a build without logs.
const diagnosticsEnabled = process.env.HAVYN_DIAGNOSTICS !== "0";
let diagnosticLogPath = "";

function sanitizeDiagnosticValue(value, key = "") {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (/token|secret|password|authorization|api.?key/i.test(key)) return "[redacted]";
    if (/url|src|href/i.test(key)) {
      try {
        const parsed = new URL(value);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return value.slice(0, 300);
      }
    }
    return value.slice(0, 1000);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeDiagnosticValue(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 80).map(([childKey, childValue]) => [
        childKey,
        sanitizeDiagnosticValue(childValue, childKey)
      ])
    );
  }
  return String(value).slice(0, 300);
}

function initializeDiagnosticLog() {
  if (!diagnosticsEnabled || diagnosticLogPath) return;
  const logDirectory = path.join(app.getPath("userData"), "logs");
  mkdirSync(logDirectory, { recursive: true });
  diagnosticLogPath = path.join(logDirectory, "havyn-playback-diagnostic.jsonl");
  if (existsSync(diagnosticLogPath) && statSync(diagnosticLogPath).size > 5 * 1024 * 1024) {
    const previousPath = path.join(logDirectory, "havyn-playback-diagnostic.previous.jsonl");
    try {
      renameSync(diagnosticLogPath, previousPath);
    } catch {
      // Keep the current file if antivirus or another viewer has it open.
    }
  }
  appendDiagnosticRecord({ scope: "main", event: "diagnostic-session-start" });
}

function appendDiagnosticRecord(record = {}) {
  if (!diagnosticsEnabled) return;
  if (!diagnosticLogPath) initializeDiagnosticLog();
  if (!diagnosticLogPath) return;
  const entry = sanitizeDiagnosticValue({
    timestamp: new Date().toISOString(),
    appVersion: app.getVersion(),
    pid: process.pid,
    ...record
  });
  try {
    appendFileSync(diagnosticLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Diagnostics must never interrupt the watch room.
  }
}

export const FRAME_DETECTOR_SCRIPT = String.raw`
(() => {
  if (window.__havynFrameDetectorInstalled) {
    window.__havynScanMedia?.();
    return true;
  }
  window.__havynFrameDetectorInstalled = true;
  let lastMediaEvent = null;
  const createRemotePlaybackExpectation = ${createRemotePlaybackExpectationSource};
  const matchesRemotePlaybackEvent = ${matchesRemotePlaybackEventSource};
  let remotePlaybackExpectation = null;
  let pendingPlayback = null;
  let playbackRetryTimer = null;
  let playbackCommandSequence = 0;
  let latestPlaybackAction = "";
  let scanTimer = null;
  let lastTimeUpdateAt = 0;

  const diagnostic = (event, details = {}) => {
    if (!window.__havynDiagnosticsEnabled) return;
    console.debug("__HAVYN_FRAME_DIAGNOSTIC__" + JSON.stringify({ event, frameUrl: window.location.href, ...details }));
  };

  const diagnosticMedia = () => findVideos().slice(0, 4).map((video) => ({
    currentTime: Number(video.currentTime || 0),
    paused: Boolean(video.paused),
    playbackRate: Number(video.playbackRate || 1),
    readyState: Number(video.readyState || 0)
  }));

  const diagnosticTarget = (event) => {
    const target = event.composedPath?.()[0] || event.target;
    return {
      type: event.type,
      phase: event.eventPhase,
      button: event.button,
      defaultPrevented: event.defaultPrevented,
      x: Math.round(event.clientX || 0),
      y: Math.round(event.clientY || 0),
      target: {
        tag: target?.tagName || "",
        id: target?.id || "",
        className: typeof target?.className === "string" ? target.className.slice(0, 180) : "",
        role: target?.getAttribute?.("role") || "",
        hasOnClick: Boolean(target?.getAttribute?.("onclick"))
      },
      media: diagnosticMedia()
    };
  };

  document.addEventListener("pointerdown", (event) => diagnostic("input-pointerdown-capture", diagnosticTarget(event)), true);
  document.addEventListener("pointerup", (event) => diagnostic("input-pointerup-capture", diagnosticTarget(event)), true);
  document.addEventListener("click", (event) => {
    diagnostic("input-click-capture", diagnosticTarget(event));
    setTimeout(() => diagnostic("input-click-after-120ms", diagnosticTarget(event)), 120);
  }, true);
  document.addEventListener("click", (event) => diagnostic("input-click-bubble", diagnosticTarget(event)), false);
  document.addEventListener("keydown", (event) => {
    if (["Space", "Enter", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      diagnostic("input-keydown-capture", {
        code: event.code,
        defaultPrevented: event.defaultPrevented,
        target: event.target?.tagName || "",
        media: diagnosticMedia()
      });
    }
  }, true);

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

  const theatreState = window.__havynTheatreState || {
    snapshots: [],
    elements: new WeakSet()
  };
  window.__havynTheatreState = theatreState;

  const rememberTheatreStyle = (element) => {
    if (!element || theatreState.elements.has(element)) return;
    theatreState.elements.add(element);
    theatreState.snapshots.push({
      element,
      style: element.getAttribute("style"),
      theatre: element.getAttribute("data-havyn-theatre")
    });
  };

  const applyTheatreSurface = (element, zIndex) => {
    if (!element) return;
    rememberTheatreStyle(element);
    element.setAttribute("data-havyn-theatre", "true");
    element.style.setProperty("position", "fixed", "important");
    element.style.setProperty("inset", "0", "important");
    element.style.setProperty("left", "0", "important");
    element.style.setProperty("top", "0", "important");
    element.style.setProperty("width", "100vw", "important");
    element.style.setProperty("height", "100vh", "important");
    element.style.setProperty("max-width", "none", "important");
    element.style.setProperty("max-height", "none", "important");
    element.style.setProperty("margin", "0", "important");
    element.style.setProperty("padding", "0", "important");
    element.style.setProperty("transform", "none", "important");
    element.style.setProperty("z-index", String(zIndex), "important");
    element.style.setProperty("background", "#000", "important");
  };

  const visibleArea = (element) => {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width < 2 || rect.height < 2) return 0;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return 0;
    return rect.width * rect.height;
  };

  const chooseTheatreContainer = (video) => {
    const videoArea = Math.max(1, visibleArea(video));
    let best = video;
    let bestScore = Number.POSITIVE_INFINITY;
    let node = video.parentElement;
    let depth = 0;
    while (node && node !== document.body && node !== document.documentElement && depth < 7) {
      const area = visibleArea(node);
      const ratio = area / videoArea;
      if (area && ratio >= 0.75 && ratio <= 4.5) {
        const controls = node.querySelectorAll?.("button,[role='button'],input[type='range']")?.length || 0;
        const score = ratio - Math.min(controls, 6) * 0.08 + depth * 0.04;
        if (score < bestScore) {
          best = node;
          bestScore = score;
        }
      }
      node = node.parentElement;
      depth += 1;
    }
    return best;
  };

  window.__havynExitTheatre = () => {
    for (let index = theatreState.snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = theatreState.snapshots[index];
      if (!snapshot.element?.isConnected) continue;
      if (snapshot.style == null) snapshot.element.removeAttribute("style");
      else snapshot.element.setAttribute("style", snapshot.style);
      if (snapshot.theatre == null) snapshot.element.removeAttribute("data-havyn-theatre");
      else snapshot.element.setAttribute("data-havyn-theatre", snapshot.theatre);
    }
    theatreState.snapshots = [];
    theatreState.elements = new WeakSet();
    return true;
  };

  window.__havynEnterTheatre = (selection = {}) => {
    window.__havynExitTheatre();
    const videos = findVideos();
    if (!videos.length) return { ok: false, reason: "no-video" };
    const requestedIndex = Number(selection.index);
    const requestedId = String(selection.id || "");
    const requestedSrc = String(selection.src || "");
    let video = videos.find((item) => requestedId && item.dataset.havynMediaId === requestedId);
    if (!video && requestedSrc) video = videos.find((item) => (item.currentSrc || item.src || "") === requestedSrc);
    if (!video && Number.isInteger(requestedIndex) && requestedIndex >= 0) video = videos[requestedIndex];
    if (!video && videos.length === 1) video = videos[0];
    if (!video || visibleArea(video) < 1) return { ok: false, reason: "target-not-confirmed" };

    const container = chooseTheatreContainer(video);
    applyTheatreSurface(container, 2147483645);
    rememberTheatreStyle(video);
    video.style.setProperty("width", "100%", "important");
    video.style.setProperty("height", "100%", "important");
    video.style.setProperty("max-width", "none", "important");
    video.style.setProperty("max-height", "none", "important");
    video.style.setProperty("object-fit", "contain", "important");
    video.style.setProperty("background", "#000", "important");
    rememberTheatreStyle(document.documentElement);
    rememberTheatreStyle(document.body);
    document.documentElement.style.setProperty("overflow", "hidden", "important");
    document.body.style.setProperty("overflow", "hidden", "important");
    return {
      ok: true,
      frameUrl: window.location.href,
      mediaId: video.dataset.havynMediaId || "",
      usedContainer: container !== video
    };
  };

  window.__havynExpandTheatreFrame = (childUrl = "") => {
    const frames = Array.from(document.querySelectorAll("iframe,frame"));
    const normalizedChildUrl = String(childUrl || "");
    let target = frames.find((frame) => {
      try {
        return normalizedChildUrl && new URL(frame.src, document.baseURI).href === normalizedChildUrl;
      } catch {
        return false;
      }
    });
    if (!target) target = frames.sort((left, right) => visibleArea(right) - visibleArea(left))[0];
    if (!target || visibleArea(target) < 1) return false;
    applyTheatreSurface(target, 2147483644);
    rememberTheatreStyle(document.documentElement);
    rememberTheatreStyle(document.body);
    document.documentElement.style.setProperty("overflow", "hidden", "important");
    document.body.style.setProperty("overflow", "hidden", "important");
    return true;
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
    const media = describeVideo(video, index);
    lastMediaEvent = {
      eventId: "frame:" + eventName + ":" + Date.now() + ":" + Math.random().toString(36).slice(2),
      eventName,
      media,
      controlledByHavyn: matchesRemotePlaybackEvent(remotePlaybackExpectation, eventName, media)
    };
    if (["play", "playing", "pause", "seeking", "seeked", "ratechange"].includes(eventName)) {
      diagnostic("media-event", {
        eventName,
        controlledByHavyn: lastMediaEvent.controlledByHavyn,
        media: {
          currentTime: media.currentTime,
          paused: media.paused,
          playbackRate: media.playbackRate,
          readyState: media.readyState
        }
      });
    }
    // Include the complete event in the console signal. Reading a second queued
    // value from the frame here races Chromium's console delivery and can lose
    // fast play events from cross-origin players.
    console.debug("__HAVYN_FRAME_MEDIA_EVENT__" + JSON.stringify(lastMediaEvent));
  };

  const attach = (video) => {
    if (!video || video.dataset.havynMediaEventsAttached) return;
    video.dataset.havynMediaEventsAttached = "frame";
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
      const command = pendingPlayback;
      pendingPlayback = null;
      if (command) window.__havynApplyPlayback(command).catch(() => {});
    }, 700);
  };

  const queuePlaybackRetry = (state) => {
    if (Number(state.__havynCommandId) !== playbackCommandSequence) return;
    const retryCount = Number(state.__havynRetryCount || 0);
    const expiresAt = Number(state.__havynExpiresAt || (Date.now() + 7000));
    if (retryCount >= 8 || Date.now() >= expiresAt) {
      pendingPlayback = null;
      return;
    }
    pendingPlayback = {
      ...state,
      __havynRetryCount: retryCount + 1,
      __havynExpiresAt: expiresAt
    };
    schedulePlaybackRetry();
  };

  window.__havynApplyPlayback = async (state = {}) => {
    diagnostic("playback-command-received", {
      action: state.action || "sync",
      currentTime: state.currentTime,
      playbackRate: state.playbackRate,
      reason: state.reason || ""
    });
    const isRetry = Number.isFinite(Number(state.__havynCommandId));
    if (!isRetry) {
      playbackCommandSequence += 1;
      latestPlaybackAction = String(state.action || "sync");
      pendingPlayback = null;
      if (playbackRetryTimer) clearTimeout(playbackRetryTimer);
      playbackRetryTimer = null;
    }
    const command = {
      ...state,
      __havynCommandId: isRetry ? Number(state.__havynCommandId) : playbackCommandSequence
    };
    const { action, currentTime, playbackRate } = command;
    if (command.__havynCommandId !== playbackCommandSequence) return false;
    const video = findVideos().find((item) => item.readyState > 0) || findVideos()[0];
    if (!video) {
      diagnostic("playback-command-no-video", { action: command.action || "sync" });
      queuePlaybackRetry(command);
      return false;
    }
    remotePlaybackExpectation = createRemotePlaybackExpectation({ action, currentTime, playbackRate });
    if (action !== "play") pendingPlayback = null;
    if (typeof playbackRate === "number") video.playbackRate = playbackRate;
    if (typeof currentTime === "number" && Math.abs((video.currentTime || 0) - currentTime) > 0.35) {
      video.currentTime = Math.max(0, currentTime);
    }
    if (action === "play" && video.paused) {
      try {
        await video.play();
        if (command.__havynCommandId !== playbackCommandSequence) {
          if (latestPlaybackAction === "pause" && !video.paused) video.pause();
          return false;
        }
        pendingPlayback = null;
        diagnostic("playback-command-applied", {
          action: "play",
          currentTime: video.currentTime,
          paused: video.paused,
          playbackRate: video.playbackRate
        });
        return !video.paused;
      } catch {
        diagnostic("playback-command-failed", { action: "play", reason: "play-promise-rejected" });
        queuePlaybackRetry(command);
        return false;
      }
    }
    if (action === "pause" && !video.paused) video.pause();
    diagnostic("playback-command-applied", {
      action: action || "sync",
      currentTime: video.currentTime,
      paused: video.paused,
      playbackRate: video.playbackRate
    });
    return action === "pause" ? video.paused : true;
  };

  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    playbackCommandSequence += 1;
    latestPlaybackAction = "local";
    pendingPlayback = null;
    remotePlaybackExpectation = null;
    if (playbackRetryTimer) clearTimeout(playbackRetryTimer);
    playbackRetryTimer = null;
    findVideos().forEach((video) => {
      delete video.dataset.havynControlledUntil;
    });
  }, true);
  document.addEventListener("keydown", () => {
    playbackCommandSequence += 1;
    latestPlaybackAction = "local";
    pendingPlayback = null;
    remotePlaybackExpectation = null;
    if (playbackRetryTimer) clearTimeout(playbackRetryTimer);
    playbackRetryTimer = null;
    findVideos().forEach((video) => {
      delete video.dataset.havynControlledUntil;
    });
  }, true);

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
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../public/brand/havyn-icon.ico"),
    backgroundColor: "#0B0B0F",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
      sandbox: false
    }
  });

  mainWindow.loadURL(isDev ? "http://127.0.0.1:5173" : `file://${path.join(__dirname, "../dist/index.html")}`);
  mainWindow.setMenuBarVisibility(false);
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
      backgroundThrottling: false,
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
  const pageUrl = tab?.url || "";
  return (media || []).map((item) => ({
    ...item,
    frameUrl: item.frameUrl || item.url,
    pageUrl: pageUrl || item.pageUrl || item.url,
    url: item.url || item.frameUrl || tab?.url
  }));
}

export function normalizeWebviewMedia(wc, media = []) {
  const pageUrl = wc?.getURL?.() || "";
  return (media || []).map((item) => ({
    ...item,
    frameUrl: item.frameUrl || item.url,
    pageUrl: pageUrl || item.pageUrl || item.url,
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
  await Promise.all(frames.map(async (frame) => {
    await frame.executeJavaScript(`window.__havynDiagnosticsEnabled = ${diagnosticsEnabled};`, true).catch(() => false);
    return frame.executeJavaScript(FRAME_DETECTOR_SCRIPT, true).catch(() => false);
  }));
  return frames;
}

export async function scanWebviewMedia(webContentsId) {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) return [];
  const frames = await installDetectorInWebviewFrames(wc);
  const mediaByFrame = await Promise.all(frames.map((frame) => (
    frame.executeJavaScript("window.__havynScanMedia?.() || []", true).catch(() => [])
  )));
  return normalizeWebviewMedia(wc, mediaByFrame.flat().filter(Boolean));
}

async function applyWebviewPlayback(webContentsId, state) {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) return false;
  const frames = await installDetectorInWebviewFrames(wc);
  const inspected = await Promise.all(frames.map(async (frame) => ({
    frame,
    url: frame.url || "",
    mediaCount: await frame.executeJavaScript("window.__havynScanMedia?.().length || 0", true).catch(() => 0)
  })));
  const targetUrl = state?.activeMediaFrameUrl || state?.frameUrl || "";
  const candidates = inspected
    .filter((item) => item.mediaCount > 0)
    .sort((left, right) => {
      const leftMatch = targetUrl && left.url === targetUrl ? 1 : 0;
      const rightMatch = targetUrl && right.url === targetUrl ? 1 : 0;
      return rightMatch - leftMatch;
    });
  for (const { frame } of candidates) {
    const applied = await frame.executeJavaScript(
      `window.__havynApplyPlayback?.(${JSON.stringify(state)}) || false`,
      true
    ).catch(() => false);
    if (applied) return true;
  }
  return false;
}

export async function exitWebviewTheatre(webContentsId) {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) return false;
  const frames = webviewFrames(wc);
  await Promise.all(frames.map((frame) => (
    frame.executeJavaScript("window.__havynExitTheatre?.() || false", true).catch(() => false)
  )));
  return true;
}

export async function enterWebviewTheatre(webContentsId, selection = {}) {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) return { ok: false, reason: "browser-unavailable" };
  const frames = await installDetectorInWebviewFrames(wc);
  const targetUrl = String(selection.frameUrl || selection.url || "");
  const inspected = await Promise.all(frames.map(async (frame) => ({
    frame,
    url: frame.url || "",
    mediaCount: await frame.executeJavaScript("window.__havynScanMedia?.().length || 0", true).catch(() => 0)
  })));
  const candidates = inspected
    .filter((item) => item.mediaCount > 0)
    .sort((left, right) => {
      const leftMatch = targetUrl && left.url === targetUrl ? 1 : 0;
      const rightMatch = targetUrl && right.url === targetUrl ? 1 : 0;
      return rightMatch - leftMatch;
    });

  await exitWebviewTheatre(webContentsId);
  for (const candidate of candidates) {
    const result = await candidate.frame.executeJavaScript(
      `window.__havynEnterTheatre?.(${JSON.stringify(selection)}) || { ok: false, reason: "theatre-unavailable" }`,
      true
    ).catch(() => ({ ok: false, reason: "frame-script-failed" }));
    if (!result?.ok) continue;

    let childFrame = candidate.frame;
    let parentFrame = childFrame.parent;
    let expandedFrames = 0;
    while (parentFrame && !parentFrame.detached) {
      const expanded = await parentFrame.executeJavaScript(
        `window.__havynExpandTheatreFrame?.(${JSON.stringify(childFrame.url || "")}) || false`,
        true
      ).catch(() => false);
      if (!expanded) {
        await exitWebviewTheatre(webContentsId);
        return { ok: false, reason: "containing-frame-not-found" };
      }
      expandedFrames += 1;
      childFrame = parentFrame;
      parentFrame = parentFrame.parent;
    }
    appendDiagnosticRecord({
      scope: "live-share",
      event: "theatre-entered",
      webContentsId: wc.id,
      frameUrl: result.frameUrl || candidate.url,
      expandedFrames
    });
    return { ...result, expandedFrames };
  }
  return { ok: false, reason: candidates.length ? "target-not-confirmed" : "no-detected-player" };
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

ipcMain.handle("diagnostics:is-enabled", () => diagnosticsEnabled);
ipcMain.handle("diagnostics:get-path", () => diagnosticLogPath);
ipcMain.handle("diagnostics:open-folder", () => {
  initializeDiagnosticLog();
  if (diagnosticLogPath) shell.showItemInFolder(diagnosticLogPath);
  return diagnosticLogPath;
});
ipcMain.on("diagnostics:log", (_event, record) => appendDiagnosticRecord(record));
ipcMain.handle("call-media:set-active", (event, active) => (
  callMediaPermission.setActive(event.sender.id, active)
));

ipcMain.handle("screen-share:get-sources", async (event) => {
  if (event.sender.id !== mainWindow?.webContents?.id) return [];
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 360, height: 204 },
    fetchWindowIcons: true
  });
  screenSharePermission.registerSources(event.sender.id, sources);
  return [{
    id: "havyn:browser-region",
    name: "Havyn browser",
    displayId: "",
    thumbnail: "",
    appIcon: "",
    type: "browser-region"
  }, ...sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id || "",
    thumbnail: source.thumbnail?.toDataURL?.() || "",
    appIcon: source.appIcon?.toDataURL?.() || "",
    type: source.id.startsWith("screen:") ? "screen" : "window"
  }))];
});

ipcMain.handle("screen-share:select-source", async (event, selection = {}) => {
  if (event.sender.id !== mainWindow?.webContents?.id) return { armed: false };
  const requestedId = String(selection.sourceId || "");
  const browserRegion = requestedId === "havyn:browser-region";
  const currentSources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  let source = currentSources.find((item) => item.id === requestedId);
  let metadata = { captureMode: "source" };

  if (browserRegion) {
    const requestedRect = selection.browserRect || {};
    const windowBounds = mainWindow.getBounds();
    const contentBounds = mainWindow.getContentBounds();
    const width = Math.max(1, Number(requestedRect.width) || 1);
    const height = Math.max(1, Number(requestedRect.height) || 1);
    const windowSourceId = mainWindow.getMediaSourceId();
    source = currentSources.find((item) => item.id === windowSourceId);

    if (source) {
      const outerGeometry = {
        cropRect: {
          x: contentBounds.x + (Number(requestedRect.x) || 0) - windowBounds.x,
          y: contentBounds.y + (Number(requestedRect.y) || 0) - windowBounds.y,
          width,
          height
        },
        displayBounds: { width: windowBounds.width, height: windowBounds.height }
      };
      const contentGeometry = {
        cropRect: {
          x: Number(requestedRect.x) || 0,
          y: Number(requestedRect.y) || 0,
          width,
          height
        },
        displayBounds: { width: contentBounds.width, height: contentBounds.height }
      };
      metadata = {
        captureMode: "browser-window-region",
        ...outerGeometry,
        cropCandidates: [outerGeometry, contentGeometry]
      };
    } else {
      const display = screen.getDisplayMatching(windowBounds);
      source = currentSources.find((item) => String(item.display_id) === String(display.id))
        || currentSources.find((item) => item.id.startsWith("screen:"));
      metadata = {
        captureMode: "browser-region",
        cropRect: {
          x: contentBounds.x + (Number(requestedRect.x) || 0) - display.bounds.x,
          y: contentBounds.y + (Number(requestedRect.y) || 0) - display.bounds.y,
          width,
          height
        },
        displayBounds: { width: display.bounds.width, height: display.bounds.height }
      };
    }
  }

  if (!source) return { armed: false };
  screenSharePermission.registerSources(event.sender.id, [source]);
  const armed = screenSharePermission.select(
    event.sender.id,
    source.id,
    Boolean(selection.withAudio),
    metadata
  );
  return { armed, ...metadata };
});

ipcMain.handle("screen-share:cancel", (event) => {
  if (event.sender.id !== mainWindow?.webContents?.id) return false;
  screenSharePermission.reset();
  return true;
});

ipcMain.handle("app:get-browser-preload-url", () => `file://${path.join(__dirname, "browserPreload.js").replace(/\\/g, "/")}`);
ipcMain.handle("app:get-browser-partition", () => browserPartition());

ipcMain.handle("browser:register-webview", (_event, webContentsId) => {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc) return false;
  if (registeredWebviews.has(wc.id)) return true;
  registeredWebviews.add(wc.id);
  wc.setWindowOpenHandler(({ url }) => {
    mainWindow?.webContents.send("browser:load-state", {
      type: "warning",
      url,
      message: "Popup blocked."
    });
    return { action: "deny" };
  });
  wc.on("console-message", async (details) => {
    const message = details?.message || "";
    if (String(message).includes("__HAVYN_FRAME_DIAGNOSTIC__")) {
      const serialized = String(message).slice(String(message).indexOf("__HAVYN_FRAME_DIAGNOSTIC__") + "__HAVYN_FRAME_DIAGNOSTIC__".length);
      try {
        appendDiagnosticRecord({ scope: "embedded-frame", webContentsId: wc.id, ...JSON.parse(serialized) });
      } catch {
        appendDiagnosticRecord({ scope: "embedded-frame", event: "malformed-frame-diagnostic" });
      }
      return;
    }
    if (!String(message || "").includes("__HAVYN_FRAME_MEDIA_")) return;
    if (String(message).includes("__HAVYN_FRAME_MEDIA_EVENT__")) {
      const serialized = String(message).slice(String(message).indexOf("__HAVYN_FRAME_MEDIA_EVENT__") + "__HAVYN_FRAME_MEDIA_EVENT__".length);
      try {
        const payload = JSON.parse(serialized);
        if (payload?.media) {
          mainWindow?.webContents.send("browser:media-event", {
            ...payload,
            media: normalizeWebviewMedia(wc, [payload.media])[0],
            sourceFrameUrl: payload.media.frameUrl || details?.frame?.url || ""
          });
        }
      } catch {
        // Ignore malformed messages from unrelated page scripts.
      }
    }
    if (String(message || "").includes("__HAVYN_FRAME_MEDIA_SCAN__")) {
      const media = await scanWebviewMedia(wc.id);
      if (media.length) mainWindow?.webContents.send("browser:media-detected", media);
    }
  });
  wc.on("destroyed", () => {
    registeredWebviews.delete(wc.id);
  });
  return true;
});

ipcMain.handle("browser:scan-webview-media", async (_event, webContentsId) => {
  const media = await scanWebviewMedia(webContentsId);
  if (media.length) mainWindow?.webContents.send("browser:media-detected", media);
  return media;
});

ipcMain.handle("browser:apply-webview-playback", (_event, webContentsId, state) => applyWebviewPlayback(webContentsId, state));

ipcMain.handle("browser:enter-webview-theatre", (event, webContentsId, selection) => {
  if (event.sender.id !== mainWindow?.webContents?.id || !registeredWebviews.has(Number(webContentsId))) {
    return { ok: false, reason: "browser-not-registered" };
  }
  return enterWebviewTheatre(webContentsId, selection);
});

ipcMain.handle("browser:exit-webview-theatre", (event, webContentsId) => {
  if (event.sender.id !== mainWindow?.webContents?.id || !registeredWebviews.has(Number(webContentsId))) return false;
  return exitWebviewTheatre(webContentsId);
});

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

ipcMain.on("browser:media-detected-from-page", (event, { tabId, media }) => {
  const tab = tabs.get(tabId);
  if (tabId === activeTabId) {
    mainWindow?.webContents.send("browser:media-detected", normalizeDetectedMedia(tab, media));
    return;
  }
  if (registeredWebviews.has(event.sender.id)) {
    mainWindow?.webContents.send("browser:media-detected", normalizeWebviewMedia(event.sender, media));
  }
});

ipcMain.on("browser:media-event-from-page", (event, payload) => {
  if (payload?.tabId === activeTabId) {
    const tab = tabs.get(payload.tabId);
    mainWindow?.webContents.send("browser:media-event", {
      eventId: payload.eventId,
      eventName: payload.eventName,
      media: normalizeDetectedMedia(tab, [payload.media])[0],
      controlledByHavyn: payload.controlledByHavyn
    });
    return;
  }
  if (registeredWebviews.has(event.sender.id) && payload?.media) {
    mainWindow?.webContents.send("browser:media-event", {
      ...payload,
      media: normalizeWebviewMedia(event.sender, [payload.media])[0],
      sourceFrameUrl: payload.media.frameUrl || event.senderFrame?.url || ""
    });
  }
});

if (process.env.HAVYN_SKIP_APP_BOOTSTRAP !== "1") app.whenReady().then(() => {
  initializeDiagnosticLog();
  const canUseAppMedia = (requestingWebContents, permission) => {
    if (["display-capture", "screen-capture"].includes(permission)) {
      return requestingWebContents?.id === mainWindow?.webContents?.id;
    }
    if (permission === "media" && screenSharePermission.canGrant(requestingWebContents?.id)) {
      return true;
    }
    return callMediaPermission.canGrant(requestingWebContents?.id, permission);
  };
  session.defaultSession.setPermissionCheckHandler(canUseAppMedia);
  session.defaultSession.setPermissionRequestHandler((requestingWebContents, permission, callback) => {
    callback(canUseAppMedia(requestingWebContents, permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const requestingWebContents = webContents.fromFrame?.(request.frame);
    const selection = screenSharePermission.consume(requestingWebContents?.id);
    if (!selection) return callback({});
    callback({
      video: selection.source,
      ...(selection.withAudio ? { audio: "loopback" } : {})
    });
  });
  browserSession().setPermissionCheckHandler(() => false);
  browserSession().setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  installRequestGuard();
  createMainWindow();
});

app.on("before-quit", () => {
  callMediaPermission.reset();
  screenSharePermission.reset();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

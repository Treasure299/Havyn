import { ipcRenderer } from "electron";
import { createRemotePlaybackExpectation, matchesRemotePlaybackEvent } from "./playbackEventClassifier.js";
import { protectedPlaybackService } from "./protectedPlaybackAdapter.js";

const tabIdArg = globalThis.process?.argv?.find((arg) => arg.startsWith("--havyn-tab-id="));
const tabId = tabIdArg?.split("=")[1] || "unknown";
let lastSignature = "";
let pendingPlayback = null;
let playbackRetryTimer = null;
let remotePlaybackExpectation = null;
let playbackCommandSequence = 0;
let latestPlaybackAction = "";
let lastMediaEvent = null;
let scanTimer = null;
let lastTimeUpdateAt = 0;
let lastResumeDismissAt = 0;
let diagnosticsEnabled = false;

ipcRenderer.invoke("diagnostics:is-enabled")
  .then((enabled) => {
    diagnosticsEnabled = Boolean(enabled);
    if (diagnosticsEnabled) diagnostic("embedded-preload-ready", { tabId });
  })
  .catch(() => {});

try {
  const blockedWindowOpen = () => null;
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: blockedWindowOpen
  });
} catch {
  // Some pages lock down globals; request-level popup blocking still applies.
}

function sendPageSignal(channel, payload) {
  // ipcMain receives senderFrame for both BrowserView and cross-origin webview
  // subframes. That is the single authoritative route for media events.
  ipcRenderer.send(channel, payload);
}

function diagnostic(event, details = {}) {
  if (!diagnosticsEnabled) return;
  ipcRenderer.send("diagnostics:log", {
    scope: "embedded-preload",
    event,
    tabId,
    frameUrl: window.location.href,
    ...details
  });
}

function readableDocuments() {
  const docs = [document];
  for (const frame of Array.from(window.frames || [])) {
    try {
      if (frame.document) docs.push(frame.document);
    } catch {
      // Cross-origin frames are handled by their own preload when Electron allows it.
    }
  }
  return docs;
}

function allRoots(root = document) {
  const roots = [root];
  for (const node of root.querySelectorAll?.("*") || []) {
    if (node.shadowRoot) roots.push(node.shadowRoot);
  }
  return roots;
}

function findVideos() {
  const found = [];
  for (const doc of readableDocuments()) {
    for (const root of allRoots(doc)) {
      found.push(...Array.from(root.querySelectorAll?.("video") || []));
    }
  }
  return [...new Set(found)];
}

function describeVideo(video, index) {
  video.dataset.havynMediaId = video.dataset.havynMediaId || `video-${index}`;
  let pageUrl = window.location.href;
  try {
    pageUrl = window.top?.location?.href || pageUrl;
  } catch {
    pageUrl = document.referrer || pageUrl;
  }
  return {
    id: video.dataset.havynMediaId,
    index,
    title:
      document.querySelector("meta[property='og:title']")?.content ||
      document.title ||
      video.getAttribute("title") ||
      "Detected video",
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
}

function diagnosticMediaState() {
  return findVideos().slice(0, 4).map((video) => ({
    currentTime: Number(video.currentTime || 0),
    paused: Boolean(video.paused),
    playbackRate: Number(video.playbackRate || 1),
    readyState: Number(video.readyState || 0)
  }));
}

function diagnosticInputSnapshot(event) {
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
    media: diagnosticMediaState()
  };
}

function installDiagnosticInputTracing() {
  if (window.__havynDiagnosticInputTracingInstalled) return;
  window.__havynDiagnosticInputTracingInstalled = true;
  document.addEventListener("pointerdown", (event) => {
    diagnostic("input-pointerdown-capture", diagnosticInputSnapshot(event));
  }, true);
  document.addEventListener("pointerup", (event) => {
    diagnostic("input-pointerup-capture", diagnosticInputSnapshot(event));
  }, true);
  document.addEventListener("click", (event) => {
    const snapshot = diagnosticInputSnapshot(event);
    diagnostic("input-click-capture", snapshot);
    setTimeout(() => diagnostic("input-click-after-120ms", {
      ...snapshot,
      media: diagnosticMediaState()
    }), 120);
  }, true);
  document.addEventListener("click", (event) => {
    diagnostic("input-click-bubble", diagnosticInputSnapshot(event));
  }, false);
  document.addEventListener("keydown", (event) => {
    if (["Space", "Enter", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      diagnostic("input-keydown-capture", {
        code: event.code,
        defaultPrevented: event.defaultPrevented,
        target: event.target?.tagName || "",
        media: diagnosticMediaState()
      });
    }
  }, true);
}

function emitDetected(force = false) {
  const media = findVideos().map(describeVideo);
  const signature = JSON.stringify(media.map((item) => [
    item.id,
    item.title,
    item.duration,
    item.readyState,
    item.width,
    item.height,
    item.src,
    item.url
  ]));
  if (force || signature !== lastSignature) {
    lastSignature = signature;
    sendPageSignal("browser:media-detected-from-page", { tabId, media });
  }
  return media;
}

function emitEvent(eventName, video) {
  if (eventName === "timeupdate" && Date.now() - lastTimeUpdateAt < 1000) return;
  if (eventName === "timeupdate") lastTimeUpdateAt = Date.now();
  const index = findVideos().indexOf(video);
  const media = describeVideo(video, index);
  const payload = {
    eventId: `${tabId}:${eventName}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    tabId,
    eventName,
    media,
    controlledByHavyn: matchesRemotePlaybackEvent(remotePlaybackExpectation, eventName, media)
  };
  lastMediaEvent = payload;
  if (["play", "playing", "pause", "seeking", "seeked", "ratechange"].includes(eventName)) {
    diagnostic("media-event", {
      eventName,
      controlledByHavyn: payload.controlledByHavyn,
      media: {
        currentTime: media.currentTime,
        paused: media.paused,
        playbackRate: media.playbackRate,
        readyState: media.readyState
      }
    });
  }
  sendPageSignal("browser:media-event-from-page", payload);
  if (["loadedmetadata", "canplay", "playing"].includes(eventName)) emitDetected(true);
}

function cancelPendingPlayback(action = "local") {
  playbackCommandSequence += 1;
  latestPlaybackAction = action;
  pendingPlayback = null;
  remotePlaybackExpectation = null;
  if (playbackRetryTimer) clearTimeout(playbackRetryTimer);
  playbackRetryTimer = null;
}

function installLocalIntentCancellation() {
  if (window.__havynLocalIntentCancellationInstalled) return;
  window.__havynLocalIntentCancellationInstalled = true;
  document.addEventListener("pointerdown", (event) => {
    if (event.button === 0) cancelPendingPlayback();
  }, true);
  document.addEventListener("keydown", () => cancelPendingPlayback(), true);
}

function attach(video) {
  if (video.dataset.havynMediaEventsAttached) return;
  video.dataset.havynMediaEventsAttached = "preload";
  ["play", "pause", "seeking", "seeked", "timeupdate", "loadedmetadata", "canplay", "playing", "ended", "ratechange"].forEach((eventName) => {
    video.addEventListener(eventName, () => emitEvent(eventName, video), true);
  });
}

function scan(force = false) {
  if (force || Date.now() - lastResumeDismissAt > 3000) {
    lastResumeDismissAt = Date.now();
    dismissResumePrompt();
  }
  const videos = findVideos();
  videos.forEach(attach);
  return emitDetected(force);
}

function scheduleScan(force = false) {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan(force);
  }, force ? 80 : 500);
}

function visibleText(node) {
  return (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
}

function clickElement(node) {
  node?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  node?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  node?.click?.();
}

function dismissResumePrompt() {
  const roots = readableDocuments().flatMap((doc) => allRoots(doc));
  for (const root of roots) {
    const candidates = Array.from(root.querySelectorAll?.("button, [role='button'], a, div, span") || []);
    const hasResumePrompt = candidates.some((node) => /^continue from\s+/i.test(visibleText(node)));
    if (!hasResumePrompt) continue;

    const cancel = candidates.find((node) => /^cancel$/i.test(visibleText(node)));
    if (cancel) {
      clickElement(cancel);
      return;
    }
  }
}

async function applyPlayback(state = {}) {
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
  const protectedService = protectedPlaybackService(window.location.href);
  if (protectedService) {
    // The main-world detector owns protected playback. The isolated preload
    // must never duplicate its command by mutating the DRM video element.
    diagnostic("protected-playback-delegated", {
      service: protectedService,
      action: action || "sync"
    });
    return false;
  }
  const video = findVideos().find((item) => item.readyState > 0) || findVideos()[0];
  if (!video) {
    diagnostic("playback-command-no-video", { action: command.action || "sync" });
    queuePlaybackRetry(command);
    return false;
  }
  remotePlaybackExpectation = createRemotePlaybackExpectation({ action, currentTime, playbackRate });
  if (action !== "play") pendingPlayback = null;
  if (typeof playbackRate === "number") video.playbackRate = playbackRate;
  if (typeof currentTime === "number" && Math.abs(video.currentTime - currentTime) > 0.35) {
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
}

function schedulePlaybackRetry() {
  if (playbackRetryTimer || !pendingPlayback) return;
  playbackRetryTimer = setTimeout(() => {
    playbackRetryTimer = null;
    const command = pendingPlayback;
    pendingPlayback = null;
    if (command) applyPlayback(command).catch(() => {});
  }, 700);
}

function queuePlaybackRetry(state) {
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
}

ipcRenderer.on("browser:scan-media", () => scan(true));
ipcRenderer.on("browser:apply-playback", (_event, state) => applyPlayback(state).catch(() => {}));

window.__havynScanMedia = () => scan(true);
window.__havynReadMediaEvent = () => {
  const event = lastMediaEvent;
  lastMediaEvent = null;
  return event;
};
window.__havynApplyPlayback = applyPlayback;

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes || []) {
      if (node?.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches?.("video") || node.querySelector?.("video")) {
        scheduleScan(false);
        return;
      }
    }
  }
});
function startObserver() {
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}
window.addEventListener("DOMContentLoaded", () => {
  installDiagnosticInputTracing();
  installLocalIntentCancellation();
  startObserver();
  scheduleScan(true);
});
window.addEventListener("load", () => scheduleScan(true));
startObserver();
installDiagnosticInputTracing();
installLocalIntentCancellation();
setInterval(() => scan(false), 5000);
setInterval(() => {
  if (pendingPlayback) {
    const command = pendingPlayback;
    pendingPlayback = null;
    applyPlayback(command).catch(() => {});
  }
}, 1500);
setTimeout(() => scan(true), 500);
setTimeout(() => scan(true), 1800);
setTimeout(() => scan(true), 4000);

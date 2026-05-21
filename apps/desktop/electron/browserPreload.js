import { ipcRenderer } from "electron";

const tabIdArg = globalThis.process?.argv?.find((arg) => arg.startsWith("--havyn-tab-id="));
const tabId = tabIdArg?.split("=")[1] || "unknown";
let lastSignature = "";
let pendingPlayback = null;
let playbackRetryTimer = null;
let applyingRemoteUntil = 0;
let lastMediaEvent = null;
let scanTimer = null;
let lastTimeUpdateAt = 0;
let lastResumeDismissAt = 0;

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
    url: pageUrl
  };
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
    ipcRenderer.send("browser:media-detected-from-page", { tabId, media });
  }
  return media;
}

function emitEvent(eventName, video) {
  if (eventName === "timeupdate" && Date.now() - lastTimeUpdateAt < 1000) return;
  if (eventName === "timeupdate") lastTimeUpdateAt = Date.now();
  const index = findVideos().indexOf(video);
  const payload = {
    tabId,
    eventName,
    media: describeVideo(video, index),
    controlledByHavyn: Date.now() < applyingRemoteUntil
  };
  lastMediaEvent = payload;
  ipcRenderer.send("browser:media-event-from-page", payload);
  if (["loadedmetadata", "canplay", "playing"].includes(eventName)) emitDetected(true);
}

function attach(video) {
  if (video.dataset.havynPreloadListenersAttached) return;
  video.dataset.havynPreloadListenersAttached = "true";
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

function applyPlayback({ action, currentTime, playbackRate }) {
  const video = findVideos().find((item) => item.readyState > 0) || findVideos()[0];
  if (!video) {
    pendingPlayback = { action, currentTime, playbackRate };
    schedulePlaybackRetry();
    return false;
  }
  applyingRemoteUntil = Date.now() + 900;
  if (action !== "play") pendingPlayback = null;
  if (typeof playbackRate === "number") video.playbackRate = playbackRate;
  if (typeof currentTime === "number" && Math.abs(video.currentTime - currentTime) > 0.35) {
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
}

function schedulePlaybackRetry() {
  if (playbackRetryTimer || !pendingPlayback) return;
  playbackRetryTimer = setTimeout(() => {
    playbackRetryTimer = null;
    if (pendingPlayback) applyPlayback(pendingPlayback);
  }, 700);
}

ipcRenderer.on("browser:scan-media", () => scan(true));
ipcRenderer.on("browser:apply-playback", (_event, state) => applyPlayback(state));

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
  startObserver();
  scheduleScan(true);
});
window.addEventListener("load", () => scheduleScan(true));
startObserver();
setInterval(() => scan(false), 5000);
setInterval(() => {
  if (pendingPlayback) applyPlayback(pendingPlayback);
}, 1500);
setTimeout(() => scan(true), 500);
setTimeout(() => scan(true), 1800);
setTimeout(() => scan(true), 4000);

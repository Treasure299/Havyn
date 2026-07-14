import { ipcRenderer } from "electron";
import { createRemotePlaybackExpectation, matchesRemotePlaybackEvent } from "./playbackEventClassifier.js";

const tabIdArg = globalThis.process?.argv?.find((arg) => arg.startsWith("--havyn-tab-id="));
const tabId = tabIdArg?.split("=")[1] || "unknown";
let lastSignature = "";
let pendingPlayback = null;
let playbackRetryTimer = null;
let remotePlaybackExpectation = null;
let lastMediaEvent = null;
let scanTimer = null;
let lastTimeUpdateAt = 0;
let lastResumeDismissAt = 0;

try {
  const blockedWindowOpen = () => null;
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: blockedWindowOpen
  });
  document.addEventListener("click", (event) => {
    const link = event.target?.closest?.("a[target='_blank'], a[onclick], area[target='_blank']");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (/^(javascript:|#|$)/i.test(href)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const link = event.target?.closest?.("a[href], area[href]");
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
} catch {
  // Some pages lock down globals; request-level popup blocking still applies.
}

function sendPageSignal(channel, payload) {
  ipcRenderer.send(channel, payload);
  try {
    ipcRenderer.sendToHost(channel, payload);
  } catch {
    // BrowserView does not have an embedder host; webview does.
  }
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
  sendPageSignal("browser:media-event-from-page", payload);
  if (["loadedmetadata", "canplay", "playing"].includes(eventName)) emitDetected(true);
}

function attachClickToggle(video) {
  if (!video || video.dataset.havynClickToggleAttached) return;
  video.dataset.havynClickToggleAttached = "true";
  let pointerDownAt = 0;
  let clickTimer = null;

  video.addEventListener("pointerdown", (event) => {
    if (event.button === 0) pointerDownAt = Date.now();
  }, true);
  video.addEventListener("dblclick", () => {
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = null;
  }, true);
  video.addEventListener("click", (event) => {
    if (event.button !== 0 || event.detail > 1 || Date.now() - pointerDownAt > 900) return;
    const rect = video.getBoundingClientRect();
    const controlsHeight = Math.min(72, rect.height * 0.18);
    if (video.controls && event.clientY >= rect.bottom - controlsHeight) return;
    const wasPaused = video.paused;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (video.paused !== wasPaused) return;
      if (wasPaused) video.play().catch(() => {});
      else video.pause();
    }, 220);
  }, true);
}

function videoAtPoint(clientX, clientY) {
  const direct = document.elementsFromPoint?.(clientX, clientY)
    ?.find((node) => node?.tagName === "VIDEO");
  if (direct) return direct;
  return findVideos()
    .filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 80 && rect.height > 60 &&
        clientX >= rect.left && clientX <= rect.right &&
        clientY >= rect.top && clientY <= rect.bottom;
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
    })[0] || null;
}

function isPlayerControlTarget(target, video) {
  const control = target?.closest?.(
    "button, input, select, textarea, a, [role='button'], [role='slider'], " +
    "[class*='control'], [class*='progress'], [class*='seek'], [class*='volume']"
  );
  if (!control || !video) return false;
  if (control.matches?.("input, select, textarea, [role='slider']")) return true;
  const controlLabel = [
    control.getAttribute?.("aria-label"),
    control.getAttribute?.("title"),
    control.getAttribute?.("data-title"),
    control.getAttribute?.("data-tooltip"),
    control.className,
    control.textContent
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  // Let Havyn verify center play/pause controls. Some custom players render the
  // button but fail to toggle when embedded, while keyboard playback still works.
  if (/\b(play|pause|resume|replay)\b/i.test(controlLabel)) return false;
  const videoRect = video.getBoundingClientRect();
  const controlRect = control.getBoundingClientRect();
  const videoArea = Math.max(1, videoRect.width * videoRect.height);
  const controlArea = Math.max(0, controlRect.width * controlRect.height);
  // A large role=button layer is commonly the site's click-to-toggle surface,
  // not a discrete player control. Let Havyn's guarded fallback handle it.
  return controlArea / videoArea < 0.28;
}

function installDocumentClickToggle() {
  if (window.__havynDocumentClickToggleInstalled) return;
  window.__havynDocumentClickToggleInstalled = true;
  let pointerDown = null;
  let clickTimer = null;

  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pendingPlayback = null;
    remotePlaybackExpectation = null;
    if (playbackRetryTimer) clearTimeout(playbackRetryTimer);
    playbackRetryTimer = null;
    findVideos().forEach((video) => {
      delete video.dataset.havynControlledUntil;
    });
    pointerDown = { x: event.clientX, y: event.clientY, at: Date.now() };
  }, true);

  document.addEventListener("keydown", () => {
    pendingPlayback = null;
    remotePlaybackExpectation = null;
    if (playbackRetryTimer) clearTimeout(playbackRetryTimer);
    playbackRetryTimer = null;
    findVideos().forEach((video) => {
      delete video.dataset.havynControlledUntil;
    });
  }, true);

  document.addEventListener("dblclick", () => {
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = null;
  }, true);

  document.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.detail > 1 ||
      !pointerDown ||
      Date.now() - pointerDown.at > 900 ||
      Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 12
    ) return;

    const video = videoAtPoint(event.clientX, event.clientY);
    if (!video || event.target === video) return;
    if (isPlayerControlTarget(event.target, video)) return;
    const rect = video.getBoundingClientRect();
    if (event.clientY >= rect.bottom - Math.min(76, rect.height * 0.2)) return;
    const wasPaused = video.paused;
    const previousTime = video.currentTime;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      // Normal playback (especially a site's press-to-2x gesture) advances time
      // during this delay. Only a real state change or a substantial seek means
      // the site handled the click itself.
      const siteHandledClick = video.paused !== wasPaused || Math.abs(video.currentTime - previousTime) > 1.25;
      if (siteHandledClick) return;
      if (wasPaused) video.play().catch(() => {});
      else video.pause();
    }, 260);
  }, true);
}

function attach(video) {
  attachClickToggle(video);
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

async function applyPlayback({ action, currentTime, playbackRate, __havynRetryCount, __havynExpiresAt }) {
  const video = findVideos().find((item) => item.readyState > 0) || findVideos()[0];
  if (!video) {
    queuePlaybackRetry({ action, currentTime, playbackRate, __havynRetryCount, __havynExpiresAt });
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
      pendingPlayback = null;
      return !video.paused;
    } catch {
      queuePlaybackRetry({ action, currentTime, playbackRate, __havynRetryCount, __havynExpiresAt });
      return false;
    }
  }
  if (action === "pause" && !video.paused) video.pause();
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
  installDocumentClickToggle();
  startObserver();
  scheduleScan(true);
});
window.addEventListener("load", () => scheduleScan(true));
startObserver();
installDocumentClickToggle();
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

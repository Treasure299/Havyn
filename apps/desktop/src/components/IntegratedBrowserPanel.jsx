import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Compass, ExternalLink, Film, FolderPlus, Plus, Puzzle, Radar, RefreshCw, RotateCw, Shield, X } from "lucide-react";
import { domBrowserEvents, registerDomBrowser } from "../lib/domBrowserBridge";

function normalizeUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function normalizeDetectedItems(items = [], webview) {
  const pageUrl = webview?.getURL?.() || "";
  return (items || []).map((item) => ({
    ...item,
    pageUrl: item.pageUrl || pageUrl || item.url,
    frameUrl: item.frameUrl || item.url,
    url: item.url || item.frameUrl || pageUrl
  }));
}

const WEBVIEW_DETECTOR_SCRIPT = String.raw`
(() => {
  if (window.__havynDomDetectorInstalled) {
    window.__havynScanMedia?.();
    return true;
  }
  window.__havynDomDetectorInstalled = true;
  let lastMediaEvent = null;
  let applyingRemoteUntil = 0;
  let pendingPlayback = null;
  let playbackRetryTimer = null;
  let scanTimer = null;
  let lastTimeUpdateAt = 0;

  const readableDocuments = () => {
    const docs = [document];
    for (const frame of Array.from(window.frames || [])) {
      try {
        if (frame.document) docs.push(frame.document);
      } catch {}
    }
    return docs;
  };

  const allRoots = (root = document) => {
    const roots = [root];
    for (const node of root.querySelectorAll?.("*") || []) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
    return roots;
  };

  const findVideos = () => {
    const found = [];
    for (const doc of readableDocuments()) {
      for (const root of allRoots(doc)) {
        found.push(...Array.from(root.querySelectorAll?.("video") || []));
      }
    }
    return [...new Set(found)];
  };

  const describeVideo = (video, index) => {
    video.dataset.havynMediaId = video.dataset.havynMediaId || "video-" + index;
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
      pageUrl: window.location.href,
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
    console.debug("__HAVYN_MEDIA_EVENT__");
  };

  const attach = (video) => {
    if (!video || video.dataset.havynDomAttached) return;
    video.dataset.havynDomAttached = "true";
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
      console.debug("__HAVYN_MEDIA_SCAN__");
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

export default function IntegratedBrowserPanel({ browser, currentUrl, onLoadUrl, activeMediaTitle, onWebMediaDetected, onWebMediaEvent, webPlaybackState, className = "", layoutSignal = "" }) {
  const frameRef = useRef(null);
  const iframeRef = useRef(null);
  const webviewRef = useRef(null);
  const [url, setUrl] = useState("https://interactive-examples.mdn.mozilla.net/pages/tabbed/video.html");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewBlocked, setPreviewBlocked] = useState(false);
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [notice, setNotice] = useState("");
  const [adBlockEnabled, setAdBlockEnabled] = useState(false);
  const [adBlockBypassed, setAdBlockBypassed] = useState(false);
  const [preloadUrl, setPreloadUrl] = useState("");
  const [webviewPartition, setWebviewPartition] = useState("");
  const useDomWebview = Boolean(browser?.isDomWebview);

  const updateBrowserBounds = useCallback(() => {
    if (!browser || browser.isDomWebview || !frameRef.current) return;
    const rect = frameRef.current.getBoundingClientRect();
    browser.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }, [browser]);

  useLayoutEffect(() => {
    if (!browser || browser.isDomWebview || !frameRef.current) return undefined;
    const createBounds = () => {
      const rect = frameRef.current.getBoundingClientRect();
      browser.create({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
    };
    createBounds();
    const resizeObserver = new ResizeObserver(updateBrowserBounds);
    resizeObserver.observe(frameRef.current);
    window.addEventListener("resize", updateBrowserBounds);
    window.setTimeout(updateBrowserBounds, 60);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateBrowserBounds);
      browser.destroy();
    };
  }, [browser, updateBrowserBounds]);

  useEffect(() => {
    if (!browser || browser.isDomWebview) return undefined;
    const timers = [0, 80, 220, 520].map((delay) => window.setTimeout(updateBrowserBounds, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [browser, layoutSignal, updateBrowserBounds]);

  useEffect(() => {
    window.havyn?.browser?.getPreloadUrl?.().then(setPreloadUrl).catch(() => {});
    window.havyn?.browser?.getPartition?.().then(setWebviewPartition).catch(() => {});
  }, []);

  const emitTabs = useCallback((nextTabs = tabs, nextActiveTabId = activeTabId) => {
    domBrowserEvents.tabs({ tabs: nextTabs, activeTabId: nextActiveTabId });
  }, [activeTabId, tabs]);

  const scanDomMedia = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return [];
    const webContentsId = webview.getWebContentsId?.();
    const frameMedia = webContentsId
      ? await window.havyn?.browser?.scanWebviewMedia?.(webContentsId).catch(() => [])
      : [];
    const normalizedFrameMedia = normalizeDetectedItems(frameMedia, webview);
    if (normalizedFrameMedia.length) {
      domBrowserEvents.mediaDetected(normalizedFrameMedia);
      onWebMediaDetected?.(normalizedFrameMedia, null);
      return normalizedFrameMedia;
    }
    await webview.executeJavaScript(WEBVIEW_DETECTOR_SCRIPT, true).catch(() => false);
    const media = await webview.executeJavaScript("window.__havynScanMedia?.() || []", true).catch(() => []);
    const normalized = normalizeDetectedItems(media, webview);
    if (normalized.length) {
      domBrowserEvents.mediaDetected(normalized);
      onWebMediaDetected?.(normalized, null);
    }
    return normalized;
  }, [onWebMediaDetected]);

  useEffect(() => {
    if (!useDomWebview) return undefined;
    const webview = webviewRef.current;
    if (!webview) return undefined;
    const registerWebview = () => {
      const webContentsId = webview.getWebContentsId?.();
      if (webContentsId) window.havyn?.browser?.registerWebview?.(webContentsId).catch(() => {});
    };
    const installDetector = () => {
      registerWebview();
      webview.executeJavaScript(WEBVIEW_DETECTOR_SCRIPT, true).catch(() => false);
      window.setTimeout(scanDomMedia, 250);
      window.setTimeout(scanDomMedia, 1200);
    };
    const handleLoad = () => {
      const activeUrl = webview.getURL?.() || "";
      const activeTitle = webview.getTitle?.() || activeUrl || "New tab";
      setUrl(activeUrl || url);
      setTabs((currentTabs) => {
        const nextTabs = currentTabs.map((tab) => (
          tab.id === activeTabId ? { ...tab, title: activeTitle, url: activeUrl } : tab
        ));
        domBrowserEvents.tabs({ tabs: nextTabs, activeTabId });
        return nextTabs;
      });
      domBrowserEvents.navigation({ url: activeUrl });
      installDetector();
      window.setTimeout(scanDomMedia, 1800);
    };
    const handleNavigate = (event) => {
      setUrl(event.url);
      domBrowserEvents.navigation({ url: event.url });
    };
    const handleConsole = async () => {
      const event = await webview.executeJavaScript("window.__havynReadMediaEvent?.()", true).catch(() => null);
      if (event) {
        domBrowserEvents.mediaEvent(event);
        onWebMediaEvent?.(event);
      }
    };
    const handleIpcMessage = (event) => {
      const [payload] = event.args || [];
      if (event.channel === "browser:media-detected-from-page") {
        const media = normalizeDetectedItems(payload?.media || [], webview);
        domBrowserEvents.mediaDetected(media);
        onWebMediaDetected?.(media, null);
      }
      if (event.channel === "browser:media-event-from-page") {
        const nextPayload = payload?.media
          ? { ...payload, media: normalizeDetectedItems([payload.media], webview)[0] }
          : payload;
        domBrowserEvents.mediaEvent(nextPayload);
        onWebMediaEvent?.(nextPayload);
      }
    };
    const blockPopup = (event) => {
      event.preventDefault?.();
      setNotice("Popup blocked");
      window.setTimeout(() => setNotice(""), 1600);
    };
    webview.addEventListener("did-finish-load", handleLoad);
    webview.addEventListener("dom-ready", installDetector);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("console-message", handleConsole);
    webview.addEventListener("ipc-message", handleIpcMessage);
    webview.addEventListener("new-window", blockPopup);
    webview.addEventListener("did-create-window", blockPopup);
    return () => {
      webview.removeEventListener("did-finish-load", handleLoad);
      webview.removeEventListener("dom-ready", installDetector);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("console-message", handleConsole);
      webview.removeEventListener("ipc-message", handleIpcMessage);
      webview.removeEventListener("new-window", blockPopup);
      webview.removeEventListener("did-create-window", blockPopup);
    };
  }, [activeTabId, onWebMediaDetected, onWebMediaEvent, preloadUrl, scanDomMedia, url, useDomWebview]);

  useEffect(() => {
    if (!useDomWebview) return undefined;
    const removeDetected = window.havyn?.browser?.onMediaDetected?.((media) => {
      domBrowserEvents.mediaDetected(media || []);
      onWebMediaDetected?.(media || [], null);
    });
    const removeEvent = window.havyn?.browser?.onMediaEvent?.((payload) => {
      domBrowserEvents.mediaEvent(payload);
      onWebMediaEvent?.(payload);
    });
    return () => {
      removeDetected?.();
      removeEvent?.();
    };
  }, [onWebMediaDetected, onWebMediaEvent, useDomWebview]);

  useEffect(() => {
    if (!useDomWebview) return undefined;
    const unregister = registerDomBrowser({
      loadUrl: async (nextUrl) => {
        const normalized = normalizeUrl(nextUrl);
        setUrl(normalized);
        domBrowserEvents.loadState({ type: "loading", url: normalized });
        await webviewRef.current?.loadURL(normalized);
        return normalized;
      },
      reload: () => webviewRef.current?.reload(),
      back: () => webviewRef.current?.canGoBack?.() && webviewRef.current.goBack(),
      forward: () => webviewRef.current?.canGoForward?.() && webviewRef.current.goForward(),
      focus: () => webviewRef.current?.focus(),
      newTab: async (nextUrl = "about:blank") => {
        const id = crypto.randomUUID();
        const normalized = nextUrl === "about:blank" ? nextUrl : normalizeUrl(nextUrl);
        const nextTabs = [...tabs, { id, title: "New tab", url: normalized }];
        setTabs(nextTabs);
        setActiveTabId(id);
        emitTabs(nextTabs, id);
        if (normalized !== "about:blank") await webviewRef.current?.loadURL(normalized);
        return { activeTabId: id, tabs: nextTabs };
      },
      switchTab: (tabId) => {
        setActiveTabId(tabId);
        emitTabs(tabs, tabId);
        const tab = tabs.find((item) => item.id === tabId);
        if (tab?.url && tab.url !== "about:blank") webviewRef.current?.loadURL(tab.url);
        return { activeTabId: tabId, tabs };
      },
      closeTab: (tabId) => {
        let nextTabs = tabs.filter((tab) => tab.id !== tabId);
        if (!nextTabs.length) nextTabs = [{ id: crypto.randomUUID(), title: "New tab", url: "" }];
        const nextActive = activeTabId === tabId ? nextTabs[0]?.id || "" : activeTabId;
        setTabs(nextTabs);
        setActiveTabId(nextActive);
        emitTabs(nextTabs, nextActive);
        const tab = nextTabs.find((item) => item.id === nextActive);
        if (tab?.url && tab.url !== "about:blank") webviewRef.current?.loadURL(tab.url);
        else webviewRef.current?.loadURL("about:blank");
        return { activeTabId: nextActive, tabs: nextTabs };
      },
      scanMedia: scanDomMedia,
      applyPlayback: async (state) => {
        const webContentsId = webviewRef.current?.getWebContentsId?.();
        const appliedInFrame = webContentsId
          ? await window.havyn?.browser?.applyWebviewPlayback?.(webContentsId, state).catch(() => false)
          : false;
        if (appliedInFrame) return true;
        return webviewRef.current?.executeJavaScript(`window.__havynApplyPlayback?.(${JSON.stringify(state)})`, true).catch(() => false);
      },
      toggleAdBlock: async () => {
        const result = await window.havyn?.browser?.toggleAdBlock?.();
        if (result) domBrowserEvents.adBlockState(result);
        webviewRef.current?.reload();
        return result || { enabled: false };
      },
      getAdBlockState: () => window.havyn?.browser?.getAdBlockState?.() || { enabled: false }
    });
    return unregister;
  }, [activeTabId, emitTabs, scanDomMedia, tabs, useDomWebview]);

  useEffect(() => {
    if (currentUrl) setUrl(currentUrl);
  }, [currentUrl]);

  useEffect(() => {
    if (!browser?.onTabs) return undefined;
    if (useDomWebview && tabs.length === 0) {
      const id = crypto.randomUUID();
      const initial = [{ id, title: "New tab", url: "" }];
      setTabs(initial);
      setActiveTabId(id);
      domBrowserEvents.tabs({ tabs: initial, activeTabId: id });
    }
    return browser.onTabs(({ tabs: nextTabs, activeTabId: nextActiveTabId }) => {
      setTabs(nextTabs || []);
      setActiveTabId(nextActiveTabId || "");
      const active = nextTabs?.find((tab) => tab.id === nextActiveTabId);
      if (active?.url) setUrl(active.url);
    });
  }, [browser, tabs.length, useDomWebview]);

  useEffect(() => {
    if (!browser?.onLoadState) return undefined;
    return browser.onLoadState((state) => {
      if (state?.type === "loading") {
        setNotice("Loading page...");
      }
      if (state?.type === "error") {
        setNotice(state.message || "Page could not be loaded.");
      }
      if (state?.type === "warning") {
        setNotice(state.message);
      }
      window.setTimeout(() => setNotice(""), state?.type === "error" ? 5200 : 3200);
    });
  }, [browser]);

  useEffect(() => {
    browser?.getAdBlockState?.().then((state) => {
      setAdBlockEnabled(Boolean(state?.enabled));
      setAdBlockBypassed(Boolean(state?.bypassed));
    });
  }, [browser]);

  useEffect(() => {
    if (!browser?.onAdBlockState) return undefined;
    return browser.onAdBlockState((state) => {
      setAdBlockEnabled(Boolean(state?.enabled));
      setAdBlockBypassed(Boolean(state?.bypassed));
      if (state?.bypassed) {
        setNotice(state.bypassReason || "Ad blocker bypassed for playback stability");
        window.setTimeout(() => setNotice(""), 2200);
      }
    });
  }, [browser]);

  function submit(event) {
    event.preventDefault();
    const normalized = normalizeUrl(url);
    setUrl(normalized);
    setPreviewBlocked(false);
    if (browser) {
      onLoadUrl(normalized);
      window.setTimeout(() => browser.scanMedia?.(), 1200);
      window.setTimeout(() => browser.scanMedia?.(), 3000);
    } else setPreviewUrl(normalized);
  }

  function loadTestVideo() {
    const testUrl = `${window.location.origin}/test-video.html`;
    setUrl(testUrl);
    setPreviewUrl(testUrl);
    setPreviewBlocked(false);
  }

  async function newTab() {
    if (browser) await browser.newTab?.();
    else {
      setPreviewUrl("");
      setUrl("https://interactive-examples.mdn.mozilla.net/pages/tabbed/video.html");
    }
  }

  async function scanMedia() {
    await browser?.scanMedia?.();
    setNotice("Scanning page for video");
    window.setTimeout(() => setNotice(""), 1600);
  }

  async function openWebStore() {
    await browser?.openWebStore?.();
    setNotice("Chrome Web Store opened in a browser tab");
    window.setTimeout(() => setNotice(""), 2200);
  }

  async function loadExtension() {
    const result = await browser?.loadUnpackedExtension?.();
    if (result?.ok) setNotice(`${result.extension?.name || "Extension"} loaded for browser tabs`);
    else if (!result?.canceled) setNotice("Extension could not be loaded");
    window.setTimeout(() => setNotice(""), 2400);
  }

  async function toggleAdBlock() {
    const result = await browser?.toggleAdBlock?.();
    setAdBlockEnabled(Boolean(result?.enabled));
    setAdBlockBypassed(Boolean(result?.bypassed));
    setNotice(result?.error || result?.bypassReason || (result?.enabled ? "Ad blocker on. Reloading tab" : "Ad blocker off. Reloading tab"));
    window.setTimeout(() => setNotice(""), 2200);
  }

  function detectWebPreviewMedia() {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument) return;
    const videos = Array.from(iframe.contentDocument.querySelectorAll("video"));
    const media = videos.map((video, index) => ({
      id: `web-video-${index}`,
      index,
      title: iframe.contentDocument.title || "Web preview video",
      currentTime: video.currentTime || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      paused: video.paused,
      playbackRate: video.playbackRate || 1,
      ended: video.ended,
      url: previewUrl
    }));
    onWebMediaDetected?.(media, videos[0]);
    videos.forEach((video, index) => {
      if (video.dataset.havynWebListenersAttached) return;
      video.dataset.havynWebListenersAttached = "true";
      ["play", "pause", "seeked", "ended", "ratechange"].forEach((eventName) => {
        video.addEventListener(eventName, () => {
          onWebMediaEvent?.({
            eventName,
            media: {
              id: `web-video-${index}`,
              index,
              title: iframe.contentDocument.title || "Web preview video",
              currentTime: video.currentTime || 0,
              duration: Number.isFinite(video.duration) ? video.duration : 0,
              paused: video.paused,
              playbackRate: video.playbackRate || 1,
              ended: video.ended,
              url: previewUrl
            },
            video
          });
        });
      });
    });
  }

  useEffect(() => {
    if (!webPlaybackState || browser || !iframeRef.current?.contentDocument) return;
    const video = iframeRef.current.contentDocument.querySelector("video");
    if (!video) return;
    if (typeof webPlaybackState.playbackRate === "number") video.playbackRate = webPlaybackState.playbackRate;
    if (typeof webPlaybackState.currentTime === "number" && Math.abs(video.currentTime - webPlaybackState.currentTime) > 0.35) {
      video.currentTime = Math.max(0, webPlaybackState.currentTime);
    }
    if (webPlaybackState.isPlaying) video.play().catch(() => {});
    else video.pause();
  }, [browser, webPlaybackState]);

  return (
    <section className={`browser-shell ${className}`}>
      {browser && (
        <div className="browser-tabs glass">
          {tabs.map((tab) => (
            <button
              className={`browser-tab ${tab.id === activeTabId ? "is-active" : ""}`}
              type="button"
              key={tab.id}
              onClick={() => browser.switchTab?.(tab.id)}
              title={tab.url || tab.title}
            >
              <span>{tab.title || "New tab"}</span>
              {tabs.length > 1 && (
                <i
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    browser.closeTab?.(tab.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      browser.closeTab?.(tab.id);
                    }
                  }}
                >
                  <X size={13} />
                </i>
              )}
            </button>
          ))}
          <button className="browser-tab-action" type="button" title="New tab" onClick={newTab}><Plus size={16} /></button>
        </div>
      )}
      <form className={`browser-bar glass ${browser ? "electron-browser-bar" : "has-test-button"}`} onSubmit={submit}>
        <Compass size={16} />
        {browser && <button className="icon-button" type="button" title="Back" onClick={() => browser.back?.()}><ArrowLeft size={17} /></button>}
        {browser && <button className="icon-button" type="button" title="Forward" onClick={() => browser.forward?.()}><ArrowRight size={17} /></button>}
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Open a video page" />
        <button className="icon-button" type="submit" title="Load URL"><RefreshCw size={18} /></button>
        {browser && <button className="icon-button" type="button" title="Reload tab" onClick={() => browser.reload?.()}><RotateCw size={18} /></button>}
        {browser && <button className="icon-button" type="button" title="Scan for media" onClick={scanMedia}><Radar size={18} /></button>}
        {browser && <button className="icon-button" type="button" title="Open Chrome Web Store" onClick={openWebStore}><Puzzle size={18} /></button>}
        {browser && <button className="icon-button" type="button" title="Load unpacked extension" onClick={loadExtension}><FolderPlus size={18} /></button>}
        {browser && (
          <button
            className={`icon-button ${adBlockEnabled ? "is-active" : ""}`}
            type="button"
            title={adBlockBypassed ? "Ad blocker bypassed on this streaming site" : adBlockEnabled ? "Ad blocker on" : "Ad blocker off"}
            onClick={toggleAdBlock}
          >
            <Shield size={18} />
            {adBlockBypassed && <b className="button-dot" />}
          </button>
        )}
        {!browser && <button className="icon-button" type="button" title="Load local test video" onClick={loadTestVideo}><Film size={18} /></button>}
      </form>
      <div className="browser-frame" ref={frameRef} onMouseEnter={() => browser?.focus?.()} onMouseDown={() => browser?.focus?.()}>
        {useDomWebview && preloadUrl && (
          <webview
            ref={webviewRef}
            className="dom-webview"
            src="about:blank"
            preload={preloadUrl}
            partition={webviewPartition}
            webpreferences="contextIsolation=yes,nodeIntegration=no,nodeIntegrationInSubFrames=yes,sandbox=no"
          />
        )}
        {!browser && previewUrl && (
          <>
            <iframe
              ref={iframeRef}
              className="browser-preview-frame"
              src={previewUrl}
              title="Havyn web preview"
              onLoad={() => {
                const isLocal = previewUrl.startsWith(window.location.origin);
                setPreviewBlocked(!browser && !isLocal);
                window.setTimeout(detectWebPreviewMedia, 350);
              }}
              onError={() => setPreviewBlocked(true)}
            />
            <div className="web-preview-note">
              {previewUrl.includes(window.location.origin) ? "Local test video loaded for browser testing." : "Some sites block web preview. Use Electron for full embedded browsing."}
              <button type="button" onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}><ExternalLink size={14} /> Open</button>
            </div>
          </>
        )}
        {!currentUrl && !previewUrl && (
          <div className="browser-placeholder">
            <span>H</span>
            <strong>Open a video page</strong>
            <p>Use the Electron app for full embedded browsing and media detection.</p>
          </div>
        )}
        {previewBlocked && (
          <div className="web-preview-blocked">
            <strong>This site blocks browser embedding.</strong>
            <span>That is expected for sites like YouTube in the Vite preview. Use the film button for local detection testing, or open Havyn in Electron for the real embedded browser.</span>
          </div>
        )}
        {notice && <div className="browser-notice">{notice}</div>}
      </div>
      <div className="media-title-strip">{activeMediaTitle || "No active room media selected"}</div>
    </section>
  );
}

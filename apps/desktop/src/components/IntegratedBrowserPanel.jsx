import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Compass, ExternalLink, Film, FolderPlus, Plus, Puzzle, Radar, RefreshCw, RotateCw, Shield, X } from "lucide-react";
import { domBrowserEvents, registerDomBrowser } from "../lib/domBrowserBridge";

function normalizeUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

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
  }, []);

  const emitTabs = useCallback((nextTabs = tabs, nextActiveTabId = activeTabId) => {
    domBrowserEvents.tabs({ tabs: nextTabs, activeTabId: nextActiveTabId });
  }, [activeTabId, tabs]);

  const scanDomMedia = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return [];
    const media = await webview.executeJavaScript("window.__havynScanMedia?.() || []", true).catch(() => []);
    const normalized = (media || []).map((item) => ({ ...item, url: webview.getURL?.() || item.url }));
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
    const handleLoad = () => {
      const activeUrl = webview.getURL?.() || "";
      setUrl(activeUrl || url);
      domBrowserEvents.navigation({ url: activeUrl });
      window.setTimeout(scanDomMedia, 500);
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
    webview.addEventListener("did-finish-load", handleLoad);
    webview.addEventListener("dom-ready", handleLoad);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("console-message", handleConsole);
    return () => {
      webview.removeEventListener("did-finish-load", handleLoad);
      webview.removeEventListener("dom-ready", handleLoad);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("console-message", handleConsole);
    };
  }, [onWebMediaEvent, preloadUrl, scanDomMedia, url, useDomWebview]);

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
        return { activeTabId: tabId, tabs };
      },
      closeTab: (tabId) => {
        const nextTabs = tabs.filter((tab) => tab.id !== tabId);
        const nextActive = activeTabId === tabId ? nextTabs[0]?.id || "" : activeTabId;
        setTabs(nextTabs.length ? nextTabs : [{ id: crypto.randomUUID(), title: "New tab", url: "" }]);
        setActiveTabId(nextActive);
        emitTabs(nextTabs, nextActive);
        return { activeTabId: nextActive, tabs: nextTabs };
      },
      scanMedia: scanDomMedia,
      applyPlayback: (state) => webviewRef.current?.executeJavaScript(`window.__havynApplyPlayback?.(${JSON.stringify(state)})`, true).catch(() => false),
      toggleAdBlock: () => ({ enabled: false, error: "Ad blocking is handled by the native browser mode." }),
      getAdBlockState: () => ({ enabled: false })
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
            allowpopups="false"
            webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=no"
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

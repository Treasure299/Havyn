import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Compass, ExternalLink, Film, FolderPlus, Plus, Puzzle, Radar, RefreshCw, RotateCw, Shield, X } from "lucide-react";

function normalizeUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export default function IntegratedBrowserPanel({ browser, currentUrl, onLoadUrl, activeMediaTitle, onWebMediaDetected, onWebMediaEvent, webPlaybackState, className = "" }) {
  const frameRef = useRef(null);
  const iframeRef = useRef(null);
  const [url, setUrl] = useState("https://interactive-examples.mdn.mozilla.net/pages/tabbed/video.html");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewBlocked, setPreviewBlocked] = useState(false);
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [notice, setNotice] = useState("");
  const [adBlockEnabled, setAdBlockEnabled] = useState(false);
  const [adBlockBypassed, setAdBlockBypassed] = useState(false);

  const updateBrowserBounds = useCallback(() => {
    if (!browser || !frameRef.current) return;
    const rect = frameRef.current.getBoundingClientRect();
    browser.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }, [browser]);

  useLayoutEffect(() => {
    if (!browser || !frameRef.current) return undefined;
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
    if (!browser) return undefined;
    const timers = [0, 80, 220, 520].map((delay) => window.setTimeout(updateBrowserBounds, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [browser, updateBrowserBounds]);

  useEffect(() => {
    if (currentUrl) setUrl(currentUrl);
  }, [currentUrl]);

  useEffect(() => {
    if (!browser?.onTabs) return undefined;
    return browser.onTabs(({ tabs: nextTabs, activeTabId: nextActiveTabId }) => {
      setTabs(nextTabs || []);
      setActiveTabId(nextActiveTabId || "");
      const active = nextTabs?.find((tab) => tab.id === nextActiveTabId);
      if (active?.url) setUrl(active.url);
    });
  }, [browser]);

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

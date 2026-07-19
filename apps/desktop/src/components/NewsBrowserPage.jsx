import { ArrowLeft, ArrowRight, RefreshCw, ShieldCheck, ShieldOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export default function NewsBrowserPage({ article, onClose }) {
  const webviewRef = useRef(null);
  const webContentsIdRef = useRef(0);
  const [partition, setPartition] = useState("");
  const [currentUrl, setCurrentUrl] = useState(article?.url || "");
  const [loading, setLoading] = useState(true);
  const [adBlockDisabled, setAdBlockDisabled] = useState(false);
  const desktopBrowser = Boolean(window.havyn?.browser?.getPartition);

  useEffect(() => {
    window.havyn?.browser?.getPartition?.().then(setPartition).catch(() => {});
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return undefined;
    const finish = () => {
      setCurrentUrl(webview.getURL?.() || article?.url || "");
      setLoading(false);
    };
    const start = () => setLoading(true);
    const ready = () => {
      const webContentsId = Number(webview.getWebContentsId?.() || 0);
      webContentsIdRef.current = webContentsId;
      if (webContentsId) {
        window.havyn?.browser?.setWebviewAdBlockBypass?.(webContentsId, adBlockDisabled).catch(() => {});
      }
    };
    const navigate = (event) => setCurrentUrl(webview.getURL?.() || event.url || "");
    const keepPopupInside = (event) => {
      event.preventDefault?.();
      if (event.url) webview.loadURL?.(event.url);
    };
    webview.addEventListener("did-start-loading", start);
    webview.addEventListener("dom-ready", ready);
    webview.addEventListener("did-stop-loading", finish);
    webview.addEventListener("did-navigate", navigate);
    webview.addEventListener("did-navigate-in-page", navigate);
    webview.addEventListener("new-window", keepPopupInside);
    return () => {
      webview.removeEventListener("did-start-loading", start);
      webview.removeEventListener("dom-ready", ready);
      webview.removeEventListener("did-stop-loading", finish);
      webview.removeEventListener("did-navigate", navigate);
      webview.removeEventListener("did-navigate-in-page", navigate);
      webview.removeEventListener("new-window", keepPopupInside);
    };
  }, [article?.url, partition, adBlockDisabled]);

  useEffect(() => () => {
    if (webContentsIdRef.current) {
      window.havyn?.browser?.setWebviewAdBlockBypass?.(webContentsIdRef.current, false).catch(() => {});
    }
  }, []);

  async function toggleArticleAdBlock() {
    const webview = webviewRef.current;
    const webContentsId = Number(webview?.getWebContentsId?.() || webContentsIdRef.current || 0);
    if (!webContentsId) return;
    const nextDisabled = !adBlockDisabled;
    const bypassed = await window.havyn?.browser?.setWebviewAdBlockBypass?.(webContentsId, nextDisabled);
    setAdBlockDisabled(Boolean(bypassed));
    webview?.reload?.();
  }

  return (
    <section className="content-page news-browser-page">
      <div className="news-browser-toolbar glass">
        <button className="icon-button" type="button" title="Back" onClick={() => webviewRef.current?.canGoBack?.() && webviewRef.current.goBack()}><ArrowLeft size={17} /></button>
        <button className="icon-button" type="button" title="Forward" onClick={() => webviewRef.current?.canGoForward?.() && webviewRef.current.goForward()}><ArrowRight size={17} /></button>
        <button className="icon-button" type="button" title="Reload" onClick={() => webviewRef.current?.reload?.()}><RefreshCw size={17} /></button>
        <div className="news-browser-address">
          <strong>{article?.source || "Havyn News"}</strong>
          <span>{currentUrl}</span>
        </div>
        {desktopBrowser && (
          <button
            className={`article-adblock-toggle ${adBlockDisabled ? "is-off" : ""}`}
            type="button"
            title={adBlockDisabled ? "Turn on ad blocker for this article" : "Turn off ad blocker for this article"}
            onClick={toggleArticleAdBlock}
          >
            {adBlockDisabled ? <ShieldOff size={16} /> : <ShieldCheck size={16} />}
            <span>{adBlockDisabled ? "Ad blocker off" : "Ads blocked"}</span>
          </button>
        )}
        <button className="icon-button" type="button" title="Close article" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="news-browser-frame glass">
        {desktopBrowser && partition ? (
          <webview
            ref={webviewRef}
            className="news-browser-webview"
            src={article?.url || "about:blank"}
            partition={partition}
            webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
          />
        ) : (
          <div className="news-browser-preview">
            <span className="section-eyebrow">IN-APP READER</span>
            <h2>{article?.title}</h2>
            <p>{article?.summary || "This article will open here in the Havyn desktop app."}</p>
            <small>Publisher pages stay inside Havyn in the packaged desktop app.</small>
          </div>
        )}
        {loading && desktopBrowser && <div className="news-browser-loading">Loading article…</div>}
      </div>
    </section>
  );
}

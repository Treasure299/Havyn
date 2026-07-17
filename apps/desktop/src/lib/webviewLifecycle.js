export function getAttachedWebContentsId(webview) {
  if (!webview?.isConnected) return null;
  try {
    return webview.getWebContentsId?.() || null;
  } catch {
    // Electron throws until the webview is attached and has emitted dom-ready.
    return null;
  }
}

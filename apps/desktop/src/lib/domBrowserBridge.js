const listeners = new Map();
let handlers = {};

function emit(event, payload) {
  listeners.get(event)?.forEach((handler) => handler(payload));
}

function on(event, handler) {
  const current = listeners.get(event) || new Set();
  current.add(handler);
  listeners.set(event, current);
  return () => current.delete(handler);
}

export function registerDomBrowser(nextHandlers) {
  handlers = nextHandlers || {};
  return () => {
    handlers = {};
  };
}

export const domBrowserBridge = {
  isDomWebview: true,
  create: () => true,
  destroy: () => true,
  setBounds: () => true,
  setVisible: () => true,
  focus: () => handlers.focus?.(),
  loadUrl: (url) => handlers.loadUrl?.(url),
  reload: () => handlers.reload?.(),
  back: () => handlers.back?.(),
  forward: () => handlers.forward?.(),
  newTab: (url) => handlers.newTab?.(url),
  switchTab: (tabId) => handlers.switchTab?.(tabId),
  closeTab: (tabId) => handlers.closeTab?.(tabId),
  scanMedia: () => handlers.scanMedia?.(),
  applyPlayback: (state) => handlers.applyPlayback?.(state),
  openWebStore: () => handlers.newTab?.("https://chromewebstore.google.com/category/extensions"),
  loadUnpackedExtension: () => ({ ok: false, canceled: true }),
  toggleAdBlock: () => handlers.toggleAdBlock?.(),
  getAdBlockState: () => handlers.getAdBlockState?.(),
  onTabs: (callback) => on("tabs", callback),
  onMediaDetected: (callback) => on("media-detected", callback),
  onMediaEvent: (callback) => on("media-event", callback),
  onNavigation: (callback) => on("navigation", callback),
  onLoadState: (callback) => on("load-state", callback),
  onAdBlockState: (callback) => on("adblock-state", callback)
};

export const domBrowserEvents = {
  tabs: (payload) => emit("tabs", payload),
  mediaDetected: (payload) => emit("media-detected", payload),
  mediaEvent: (payload) => emit("media-event", payload),
  navigation: (payload) => emit("navigation", payload),
  loadState: (payload) => emit("load-state", payload),
  adBlockState: (payload) => emit("adblock-state", payload)
};

import { clipboard, contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("havyn", {
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text)
  },
  browser: {
    create: (bounds) => ipcRenderer.invoke("browser:create", bounds),
    destroy: () => ipcRenderer.invoke("browser:destroy"),
    setBounds: (bounds) => ipcRenderer.invoke("browser:set-bounds", bounds),
    setVisible: (visible) => ipcRenderer.invoke("browser:set-visible", visible),
    newTab: (url) => ipcRenderer.invoke("browser:new-tab", url),
    switchTab: (tabId) => ipcRenderer.invoke("browser:switch-tab", tabId),
    closeTab: (tabId) => ipcRenderer.invoke("browser:close-tab", tabId),
    loadUrl: (url) => ipcRenderer.invoke("browser:load-url", url),
    back: () => ipcRenderer.invoke("browser:back"),
    forward: () => ipcRenderer.invoke("browser:forward"),
    reload: () => ipcRenderer.invoke("browser:reload"),
    focus: () => ipcRenderer.invoke("browser:focus"),
    openWebStore: () => ipcRenderer.invoke("browser:open-web-store"),
    loadUnpackedExtension: () => ipcRenderer.invoke("browser:load-unpacked-extension"),
    toggleAdBlock: () => ipcRenderer.invoke("browser:toggle-adblock"),
    getAdBlockState: () => ipcRenderer.invoke("browser:get-adblock-state"),
    getPreloadUrl: () => ipcRenderer.invoke("app:get-browser-preload-url"),
    getPartition: () => ipcRenderer.invoke("app:get-browser-partition"),
    registerWebview: (webContentsId) => ipcRenderer.invoke("browser:register-webview", webContentsId),
    scanWebviewMedia: (webContentsId) => ipcRenderer.invoke("browser:scan-webview-media", webContentsId),
    applyWebviewPlayback: (webContentsId, state) => ipcRenderer.invoke("browser:apply-webview-playback", webContentsId, state),
    applyPlayback: (state) => ipcRenderer.invoke("browser:apply-playback", state),
    scanMedia: () => ipcRenderer.invoke("browser:scan-media"),
    onTabs: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("browser:tabs", listener);
      return () => ipcRenderer.removeListener("browser:tabs", listener);
    },
    onMediaDetected: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("browser:media-detected", listener);
      return () => ipcRenderer.removeListener("browser:media-detected", listener);
    },
    onMediaEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("browser:media-event", listener);
      return () => ipcRenderer.removeListener("browser:media-event", listener);
    },
    onNavigation: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("browser:navigation", listener);
      return () => ipcRenderer.removeListener("browser:navigation", listener);
    },
    onLoadState: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("browser:load-state", listener);
      return () => ipcRenderer.removeListener("browser:load-state", listener);
    },
    onAdBlockState: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("browser:adblock-state", listener);
      return () => ipcRenderer.removeListener("browser:adblock-state", listener);
    }
  }
});

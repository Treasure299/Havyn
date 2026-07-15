export function createScreenSharePermissionGate(getMainRendererId, now = () => Date.now()) {
  let sources = new Map();
  let pending = null;
  let activeGrant = null;

  return {
    registerSources(senderId, nextSources) {
      if (!senderId || senderId !== getMainRendererId()) return false;
      sources = new Map(nextSources.map((source) => [source.id, source]));
      pending = null;
      activeGrant = null;
      return true;
    },
    select(senderId, sourceId, withAudio, metadata = {}) {
      if (!senderId || senderId !== getMainRendererId()) return false;
      const source = sources.get(sourceId);
      if (!source) return false;
      pending = { source, withAudio: Boolean(withAudio), metadata, expiresAt: now() + 30_000 };
      return true;
    },
    consume(webContentsId) {
      if (webContentsId !== getMainRendererId() || !pending || pending.expiresAt < now()) {
        pending = null;
        return null;
      }
      const selection = pending;
      pending = null;
      // Electron can perform its display-capture permission check after the
      // display-media handler consumes the selected source. Keep a narrow,
      // renderer-bound grant alive just long enough for that internal check.
      activeGrant = { webContentsId, expiresAt: now() + 10_000 };
      return selection;
    },
    canGrant(webContentsId) {
      if (webContentsId !== getMainRendererId()) return false;
      const currentTime = now();
      if (pending?.expiresAt >= currentTime) return true;
      if (activeGrant?.webContentsId === webContentsId && activeGrant.expiresAt >= currentTime) {
        return true;
      }
      return false;
    },
    reset() {
      sources.clear();
      pending = null;
      activeGrant = null;
    }
  };
}

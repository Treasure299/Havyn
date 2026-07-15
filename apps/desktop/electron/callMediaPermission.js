export function createCallMediaPermissionGate(getMainRendererId) {
  let active = false;

  return {
    setActive(senderId, nextActive) {
      if (!senderId || senderId !== getMainRendererId()) return false;
      active = Boolean(nextActive);
      return active;
    },
    canGrant(webContentsId, permission) {
      return permission === "media" && active && webContentsId === getMainRendererId();
    },
    reset() {
      active = false;
    }
  };
}

export function startPlaybackMaintenance({ runtimeWindow, socket, roomId, userId, getCurrentTime }) {
  const requestSync = () => {
    socket.emit("playback-sync-request", { roomId, userId });
  };
  const driftTimer = runtimeWindow.setInterval(() => {
    const currentTime = getCurrentTime();
    if (typeof currentTime !== "number") return;
    socket.emit("playback-drift-correction", { roomId, userId, currentTime });
  }, 4000);
  socket.io.on("reconnect", requestSync);
  runtimeWindow.addEventListener("focus", requestSync);

  return () => {
    runtimeWindow.clearInterval(driftTimer);
    socket.io.off("reconnect", requestSync);
    runtimeWindow.removeEventListener("focus", requestSync);
  };
}

export function createSingleFlightRunner(task) {
  let active = false;
  return async (...args) => {
    if (active) return false;
    active = true;
    try {
      return await task(...args);
    } finally {
      active = false;
    }
  };
}

export function shouldRecoverLocalPlayback({ state, userId, action, failure, now = Date.now() }) {
  return Boolean(
    state?.controllerUserId === userId &&
    failure?.action === action &&
    now - failure.at < 5000
  );
}

export async function persistPlaybackSnapshot({ client, roomId, userId, state, onError }) {
  try {
    const result = await client
      .from("rooms")
      .update({
        active_media_url: state.activeMediaUrl || null,
        active_media_title: state.activeMediaTitle || null,
        active_media_state: {
          isPlaying: Boolean(state.isPlaying),
          currentTime: Number(state.currentTime || 0),
          updatedAt: Number(state.updatedAt || Date.now()),
          playbackRate: Number(state.playbackRate || 1),
          activeMediaUrl: state.activeMediaUrl || "",
          activeMediaPageUrl: state.activeMediaPageUrl || state.activeMediaUrl || "",
          activeMediaFrameUrl: state.activeMediaFrameUrl || "",
          activeMediaTitle: state.activeMediaTitle || "",
          controllerUserId: state.controllerUserId || userId
        },
        updated_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      })
      .eq("id", roomId);
    if (result?.error) throw result.error;
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

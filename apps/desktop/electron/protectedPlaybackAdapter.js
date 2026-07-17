export function protectedPlaybackService(value = "") {
  let hostname = "";
  try {
    hostname = new URL(value, "https://havyn.invalid").hostname.toLowerCase();
  } catch {
    return "";
  }

  const matches = (domain) => hostname === domain || hostname.endsWith(`.${domain}`);
  if (matches("netflix.com")) return "netflix";
  if (
    matches("primevideo.com") ||
    matches("amazon.com") ||
    matches("disneyplus.com") ||
    matches("hulu.com") ||
    matches("max.com") ||
    matches("hbomax.com") ||
    matches("paramountplus.com") ||
    matches("peacocktv.com") ||
    matches("tv.apple.com")
  ) {
    return "protected-html5";
  }
  return "";
}

export function readNetflixPlaybackState(windowLike, video = null, now = Date.now()) {
  try {
    const videoPlayerApi = windowLike?.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const sessionIds = videoPlayerApi?.getAllPlayerSessionIds?.() || [];
    const sessionId = sessionIds.find((id) => String(id).startsWith("watch-")) || sessionIds[0];
    const player = sessionId ? videoPlayerApi?.getVideoPlayerBySessionId?.(sessionId) : null;
    if (!player) return null;
    const currentTimeMs = Number(player.getCurrentTime?.());
    return {
      currentTime: Number.isFinite(currentTimeMs) ? currentTimeMs / 1000 : Number(video?.currentTime || 0),
      paused: typeof player.isPaused === "function" ? Boolean(player.isPaused()) : Boolean(video?.paused),
      playbackRate: 1,
      observedAt: now
    };
  } catch {
    return null;
  }
}

export function classifyProtectedPlaybackTransition(previous, next) {
  if (!previous || !next) return null;
  if (Boolean(previous.paused) !== Boolean(next.paused)) {
    return { eventName: next.paused ? "pause" : "play" };
  }

  const previousTime = Number(previous.currentTime);
  const nextTime = Number(next.currentTime);
  if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime)) return null;
  const elapsed = Math.max(0, Math.min(5, (Number(next.observedAt) - Number(previous.observedAt)) / 1000));
  const rate = Number.isFinite(Number(previous.playbackRate)) ? Number(previous.playbackRate) : 1;
  const expectedTime = previousTime + (previous.paused ? 0 : elapsed * rate);
  const seekThreshold = Math.max(2.25, elapsed * 2 + 0.75);
  if (Math.abs(nextTime - expectedTime) >= seekThreshold) {
    return { eventName: "seeked" };
  }
  return null;
}

export async function applyNetflixPlayback(windowLike, command = {}, video = null) {
  try {
    const videoPlayerApi = windowLike?.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const sessionIds = videoPlayerApi?.getAllPlayerSessionIds?.() || [];
    const sessionId = sessionIds.find((id) => String(id).startsWith("watch-")) || sessionIds[0];
    const player = sessionId ? videoPlayerApi?.getVideoPlayerBySessionId?.(sessionId) : null;
    if (!player) return { applied: false, reason: "netflix-player-unavailable" };

    const action = String(command.action || "sync");
    const reason = String(command.reason || "");
    const currentTime = Number(command.currentTime);
    const playerTimeMs = Number(player.getCurrentTime?.());
    const fallbackTime = Number(video?.currentTime || 0);
    const playerTimeSeconds = Number.isFinite(playerTimeMs) ? playerTimeMs / 1000 : fallbackTime;
    const skipInitialSeek = reason === "source-selected" || reason === "media-selected";
    const isAutomaticCorrection = reason === "drift-correction" || reason === "sync";
    const correctionThreshold = isAutomaticCorrection ? 4 : 1.5;
    const shouldSeek =
      Number.isFinite(currentTime) &&
      !skipInitialSeek &&
      (action === "seek" || Math.abs(playerTimeSeconds - currentTime) > correctionThreshold);

    if (shouldSeek && typeof player.seek === "function") {
      await Promise.resolve(player.seek(Math.max(0, currentTime) * 1000));
    }
    // Selecting a protected source establishes room state; it must not poke an
    // already-initializing DRM session. First Sync Play performs the first
    // authoritative playback action once every participant is ready.
    const skipInitialTransport = reason === "source-selected" || reason === "media-selected";
    if (!skipInitialTransport && action === "play" && typeof player.play === "function") {
      await Promise.resolve(player.play());
    } else if (!skipInitialTransport && action === "pause" && typeof player.pause === "function") {
      await Promise.resolve(player.pause());
    }

    const updatedTimeMs = Number(player.getCurrentTime?.());
    return {
      applied: true,
      currentTime: Number.isFinite(updatedTimeMs) ? updatedTimeMs / 1000 : Number(video?.currentTime || currentTime || 0),
      paused: typeof player.isPaused === "function" ? Boolean(player.isPaused()) : Boolean(video?.paused),
      playbackRate: 1,
      sought: shouldSeek
    };
  } catch (error) {
    return {
      applied: false,
      reason: "netflix-player-command-failed",
      message: String(error?.message || error || "unknown error")
    };
  }
}

export async function applyProtectedHtml5Playback(command = {}, video = null) {
  if (!video) return { applied: false, reason: "protected-video-unavailable" };
  const action = String(command.action || "sync");
  try {
    // Protected services own their timeline and playback-rate state. Directly
    // writing those HTMLMediaElement properties can invalidate a DRM session.
    if (action === "play" && video.paused) await video.play();
    if (action === "pause" && !video.paused) video.pause();
    if (action === "seek" || action === "rate-change") {
      return { applied: false, reason: "protected-timeline-command-unsupported" };
    }
    return {
      applied: true,
      currentTime: Number(video.currentTime || 0),
      paused: Boolean(video.paused),
      playbackRate: Number(video.playbackRate || 1),
      sought: false
    };
  } catch (error) {
    return {
      applied: false,
      reason: "protected-player-command-failed",
      message: String(error?.message || error || "unknown error")
    };
  }
}

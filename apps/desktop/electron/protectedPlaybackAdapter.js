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
    const shouldSeek =
      Number.isFinite(currentTime) &&
      !skipInitialSeek &&
      (action === "seek" || Math.abs(playerTimeSeconds - currentTime) > 1.5);

    if (shouldSeek && typeof player.seek === "function") {
      await Promise.resolve(player.seek(Math.max(0, currentTime) * 1000));
    }
    if (action === "play" && typeof player.play === "function") {
      await Promise.resolve(player.play());
    } else if (action === "pause" && typeof player.pause === "function") {
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

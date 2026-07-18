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

export function selectNetflixPlaybackSession(videoPlayerApi, video = null, preferredSessionId = "") {
  const sessionIds = videoPlayerApi?.getAllPlayerSessionIds?.() || [];
  const candidates = sessionIds.map((sessionId) => {
    const player = videoPlayerApi?.getVideoPlayerBySessionId?.(sessionId);
    const currentTimeMs = Number(player?.getCurrentTime?.());
    return {
      sessionId: String(sessionId),
      player,
      currentTime: Number.isFinite(currentTimeMs) ? currentTimeMs / 1000 : null
    };
  }).filter((candidate) => candidate.player);
  if (!candidates.length) return null;

  const preferred = candidates.find((candidate) => candidate.sessionId === String(preferredSessionId || ""));
  if (preferred) return preferred;

  const watchCandidates = candidates.filter((candidate) => candidate.sessionId.startsWith("watch-"));
  const eligible = watchCandidates.length ? watchCandidates : candidates;
  const videoTime = Number(video?.currentTime);
  if (Number.isFinite(videoTime)) {
    return eligible.reduce((best, candidate) => {
      if (!Number.isFinite(candidate.currentTime)) return best;
      if (!best || !Number.isFinite(best.currentTime)) return candidate;
      return Math.abs(candidate.currentTime - videoTime) < Math.abs(best.currentTime - videoTime)
        ? candidate
        : best;
    }, null) || eligible[0];
  }
  return eligible[0];
}

export function readNetflixPlaybackState(
  windowLike,
  video = null,
  now = Date.now(),
  preferredSessionId = ""
) {
  try {
    const videoPlayerApi = windowLike?.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const selection = selectNetflixPlaybackSession(videoPlayerApi, video, preferredSessionId);
    if (!selection) return null;
    return {
      currentTime: Number.isFinite(selection.currentTime) ? selection.currentTime : Number(video?.currentTime || 0),
      paused: typeof selection.player.isPaused === "function"
        ? Boolean(selection.player.isPaused())
        : Boolean(video?.paused),
      playbackRate: 1,
      observedAt: now,
      sessionId: selection.sessionId
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

export function isProtectedPlaybackDiscontinuity(previous, next, thresholdSeconds = 30) {
  const previousTime = Number(previous?.currentTime);
  const nextTime = Number(next?.currentTime);
  return Number.isFinite(previousTime) &&
    Number.isFinite(nextTime) &&
    Math.abs(nextTime - previousTime) > thresholdSeconds;
}

export function shouldDeduplicateProtectedTransition(
  transition,
  lastNativeEvent,
  now = Date.now(),
  windowMs = 750
) {
  if (!transition || !lastNativeEvent) return false;
  const equivalent = transition.eventName === "seeked"
    ? ["seeking", "seeked"].includes(lastNativeEvent.eventName)
    : lastNativeEvent.eventName === transition.eventName;
  return equivalent && now - Number(lastNativeEvent.at || 0) <= windowMs;
}

export function selectProtectedPlaybackVideo(videos = [], preferredVideo = null) {
  const candidates = Array.from(videos || []).filter((video) => video && Number(video.readyState || 0) > 0);
  if (!candidates.length) return null;
  if (preferredVideo && candidates.includes(preferredVideo) && preferredVideo.isConnected !== false) {
    return preferredVideo;
  }
  return candidates.sort((left, right) => {
    const leftArea = Number(left.videoWidth || left.clientWidth || 0) * Number(left.videoHeight || left.clientHeight || 0);
    const rightArea = Number(right.videoWidth || right.clientWidth || 0) * Number(right.videoHeight || right.clientHeight || 0);
    return rightArea - leftArea;
  })[0];
}

export async function applyNetflixPlayback(
  windowLike,
  command = {},
  video = null,
  preferredSessionId = ""
) {
  try {
    const videoPlayerApi = windowLike?.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const selection = selectNetflixPlaybackSession(videoPlayerApi, video, preferredSessionId);
    if (!selection) return { applied: false, reason: "netflix-player-unavailable" };
    const { player, sessionId } = selection;

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
      sought: shouldSeek,
      sessionId
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
  const reason = String(command.reason || "");
  try {
    const currentTime = Number(command.currentTime);
    const playbackRate = Number(command.playbackRate);
    const skipInitialMutation = reason === "source-selected" || reason === "media-selected";
    const isAutomaticCorrection = reason === "drift-correction" || reason === "sync";
    const correctionThreshold = isAutomaticCorrection ? 4 : 1.5;
    const shouldSeek =
      Number.isFinite(currentTime) &&
      !skipInitialMutation &&
      (action === "seek" || reason === "seek" || Math.abs(Number(video.currentTime || 0) - currentTime) > correctionThreshold);

    if (skipInitialMutation) {
      return {
        applied: true,
        currentTime: Number(video.currentTime || 0),
        paused: Boolean(video.paused),
        playbackRate: Number(video.playbackRate || 1),
        sought: false
      };
    }
    if (shouldSeek) video.currentTime = Math.max(0, currentTime);
    if ((action === "rate-change" || reason === "rate-change") && Number.isFinite(playbackRate) && playbackRate > 0) {
      video.playbackRate = playbackRate;
    }
    if (action === "play" && video.paused) await video.play();
    if (action === "pause" && !video.paused) video.pause();
    return {
      applied: true,
      currentTime: Number(video.currentTime || 0),
      paused: Boolean(video.paused),
      playbackRate: Number(video.playbackRate || 1),
      sought: shouldSeek
    };
  } catch (error) {
    return {
      applied: false,
      reason: "protected-player-command-failed",
      message: String(error?.message || error || "unknown error")
    };
  }
}

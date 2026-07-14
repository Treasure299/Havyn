export function createRemotePlaybackExpectation(command = {}, now = Date.now(), ttlMs = 1400) {
  return {
    action: String(command.action || "sync"),
    currentTime: Number.isFinite(Number(command.currentTime)) ? Number(command.currentTime) : null,
    playbackRate: Number.isFinite(Number(command.playbackRate)) ? Number(command.playbackRate) : null,
    expiresAt: now + ttlMs
  };
}

export function matchesRemotePlaybackEvent(expectation, eventName, media = {}, now = Date.now()) {
  if (!expectation || now > Number(expectation.expiresAt || 0)) return false;

  if (eventName === "play" || eventName === "playing") {
    return expectation.action === "play";
  }
  if (eventName === "pause") {
    return expectation.action === "pause" || expectation.action === "ended";
  }
  if (eventName === "ended") {
    return expectation.action === "ended";
  }
  if (eventName === "seeking" || eventName === "seeked") {
    return expectation.currentTime !== null &&
      Math.abs(Number(media.currentTime || 0) - expectation.currentTime) <= 1.75;
  }
  if (eventName === "ratechange") {
    return expectation.playbackRate !== null &&
      Math.abs(Number(media.playbackRate || 1) - expectation.playbackRate) <= 0.01;
  }
  return false;
}

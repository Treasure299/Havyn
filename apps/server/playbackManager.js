import { PLAYBACK_MODES, ROOM_ROLES, getParticipant, getRoom } from "./roomManager.js";

export function canControlPlayback(roomId, userId) {
  const room = getRoom(roomId);
  const participant = getParticipant(roomId, userId);
  if (!room || !participant) return false;
  if (room.playbackMode === PLAYBACK_MODES.EVERYONE) return true;
  if (room.playbackMode === PLAYBACK_MODES.HOST_AND_COHOSTS) {
    return [ROOM_ROLES.HOST, ROOM_ROLES.COHOST].includes(participant.role);
  }
  return participant.role === ROOM_ROLES.HOST;
}

export function projectedCurrentTime(state, at = Date.now()) {
  if (!state.isPlaying) return state.currentTime;
  return state.currentTime + ((at - state.updatedAt) / 1000) * state.playbackRate;
}

export function selectMedia(roomId, userId, media) {
  const room = getRoom(roomId);
  if (!room || !canControlPlayback(roomId, userId)) return null;

  room.playbackState = {
    ...room.playbackState,
    isPlaying: media.paused === false,
    currentTime: Number(media.currentTime || 0),
    updatedAt: Date.now(),
    playbackRate: Number(media.playbackRate || 1),
    activeMediaUrl: media.url,
    activeMediaPageUrl: media.pageUrl || media.url,
    activeMediaFrameUrl: media.frameUrl || media.url,
    activeMediaTitle: media.title || "Detected media",
    controllerUserId: userId
  };

  return room.playbackState;
}

export function updatePlayback(roomId, userId, action, payload = {}) {
  const room = getRoom(roomId);
  if (!room || !canControlPlayback(roomId, userId)) return null;

  const now = Date.now();
  const current = projectedCurrentTime(room.playbackState, now);
  const next = {
    ...room.playbackState,
    currentTime: payload.currentTime ?? current,
    updatedAt: now,
    playbackRate: payload.playbackRate ?? room.playbackState.playbackRate,
    controllerUserId: userId
  };

  if (action === "play") next.isPlaying = true;
  if (action === "pause") next.isPlaying = false;
  if (action === "seek") next.currentTime = Number(payload.currentTime || 0);
  if (action === "rate-change") next.playbackRate = Number(payload.playbackRate || 1);
  if (action === "ended") {
    next.isPlaying = false;
    next.currentTime = payload.currentTime ?? current;
  }

  room.playbackState = next;
  return next;
}

export function getAuthoritativePlayback(roomId) {
  const room = getRoom(roomId);
  if (!room) return null;
  return {
    ...room.playbackState,
    currentTime: projectedCurrentTime(room.playbackState)
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function usePlaybackSync({ socket, room, user, applyPlayback, localCurrentTime, onPlaybackState }) {
  const [playbackState, setPlaybackState] = useState(null);
  const localCurrentTimeRef = useRef(localCurrentTime);
  const role = room?.participants?.find((participant) => participant.userId === user.id)?.role || "viewer";

  useEffect(() => {
    localCurrentTimeRef.current = localCurrentTime;
  }, [localCurrentTime]);

  const canControl = useMemo(() => {
    if (!room) return false;
    if (room.playbackMode === "everyone") return true;
    if (room.playbackMode === "host-and-cohosts") return ["host", "cohost"].includes(role);
    return role === "host";
  }, [room, role]);

  const applyRemoteState = useCallback((state, action = "sync") => {
    if (!state) return;
    setPlaybackState(state);
    onPlaybackState?.(state);
    if (state.controllerUserId === user.id && !state.correctedUserId) return;
    applyPlayback?.({
      action: state.isPlaying ? "play" : "pause",
      currentTime: state.currentTime,
      playbackRate: state.playbackRate,
      reason: action
    });
  }, [applyPlayback, onPlaybackState, user.id]);

  useEffect(() => {
    const sync = (state) => applyRemoteState(state, "sync");
    const play = (state) => applyRemoteState(state, "play");
    const pause = (state) => applyRemoteState(state, "pause");
    const seek = (state) => applyRemoteState(state, "seek");
    const rate = (state) => applyRemoteState(state, "rate-change");
    const ended = (state) => applyRemoteState(state, "ended");

    socket.on("playback-state-sync", sync);
    socket.on("playback-play", play);
    socket.on("playback-pause", pause);
    socket.on("playback-seek", seek);
    socket.on("playback-rate-change", rate);
    socket.on("media-ended", ended);
    return () => {
      socket.off("playback-state-sync", sync);
      socket.off("playback-play", play);
      socket.off("playback-pause", pause);
      socket.off("playback-seek", seek);
      socket.off("playback-rate-change", rate);
      socket.off("media-ended", ended);
    };
  }, [socket, applyRemoteState]);

  useEffect(() => {
    if (!room?.roomId || !playbackState) return undefined;
    const timer = window.setInterval(() => {
      if (typeof localCurrentTimeRef.current !== "number") return;
      // MVP drift correction is intentionally simple. Production can smooth playback
      // rate before seeking and should account for buffering, latency, and TURN paths.
      socket.emit("playback-drift-correction", {
        roomId: room.roomId,
        userId: user.id,
        currentTime: localCurrentTimeRef.current
      });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [socket, room?.roomId, user.id, playbackState]);

  function selectMedia(media) {
    socket.emit("media-selected", {
      roomId: room.roomId,
      userId: user.id,
      media: { ...media, url: media.url }
    });
  }

  function sendPlayback(action, data = {}) {
    const eventName = {
      play: "playback-play",
      pause: "playback-pause",
      seek: "playback-seek",
      rate: "playback-rate-change",
      ended: "media-ended"
    }[action];
    socket.emit(eventName, { roomId: room.roomId, userId: user.id, ...data });
  }

  async function controlPlayback(action) {
    const currentTime = localCurrentTimeRef.current ?? playbackState?.currentTime ?? 0;
    const applied = await applyPlayback?.({
      action,
      currentTime,
      playbackRate: playbackState?.playbackRate ?? room?.playbackState?.playbackRate ?? 1,
      reason: "local-control"
    });
    if (applied === false) return;
    sendPlayback(action, { currentTime });
  }

  return {
    playbackState: playbackState || room?.playbackState,
    canControl,
    selectMedia,
    play: () => controlPlayback("play"),
    pause: () => controlPlayback("pause"),
    seek: (currentTime) => sendPlayback("seek", { currentTime }),
    rateChange: (playbackRate) => sendPlayback("rate", { playbackRate }),
    mediaEnded: (currentTime) => sendPlayback("ended", { currentTime })
  };
}

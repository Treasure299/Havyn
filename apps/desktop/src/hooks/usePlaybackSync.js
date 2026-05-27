import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export function usePlaybackSync({ socket, room, user, applyPlayback, localCurrentTime, onPlaybackState }) {
  const [playbackState, setPlaybackState] = useState(null);
  const localCurrentTimeRef = useRef(localCurrentTime);
  const playbackStateRef = useRef(null);
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

  useEffect(() => {
    playbackStateRef.current = playbackState || room?.playbackState || null;
  }, [playbackState, room?.playbackState]);

  function projectedPlaybackState(state) {
    if (!state) return state;
    if (!state.isPlaying) return { ...state, updatedAt: Date.now() };
    return {
      ...state,
      currentTime: Number(state.currentTime || 0) + ((Date.now() - Number(state.updatedAt || Date.now())) / 1000) * Number(state.playbackRate || 1),
      updatedAt: Date.now()
    };
  }

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
    const requestSync = () => {
      socket.emit("playback-sync-request", { roomId: room.roomId, userId: user.id });
    };
    const driftTimer = window.setInterval(() => {
      if (typeof localCurrentTimeRef.current !== "number") return;
      // MVP drift correction is intentionally simple. Production can smooth playback
      // rate before seeking and should account for buffering, latency, and TURN paths.
      socket.emit("playback-drift-correction", {
        roomId: room.roomId,
        userId: user.id,
        currentTime: localCurrentTimeRef.current
      });
    }, 4000);
    const syncTimer = window.setInterval(requestSync, 30000);
    socket.io.on("reconnect", requestSync);
    window.addEventListener("focus", requestSync);
    return () => {
      window.clearInterval(driftTimer);
      window.clearInterval(syncTimer);
      socket.io.off("reconnect", requestSync);
      window.removeEventListener("focus", requestSync);
    };
  }, [socket, room?.roomId, user.id, playbackState]);

  useEffect(() => {
    if (!supabase || !room?.roomId || room.hostUserId !== user.id) return undefined;
    const persistPlayback = () => {
      const state = projectedPlaybackState(playbackStateRef.current);
      if (!state?.activeMediaUrl) return;
      supabase
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
            activeMediaTitle: state.activeMediaTitle || "",
            controllerUserId: state.controllerUserId || user.id
          },
          updated_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString()
        })
        .eq("id", room.roomId);
    };
    persistPlayback();
    const timer = window.setInterval(persistPlayback, 5_000);
    return () => window.clearInterval(timer);
  }, [room?.hostUserId, room?.roomId, user.id]);

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

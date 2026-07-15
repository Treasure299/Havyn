import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { logPlaybackDiagnostic } from "../lib/playbackDiagnostics";
import {
  createSingleFlightRunner,
  persistPlaybackSnapshot,
  shouldRecoverLocalPlayback,
  startPlaybackMaintenance
} from "../lib/playbackMaintenance";

export function usePlaybackSync({ socket, room, user, applyPlayback, localCurrentTime, onPlaybackState, suspended = false }) {
  const [playbackState, setPlaybackState] = useState(null);
  const localCurrentTimeRef = useRef(localCurrentTime);
  const playbackStateRef = useRef(null);
  const localApplyFailureRef = useRef(null);
  const role = room?.participants?.find((participant) => participant.userId === user.id)?.role ||
    (room?.hostUserId === user.id ? "host" : "viewer");

  useEffect(() => {
    localCurrentTimeRef.current = localCurrentTime;
  }, [localCurrentTime]);

  const canControl = useMemo(() => {
    if (!room || suspended) return false;
    if (room.playbackMode === "everyone") return true;
    if (room.hostUserId === user.id) return true;
    if (room.playbackMode === "host-and-cohosts") return ["host", "cohost"].includes(role);
    return role === "host";
  }, [room, role, suspended, user.id]);

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
    const incomingUpdatedAt = Number(state.updatedAt || 0);
    const currentUpdatedAt = Number(playbackStateRef.current?.updatedAt || 0);
    const isCorrectionForMe = state.correctedUserId === user.id;
    const isExplicitPlaybackAction = ["play", "pause", "seek", "rate-change", "ended"].includes(action);

    logPlaybackDiagnostic("room-playback-received", {
      roomId: room?.roomId,
      action,
      mode: room?.playbackMode,
      role,
      controllerIsLocal: state.controllerUserId === user.id,
      correctedForLocal: isCorrectionForMe,
      state: {
        isPlaying: Boolean(state.isPlaying),
        currentTime: Number(state.currentTime || 0),
        playbackRate: Number(state.playbackRate || 1),
        updatedAt: incomingUpdatedAt
      }
    });

    if (
      incomingUpdatedAt &&
      currentUpdatedAt &&
      incomingUpdatedAt + 250 < currentUpdatedAt &&
      !isCorrectionForMe &&
      !isExplicitPlaybackAction
    ) {
      logPlaybackDiagnostic("room-playback-ignored-stale", { roomId: room?.roomId, action, incomingUpdatedAt, currentUpdatedAt });
      return;
    }

    const projectedState = projectedPlaybackState(state);
    playbackStateRef.current = projectedState;
    setPlaybackState(projectedState);
    onPlaybackState?.(projectedState);
    const localFailure = localApplyFailureRef.current;
    const shouldRecoverLocalApply = shouldRecoverLocalPlayback({
      state,
      userId: user.id,
      action,
      failure: localFailure
    });
    if (state.controllerUserId === user.id && !state.correctedUserId && !shouldRecoverLocalApply) {
      logPlaybackDiagnostic("room-playback-skipped-own-command", { roomId: room?.roomId, action });
      return;
    }
    if (shouldRecoverLocalApply) localApplyFailureRef.current = null;
    const command = {
      action: projectedState.isPlaying ? "play" : "pause",
      currentTime: projectedState.currentTime,
      playbackRate: projectedState.playbackRate,
      activeMediaFrameUrl: projectedState.activeMediaFrameUrl,
      reason: action
    };
    logPlaybackDiagnostic("room-playback-applying", { roomId: room?.roomId, command });
    applyPlayback?.(command);
  }, [applyPlayback, onPlaybackState, role, room?.playbackMode, room?.roomId, user.id]);

  useEffect(() => {
    if (suspended) return undefined;
    const sync = (state) => applyRemoteState(state, "sync");
    const command = (payload) => applyRemoteState(payload?.state || payload, payload?.action || "sync");
    const play = (state) => applyRemoteState(state, "play");
    const pause = (state) => applyRemoteState(state, "pause");
    const seek = (state) => applyRemoteState(state, "seek");
    const rate = (state) => applyRemoteState(state, "rate-change");
    const ended = (state) => applyRemoteState(state, "ended");

    socket.on("playback-state-sync", sync);
    socket.on("playback-command", command);
    socket.on("playback-play", play);
    socket.on("playback-pause", pause);
    socket.on("playback-seek", seek);
    socket.on("playback-rate-change", rate);
    socket.on("media-ended", ended);
    return () => {
      socket.off("playback-state-sync", sync);
      socket.off("playback-command", command);
      socket.off("playback-play", play);
      socket.off("playback-pause", pause);
      socket.off("playback-seek", seek);
      socket.off("playback-rate-change", rate);
      socket.off("media-ended", ended);
    };
  }, [socket, applyRemoteState, suspended]);

  useEffect(() => {
    if (!room?.roomId || suspended) return undefined;
    // Keep these timers stable while playback state changes. Production drift
    // smoothing can be added later without tying timer lifetime to media events.
    return startPlaybackMaintenance({
      runtimeWindow: window,
      socket,
      roomId: room.roomId,
      userId: user.id,
      getCurrentTime: () => localCurrentTimeRef.current
    });
  }, [socket, room?.roomId, suspended, user.id]);

  useEffect(() => {
    if (!supabase || !room?.roomId || room.hostUserId !== user.id || suspended) return undefined;
    let disposed = false;
    const persistPlayback = createSingleFlightRunner(async () => {
      if (disposed) return false;
      const state = projectedPlaybackState(playbackStateRef.current);
      if (!state?.activeMediaUrl) return false;
      return persistPlaybackSnapshot({
        client: supabase,
        roomId: room.roomId,
        userId: user.id,
        state,
        onError: (error) => logPlaybackDiagnostic("room-playback-persist-failed", {
          roomId: room.roomId,
          message: error?.message || String(error)
        })
      });
    });
    void persistPlayback();
    const timer = window.setInterval(() => void persistPlayback(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [room?.hostUserId, room?.roomId, suspended, user.id]);

  function selectMedia(media) {
    if (suspended) return;
    socket.emit("media-selected", {
      roomId: room.roomId,
      userId: user.id,
      media: { ...media, url: media.url }
    });
  }

  function sendPlayback(action, data = {}) {
    if (suspended) return;
    const eventName = {
      play: "playback-play",
      pause: "playback-pause",
      seek: "playback-seek",
      rate: "playback-rate-change",
      ended: "media-ended"
    }[action];
    const payload = { roomId: room.roomId, userId: user.id, ...data };
    logPlaybackDiagnostic("room-playback-sending", {
      roomId: room.roomId,
      action,
      eventName,
      mode: room.playbackMode,
      role,
      data
    });
    socket.emit(eventName, payload);
  }

  function controlPlayback(action) {
    if (suspended) return;
    const currentTime = localCurrentTimeRef.current ?? playbackState?.currentTime ?? 0;
    const command = {
      action,
      currentTime,
      playbackRate: playbackState?.playbackRate ?? room?.playbackState?.playbackRate ?? 1,
      activeMediaFrameUrl: playbackState?.activeMediaFrameUrl || room?.playbackState?.activeMediaFrameUrl,
      reason: "local-control"
    };
    logPlaybackDiagnostic("room-control-requested", { roomId: room?.roomId, action, canControl, mode: room?.playbackMode, role, command });
    let localApply;
    localApplyFailureRef.current = null;
    try {
      localApply = applyPlayback?.(command);
    } catch (error) {
      localApplyFailureRef.current = { action, at: Date.now() };
      logPlaybackDiagnostic("room-control-local-apply-failed", {
        roomId: room?.roomId,
        action,
        message: error?.message || String(error)
      });
    }
    // Do not wait for a provider's video.play() promise. Some embedded players
    // leave it pending even after playback begins, which previously delayed the
    // command sent to everyone else in the room.
    sendPlayback(action, { currentTime });
    Promise.resolve(localApply).catch((error) => {
      localApplyFailureRef.current = { action, at: Date.now() };
      logPlaybackDiagnostic("room-control-local-apply-failed", {
        roomId: room?.roomId,
        action,
        message: error?.message || String(error)
      });
      const state = playbackStateRef.current;
      const actionMatchesState = action === "play" ? state?.isPlaying : !state?.isPlaying;
      if (state?.controllerUserId === user.id && actionMatchesState) {
        const recovery = applyPlayback?.({
          action,
          currentTime: state.currentTime,
          playbackRate: state.playbackRate,
          activeMediaFrameUrl: state.activeMediaFrameUrl,
          reason: "local-apply-recovery"
        });
        Promise.resolve(recovery).catch((recoveryError) => {
          logPlaybackDiagnostic("room-control-local-recovery-failed", {
            roomId: room?.roomId,
            action,
            message: recoveryError?.message || String(recoveryError)
          });
        });
        localApplyFailureRef.current = null;
      }
    });
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

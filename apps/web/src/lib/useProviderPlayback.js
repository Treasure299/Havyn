import { useCallback, useEffect, useRef, useState } from "react";
import { isSyncedProvider, parseProviderEvent, postProviderCommand } from "./providerPlayback.js";
import { syncDebug } from "./roomConfig.js";

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function useProviderPlayback({ provider, iframeRef, socket, room, userId, canControl, notify }) {
  const [status, setStatus] = useState(isSyncedProvider(provider) ? "connecting" : "manual");
  const [needsGesture, setNeedsGesture] = useState(false);
  const local = useRef({ currentTime: 0, isPlaying: false, lastReportAt: 0, lastAppliedSequence: 0 });
  const remoteEcho = useRef(null);
  const delayedPlay = useRef(null);
  const playAttempt = useRef(null);
  const deniedNoticeAt = useRef(0);
  const bridgeReady = useRef(false);

  useEffect(() => {
    setStatus(isSyncedProvider(provider) ? "connecting" : "manual");
    setNeedsGesture(false);
    bridgeReady.current = false;
    local.current = { currentTime: 0, isPlaying: false, lastReportAt: 0, lastAppliedSequence: 0 };
  }, [provider?.adapterId, provider?.destination]);

  const report = useCallback((force = false) => {
    const now = Date.now();
    if (!socket || !room?.playbackState || (!force && now - local.current.lastReportAt < 3500)) return;
    local.current.lastReportAt = now;
    socket.command("participant-sync-report", {
      currentTime: local.current.currentTime,
      isPlaying: local.current.isPlaying,
      mediaSessionId: room.playbackState.mediaSessionId || "",
      sourceFingerprint: room.playbackState.sourceFingerprint || "",
      lastAppliedSequence: local.current.lastAppliedSequence
    });
  }, [room?.playbackState, socket]);

  const apply = useCallback((state, { force = false } = {}) => {
    const next = state?.state || state;
    const frame = iframeRef.current?.contentWindow;
    if (!isSyncedProvider(provider) || !frame || !next) return;
    const sequence = finite(next.sequence, 0);
    if (!force && sequence && sequence < local.current.lastAppliedSequence) {
      syncDebug("provider-apply-stale", { provider: provider.adapterId, received: sequence, applied: local.current.lastAppliedSequence });
      return;
    }
    const currentTime = finite(next.currentTime, local.current.currentTime);
    const isPlaying = next.isPlaying === true;
    const shouldSeek = force || Math.abs(currentTime - local.current.currentTime) > 0.85;
    const shouldSetPlaying = force || local.current.isPlaying !== isPlaying;
    local.current = { ...local.current, currentTime, isPlaying, lastAppliedSequence: Math.max(local.current.lastAppliedSequence, sequence) };
    if (!shouldSeek && !shouldSetPlaying) {
      syncDebug("provider-apply-skipped", { provider: provider.adapterId, sequence: next.sequence });
      return;
    }
    // CineSrc (and occasionally the other embedded providers) emits several
    // contradictory events while a remote seek settles: play, pause, seeked,
    // then play. They are acknowledgements of one remote command, not local
    // participant actions. Keep the whole burst out of publish() so a viewer
    // in a host-only room cannot accidentally cause a correction loop.
    remoteEcho.current = { until: Date.now() + 3500, isPlaying, currentTime };
    syncDebug("provider-apply", { provider: provider.adapterId, currentTime, isPlaying, sequence: next.sequence, shouldSeek, shouldSetPlaying, force });
    if (shouldSeek) postProviderCommand(provider, frame, "seek", currentTime);
    if (shouldSetPlaying) {
      clearTimeout(delayedPlay.current);
      if (isPlaying && shouldSeek) {
        // CineSrc acknowledges a seek with a brief pause. Give that seek a
        // moment to settle before asking it to play, then ignore the whole
        // acknowledgement burst instead of feeding it back into the room.
        delayedPlay.current = setTimeout(() => postProviderCommand(provider, frame, "play"), 180);
      } else {
        postProviderCommand(provider, frame, isPlaying ? "play" : "pause");
      }
      if (isPlaying) {
        const attemptId = crypto.randomUUID();
        playAttempt.current = attemptId;
        setTimeout(() => {
          if (playAttempt.current === attemptId && !local.current.isPlaying) setNeedsGesture(true);
        }, 1400);
      }
    }
  }, [iframeRef, provider]);

  const publish = useCallback((type) => {
    if (!canControl) {
      const now = Date.now();
      if (now - deniedNoticeAt.current > 3500) {
        deniedNoticeAt.current = now;
        notify?.("Playback is controlled by the host in this room.");
      }
      apply(room?.playbackState, { force: true });
      return;
    }
    syncDebug("provider-publish", { provider: provider?.adapterId, type, currentTime: local.current.currentTime });
    if (type === "play") socket?.command("playback-play", { currentTime: local.current.currentTime, playbackRate: 1 });
    if (type === "pause") socket?.command("playback-pause", { currentTime: local.current.currentTime, playbackRate: 1 });
    if (type === "seeked") socket?.command("playback-seek", { currentTime: local.current.currentTime, playbackRate: 1 });
  }, [apply, canControl, notify, room?.playbackState, socket]);

  const onFrameLoad = useCallback(() => {
    if (!isSyncedProvider(provider)) return;
    const frame = iframeRef.current?.contentWindow;
    postProviderCommand(provider, frame, "status");
    if (room?.playbackState?.sequence) apply(room.playbackState, { force: true });
  }, [apply, iframeRef, provider, room?.playbackState]);

  const startPlayback = useCallback(() => {
    const frame = iframeRef.current?.contentWindow;
    if (!canControl || !socket || !isSyncedProvider(provider) || !frame) return false;
    const currentTime = local.current.currentTime;
    remoteEcho.current = { until: Date.now() + 3500, isPlaying: true, currentTime };
    setNeedsGesture(false);
    postProviderCommand(provider, frame, "play");
    socket.command("playback-play", { currentTime, playbackRate: 1 });
    syncDebug("provider-start-together", { provider: provider.adapterId, currentTime });
    return true;
  }, [canControl, iframeRef, provider, socket]);

  const startLocally = useCallback(() => {
    const frame = iframeRef.current?.contentWindow;
    if (!isSyncedProvider(provider) || !frame) return false;
    remoteEcho.current = { until: Date.now() + 3500, isPlaying: true, currentTime: local.current.currentTime };
    setNeedsGesture(false);
    postProviderCommand(provider, frame, "play");
    return true;
  }, [iframeRef, provider]);

  useEffect(() => {
    if (!isSyncedProvider(provider)) return undefined;
    const onMessage = (event) => {
      const parsed = parseProviderEvent(provider, event, iframeRef.current?.contentWindow);
      if (!parsed) {
        if (event.source === iframeRef.current?.contentWindow) {
          syncDebug("provider-event-rejected", { provider: provider.adapterId, expectedOrigin: provider.origin, receivedOrigin: event.origin });
        }
        return;
      }
      syncDebug("provider-event", { provider: provider.adapterId, ...parsed });
      if (parsed.type === "error") {
        setStatus("failed");
        syncDebug("provider-stream-failed", { provider: provider.adapterId, message: parsed.message });
        return;
      }
      const firstBridgeEvent = !bridgeReady.current;
      bridgeReady.current = true;
      setStatus("ready");
      if (firstBridgeEvent && room?.playbackState?.sequence) apply(room.playbackState, { force: true });
      const pending = remoteEcho.current;
      const isRemoteAcknowledgement = pending && Date.now() < pending.until
        && ["play", "pause", "seeking", "seeked"].includes(parsed.type);
      if (isRemoteAcknowledgement) {
        if (parsed.type === "play") {
          local.current.isPlaying = true;
          playAttempt.current = null;
          setNeedsGesture(false);
        }
        syncDebug("provider-ignore-remote-echo", { provider: provider.adapterId, type: parsed.type });
        return;
      }
      if (Number.isFinite(parsed.currentTime)) local.current.currentTime = Math.max(0, parsed.currentTime);
      if (typeof parsed.isPlaying === "boolean") local.current.isPlaying = parsed.isPlaying;
      if (parsed.type === "play") { playAttempt.current = null; setNeedsGesture(false); }
      if (parsed.type === "ready") setStatus("ready");
      if (["play", "pause", "seeked"].includes(parsed.type)) {
        publish(parsed.type);
      }
      if (["play", "pause", "seeked", "timeupdate", "status"].includes(parsed.type)) report(parsed.type !== "timeupdate");
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [apply, iframeRef, provider, publish, report, room?.playbackState]);

  useEffect(() => () => clearTimeout(delayedPlay.current), []);

  useEffect(() => {
    if (!socket || !isSyncedProvider(provider)) return undefined;
    const receiveState = (payload, source) => {
      const next = payload?.state || payload;
      if (next?.controllerUserId === userId) {
        local.current.lastAppliedSequence = Math.max(local.current.lastAppliedSequence, finite(next.sequence, 0));
        syncDebug("provider-ignore-own-command", { provider: provider.adapterId, source, sequence: next.sequence });
        return;
      }
      apply(payload);
    };
    const offCommand = socket.on("playback-command", (payload) => receiveState(payload, "command"));
    const offState = socket.on("playback-state-sync", (payload) => receiveState(payload, "state-sync"));
    const offDenied = socket.on("permission-denied", () => apply(room?.playbackState, { force: true }));
    const interval = setInterval(() => report(), 7000);
    return () => { offCommand(); offState(); offDenied(); clearInterval(interval); };
  }, [apply, provider, report, room?.playbackState, socket, userId]);

  useEffect(() => {
    if (!isSyncedProvider(provider)) return;
    const next = room?.playbackState;
    if (!next?.sequence || !next.sourceFingerprint) return;
    if (next.controllerUserId === userId) {
      local.current.lastAppliedSequence = Math.max(local.current.lastAppliedSequence, finite(next.sequence, 0));
      return;
    }
    apply(next);
  }, [apply, provider, room?.playbackState?.sequence, room?.playbackState?.sourceFingerprint, userId]);

  useEffect(() => {
    if (status === "connecting") {
      const timeout = setTimeout(() => setStatus("waiting"), 8000);
      return () => clearTimeout(timeout);
    }
    if (status === "waiting") {
      const retry = setInterval(() => {
        postProviderCommand(provider, iframeRef.current?.contentWindow, "status");
      }, 4000);
      return () => clearInterval(retry);
    }
    return undefined;
  }, [iframeRef, provider, status]);

  return { status, onFrameLoad, report, startPlayback, startLocally, needsGesture };
}

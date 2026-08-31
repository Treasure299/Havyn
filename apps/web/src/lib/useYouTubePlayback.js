import { useCallback, useEffect, useRef, useState } from "react";
import { syncDebug } from "./roomConfig.js";

const PLAYER_SCRIPT = "https://www.youtube.com/iframe_api";
let playerApiPromise;

function loadPlayerApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (playerApiPromise) return playerApiPromise;
  playerApiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const script = document.createElement("script");
    script.src = PLAYER_SCRIPT;
    script.async = true;
    script.onerror = () => reject(new Error("YouTube player could not load."));
    window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT); };
    document.head.appendChild(script);
  });
  return playerApiPromise;
}

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function useYouTubePlayback({ enabled, container, videoId, socket, room, userId, canControl, notify }) {
  const [status, setStatus] = useState(enabled ? "connecting" : "manual");
  const [needsGesture, setNeedsGesture] = useState(false);
  const playerRef = useRef(null);
  const local = useRef({ currentTime: 0, isPlaying: false, lastReportAt: 0, lastAppliedSequence: 0, sampledAt: 0 });
  const remoteEcho = useRef(null);
  const deniedNoticeAt = useRef(0);
  const playbackStateRef = useRef(room?.playbackState);
  const lastObservedState = useRef({ value: null, at: 0 });
  const readyRef = useRef(false);
  const lastProbeDebugAt = useRef(0);

  useEffect(() => { playbackStateRef.current = room?.playbackState; }, [room?.playbackState]);

  const readCurrentTime = useCallback(() => {
    const next = playerRef.current?.getCurrentTime?.();
    if (Number.isFinite(next)) local.current.currentTime = Math.max(0, next);
    return local.current.currentTime;
  }, []);

  const report = useCallback((force = false) => {
    const now = Date.now();
    const playbackState = playbackStateRef.current;
    if (!socket || !playbackState || (!force && now - local.current.lastReportAt < 3500)) return;
    local.current.lastReportAt = now;
    socket.command("participant-sync-report", {
      currentTime: readCurrentTime(), isPlaying: local.current.isPlaying,
      mediaSessionId: playbackState.mediaSessionId || "", sourceFingerprint: playbackState.sourceFingerprint || "",
      lastAppliedSequence: local.current.lastAppliedSequence
    });
  }, [readCurrentTime, socket]);

  const apply = useCallback((payload, { force = false } = {}) => {
    const next = payload?.state || payload;
    const player = playerRef.current;
    if (!enabled || !player || !next) return;
    const sequence = number(next.sequence, 0);
    if (!force && sequence && sequence < local.current.lastAppliedSequence) return;
    const currentTime = number(next.currentTime, local.current.currentTime);
    const isPlaying = next.isPlaying === true;
    const shouldSeek = force || Math.abs(currentTime - local.current.currentTime) > 0.85;
    // A newly-ready YouTube player is already paused. Calling pauseVideo() on
    // that initial state can leave its poster surface blank in some browsers.
    const shouldSetPlaying = local.current.isPlaying !== isPlaying;
    local.current = { ...local.current, currentTime, isPlaying, lastAppliedSequence: Math.max(local.current.lastAppliedSequence, sequence) };
    if (!shouldSeek && !shouldSetPlaying) return;
    remoteEcho.current = { until: Date.now() + 1800, currentTime, isPlaying };
    syncDebug("youtube-apply", { currentTime, isPlaying, sequence, shouldSeek, shouldSetPlaying, force });
    if (shouldSeek) player.seekTo(currentTime, true);
    if (shouldSetPlaying) isPlaying ? player.playVideo() : player.pauseVideo();
  }, [enabled]);

  const publish = useCallback((type) => {
    if (!canControl) {
      const now = Date.now();
      if (now - deniedNoticeAt.current > 3500) { deniedNoticeAt.current = now; notify?.("Playback is controlled by the host in this room."); }
      apply(playbackStateRef.current, { force: true });
      return;
    }
    const currentTime = readCurrentTime();
    const event = type === "play" ? "playback-play" : "playback-pause";
    const sent = socket?.command(event, { currentTime, playbackRate: 1 });
    syncDebug("youtube-local-transition", { type, currentTime, sent: Boolean(sent), canControl });
  }, [apply, canControl, notify, readCurrentTime, socket]);

  const markReady = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    setStatus("ready");
    syncDebug("youtube-ready", { videoId, sequence: playbackStateRef.current?.sequence || 0 });
    if (playbackStateRef.current?.sequence) apply(playbackStateRef.current, { force: true });
    socket?.command("playback-sync-request");
  }, [apply, socket, videoId]);

  const startPlayback = useCallback(() => {
    const player = playerRef.current;
    if (!canControl || !socket || !enabled || !player) return false;
    const currentTime = readCurrentTime();
    remoteEcho.current = { until: Date.now() + 1800, currentTime, isPlaying: true };
    setNeedsGesture(false);
    player.playVideo();
    socket.command("playback-play", { currentTime, playbackRate: 1 });
    syncDebug("youtube-start-together", { currentTime });
    return true;
  }, [canControl, enabled, readCurrentTime, socket]);

  const startLocally = useCallback(() => {
    const player = playerRef.current;
    if (!enabled || !player) return false;
    const currentTime = readCurrentTime();
    remoteEcho.current = { until: Date.now() + 1800, currentTime, isPlaying: true };
    setNeedsGesture(false);
    player.playVideo();
    return true;
  }, [enabled, readCurrentTime]);

  const observePlayerState = useCallback((state, currentTime) => {
    const isPlaying = state === 1;
    const isPaused = state === 2;
    if (!isPlaying && !isPaused) return;
    const now = Date.now();
    if (lastObservedState.current.value === state) return;
    const firstObservedState = lastObservedState.current.value === null;
    lastObservedState.current = { value: state, at: now };
    local.current.isPlaying = isPlaying;
    if (isPlaying) setNeedsGesture(false);
    if (Number.isFinite(currentTime)) local.current.currentTime = Math.max(0, Number(currentTime));
    else readCurrentTime();
    const echo = remoteEcho.current;
    const matchesEcho = echo && now < echo.until && echo.isPlaying === isPlaying;
    // Consume an applied remote transition exactly once. Leaving it in place
    // can incorrectly swallow a user's immediate next click.
    remoteEcho.current = null;
    syncDebug("youtube-state-change", { state, isPlaying, currentTime: local.current.currentTime, matchesEcho: Boolean(matchesEcho), sequence: local.current.lastAppliedSequence });
    // YouTube commonly reports its initial paused state after ready. That is
    // not a user action, while an initial playing state is.
    if (firstObservedState && isPaused) {
      report(true);
      return;
    }
    if (!matchesEcho) publish(isPlaying ? "play" : "pause");
    report(true);
  }, [publish, readCurrentTime, report]);

  useEffect(() => {
    syncDebug(`youtube-player-effect enabled=${enabled} container=${Boolean(container)} video=${videoId}`);
    if (!enabled || !container || !videoId) return undefined;
    let disposed = false;
    let probeTimer;
    readyRef.current = false;
    setStatus("connecting");
    loadPlayerApi().then((YT) => {
      if (disposed || !container) return;
      playerRef.current = new YT.Player(container, {
        videoId,
        playerVars: { autoplay: 0, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => {
            if (disposed) return;
            markReady();
          },
          onStateChange: (event) => {
            if (disposed) return;
            observePlayerState(event.data);
          },
          onAutoplayBlocked: () => {
            syncDebug("youtube-autoplay-blocked", { videoId, sequence: local.current.lastAppliedSequence });
            if (!disposed) { setNeedsGesture(true); notify?.("YouTube needs one click before it can follow room playback."); }
          },
          onError: (event) => { syncDebug("youtube-error", { videoId, code: event?.data }); if (!disposed) { setStatus("error"); notify?.("YouTube could not play this video in an embed."); } }
        }
      });
      syncDebug("youtube-player-created", { videoId });
      const probe = () => {
        if (disposed || !playerRef.current) return;
        try {
          const state = Number(playerRef.current.getPlayerState?.());
          const currentTime = Number(playerRef.current.getCurrentTime?.());
          if (Date.now() - lastProbeDebugAt.current > 2000) {
            lastProbeDebugAt.current = Date.now();
            syncDebug("youtube-player-probe-sample", { state, currentTime });
          }
          if (Number.isFinite(state) && state !== -1) markReady();
          if (state === 1 || state === 2) {
            syncDebug("youtube-player-probe", { state, currentTime });
            observePlayerState(state, currentTime);
          }
        } catch (error) {
          syncDebug("youtube-player-probe-error", { message: String(error) });
        }
      };
      setTimeout(probe, 300);
      probeTimer = setInterval(probe, 450);
    }).catch((error) => { if (!disposed) { setStatus("error"); notify?.(error.message || "YouTube player could not load."); } });
    return () => {
      disposed = true;
      clearInterval(probeTimer);
      playerRef.current?.destroy?.();
      playerRef.current = null;
      syncDebug("youtube-player-disposed", { videoId });
    };
  }, [container, enabled, markReady, notify, observePlayerState, videoId]);

  useEffect(() => {
    if (!enabled) return undefined;
    const receiveMessage = (event) => {
      if (!/^https:\/\/(www\.)?youtube(?:-nocookie)?\.com$/.test(event.origin)) return;
      const iframe = playerRef.current?.getIframe?.() || container?.querySelector?.("iframe");
      if (iframe?.contentWindow && event.source !== iframe.contentWindow) return;
      let data = event.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { return; } }
      if (!data || typeof data !== "object") return;
      const info = data.info || {};
      const state = data.event === "onStateChange" ? Number(data.info) : Number(info.playerState);
      const currentTime = Number(info.currentTime);
      if (state === 1 || state === 2) {
        syncDebug("youtube-postmessage", { event: data.event || "infoDelivery", state, currentTime });
        observePlayerState(state, currentTime);
      }
    };
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [container, enabled, observePlayerState]);

  useEffect(() => {
    if (!enabled || !socket) return undefined;
    const receive = (payload) => {
      const next = payload?.state || payload;
      syncDebug("youtube-remote-command", { action: payload?.action || payload?.reason || "state", sequence: next?.sequence, controllerUserId: next?.controllerUserId });
      if (next?.controllerUserId === userId) {
        local.current.lastAppliedSequence = Math.max(local.current.lastAppliedSequence, number(next.sequence, 0));
        syncDebug("youtube-own-command-confirmed", { sequence: local.current.lastAppliedSequence });
        return;
      }
      apply(payload);
    };
    const offCommand = socket.on("playback-command", receive);
    const offState = socket.on("playback-state-sync", receive);
    const offDenied = socket.on("permission-denied", () => apply(playbackStateRef.current, { force: true }));
    const interval = setInterval(() => report(), 7000);
    return () => { offCommand(); offState(); offDenied(); clearInterval(interval); };
  }, [apply, enabled, report, socket, userId]);

  useEffect(() => {
    if (!enabled || status !== "ready" || !socket) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      const previousTime = local.current.currentTime;
      const previousAt = local.current.sampledAt;
      const currentTime = readCurrentTime();
      local.current.sampledAt = now;
      if (!previousAt || remoteEcho.current?.until > now) return;
      const expectedTime = previousTime + (local.current.isPlaying ? (now - previousAt) / 1000 : 0);
      if (Math.abs(currentTime - expectedTime) > 1.4) {
        if (!canControl) {
          apply(playbackStateRef.current, { force: true });
          return;
        }
        socket.command("playback-seek", { currentTime, playbackRate: 1 });
        report(true);
      }
    }, 850);
    return () => clearInterval(timer);
  }, [apply, canControl, enabled, readCurrentTime, report, socket, status]);

  return { status, startPlayback, startLocally, needsGesture };
}

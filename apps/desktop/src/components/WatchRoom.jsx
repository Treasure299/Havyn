import { Copy, FolderOpen, HelpCircle, LogOut, Maximize2, Menu, Minimize2, MonitorUp, UserCircle2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMediaDetection } from "../hooks/useMediaDetection";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { usePlaybackSync } from "../hooks/usePlaybackSync";
import { useScreenShare } from "../hooks/useScreenShare";
import { useWebRTC } from "../hooks/useWebRTC";
import { logPlaybackDiagnostic } from "../lib/playbackDiagnostics";
import { canonicalMediaSelection, isOnSharedMediaPage, sameBrowserPage, sharedMediaPageUrl } from "../lib/mediaSource";
import CallControls from "./CallControls";
import ChatPanel from "./ChatPanel";
import IntegratedBrowserPanel from "./IntegratedBrowserPanel";
import InteractiveGuide from "./InteractiveGuide";
import LiveSharePicker from "./LiveSharePicker";
import LiveShareSurface from "./LiveShareSurface";
import Logo from "./Logo";
import MediaDetectionPanel from "./MediaDetectionPanel";
import NotificationBell from "./NotificationBell";
import ParticipantsPanel from "./ParticipantsPanel";
import PlaybackControls from "./PlaybackControls";
import VersionNotice from "./VersionNotice";
import VideoBubbleRail from "./VideoBubbleRail";

const calculateProjectedTime = (state) => {
  if (!state) return 0;
  const base = Number(state.currentTime || 0);
  if (!state.isPlaying) return base;
  return base + ((Date.now() - Number(state.updatedAt || Date.now())) / 1000) * Number(state.playbackRate || 1);
};

const playbackCommandFromState = (state, reason = "state-sync") => {
  if (!state) return null;
  return {
    action: state.isPlaying ? "play" : "pause",
    currentTime: calculateProjectedTime(state),
    playbackRate: state.playbackRate || 1,
    activeMediaFrameUrl: state.activeMediaFrameUrl,
    reason
  };
};

export default function WatchRoom({ user, roomState, social, onSignOut }) {
  const { room, socket } = roomState;
  const call = useWebRTC({ socket, room, user });
  const liveShareEnabled = import.meta.env.VITE_LIVE_SHARE_ENABLED === "true";
  const playbackRef = useRef(null);
  const webVideoRef = useRef(null);
  const watchLayoutRef = useRef(null);
  const autoLoadedMediaUrlRef = useRef("");
  const mediaPageRepairRef = useRef({ sourceKey: "", mismatchUrl: "" });
  const manualBrowsingRef = useRef(false);
  const pendingMediaPageRef = useRef("");
  const autoSyncKeyRef = useRef("");
  const autoSyncTimersRef = useRef([]);
  const suppressMediaEventsUntilRef = useRef(0);
  const mediaIntentRef = useRef({ lastTime: null, seekStart: null, lastToggle: null });
  const [sideWidth, setSideWidth] = useState(336);
  const [viewerHeight, setViewerHeight] = useState(null);
  const [callHeight, setCallHeight] = useState(190);
  const [callLayout, setCallLayout] = useState("grid");
  const [focusPrimary, setFocusPrimary] = useState("remote");
  const [copyNote, setCopyNote] = useState("");
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [cinemaControlsOpen, setCinemaControlsOpen] = useState(false);
  const [cinemaChatCollapsed, setCinemaChatCollapsed] = useState(true);
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [liveSharePickerOpen, setLiveSharePickerOpen] = useState(false);
  const audioNoticeRef = useRef(null);
  const cinemaControlsButtonRef = useRef(null);
  const cinemaControlsRef = useRef(null);
  const roomMenuButtonRef = useRef(null);
  const roomMenuRef = useRef(null);
  const wasLiveShareRef = useRef(false);
  const [guideOpen, setGuideOpen] = useState(() => (
    localStorage.getItem("havyn:guide:watch:armed") === "true" ||
    localStorage.getItem("havyn:guide:watch:v1") !== "done"
  ));
  const callTileCount = (call.localStream ? 1 : 0) + call.streams.length;
  const canUseFocusLayout = call.joined && callTileCount === 2;

  useEffect(() => {
    window.havyn?.diagnostics?.isEnabled?.().then(setDiagnosticsEnabled).catch(() => {});
  }, []);

  function toggleFocusMode() {
    setFocusMode((next) => {
      const enabled = !next;
      if (enabled) document.documentElement.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      setCinemaControlsOpen(false);
      setCinemaChatCollapsed(true);
      return enabled;
    });
  }

  const closeCinemaControls = useCallback(() => setCinemaControlsOpen(false), []);
  const closeRoomMenu = useCallback(() => setRoomMenuOpen(false), []);

  useDismissableLayer(cinemaControlsOpen, [cinemaControlsButtonRef, cinemaControlsRef], closeCinemaControls);
  useDismissableLayer(roomMenuOpen, [roomMenuButtonRef, roomMenuRef], closeRoomMenu);

  function playMessageBeep() {
    if (!focusMode) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = audioNoticeRef.current || new AudioContext();
      audioNoticeRef.current = context;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(740, context.currentTime);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.045, context.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.18);
    } catch {
      // Notification sound is nice-to-have; never let it interrupt the room.
    }
  }

  function startSideResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const layoutRect = watchLayoutRef.current?.getBoundingClientRect();
    const layoutRight = layoutRect?.right || window.innerWidth;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add("is-resizing", "is-resizing-x");
    const stop = () => {
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture?.(event.pointerId);
      document.body.classList.remove("is-resizing", "is-resizing-x");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
    const move = (moveEvent) => {
      const nextWidth = Math.round(layoutRight - moveEvent.clientX - 8);
      setSideWidth(Math.min(560, Math.max(260, nextWidth)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  function startViewerResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = event.currentTarget.parentElement
      ?.querySelector(".browser-shell")
      ?.getBoundingClientRect().height || 560;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add("is-resizing", "is-resizing-y");
    const stop = () => {
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture?.(event.pointerId);
      document.body.classList.remove("is-resizing", "is-resizing-y");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
    const move = (moveEvent) => {
      const nextHeight = Math.round(startHeight + (moveEvent.clientY - startY));
      setViewerHeight(Math.min(window.innerHeight - 180, Math.max(320, nextHeight)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  function startCallResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = event.currentTarget.previousElementSibling?.getBoundingClientRect().height || callHeight;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add("is-resizing", "is-resizing-y");
    const stop = () => {
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture?.(event.pointerId);
      document.body.classList.remove("is-resizing", "is-resizing-y");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
    const move = (moveEvent) => {
      const nextHeight = Math.round(startHeight + (moveEvent.clientY - startY));
      setCallHeight(Math.min(420, Math.max(132, nextHeight)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  const handleMediaEvent = useCallback((event) => {
    if (!room || room.roomExperience === "live-share") return;
    const eventName = event.eventName;
    const now = Date.now();
    const currentTime = Number(event.media?.currentTime);
    const hasCurrentTime = Number.isFinite(currentTime);
    const intent = mediaIntentRef.current;
    const playbackApi = playbackRef.current;

    logPlaybackDiagnostic("renderer-media-event", {
      roomId: room.roomId,
      eventName,
      mode: room.playbackMode,
      canControl: Boolean(playbackApi?.canControl),
      controlledByHavyn: Boolean(event.controlledByHavyn),
      sourceFrameUrl: event.sourceFrameUrl || event.media?.frameUrl || "",
      media: {
        currentTime: hasCurrentTime ? currentTime : null,
        paused: Boolean(event.media?.paused),
        playbackRate: Number(event.media?.playbackRate || 1),
        readyState: Number(event.media?.readyState || 0)
      }
    });

    if (event.controlledByHavyn) {
      logPlaybackDiagnostic("renderer-media-event-ignored-remote", { roomId: room.roomId, eventName });
      if (hasCurrentTime) intent.lastTime = currentTime;
      return;
    }

    if (eventName === "seeking") {
      intent.seekStart = {
        startedAt: now,
        fromTime: Number.isFinite(intent.lastTime)
          ? intent.lastTime
          : calculateProjectedTime(playbackApi?.playbackState)
      };
      return;
    }

    if (["timeupdate", "loadedmetadata", "canplay", "playing"].includes(eventName) && hasCurrentTime) {
      intent.lastTime = currentTime;
    }

    if (eventName === "ratechange") {
      const authoritativeRate = Number(playbackApi?.playbackState?.playbackRate || 1);
      const observedRate = Number(event.media?.playbackRate || 1);
      if (Math.abs(observedRate - authoritativeRate) > 0.01) {
        mediaRef.current?.applyPlayback?.({
          playbackRate: authoritativeRate,
          reason: "rate-restore"
        });
      }
      return;
    }

    // Source startup can generate synthetic seeks. Real play and pause clicks
    // must remain responsive while the selected source settles.
    if (eventName === "seeked" && now < suppressMediaEventsUntilRef.current) return;
    const payload = { roomId: room.roomId, userId: user.id, currentTime: event.media.currentTime };

    if (playbackApi?.canControl) {
      if (eventName === "play") {
        intent.lastToggle = { eventName, at: now };
        if (hasCurrentTime) intent.lastTime = currentTime;
        logPlaybackDiagnostic("renderer-media-event-sending", { roomId: room.roomId, eventName, payload });
        socket.emit("playback-play", payload);
      }
      if (eventName === "pause") {
        intent.lastToggle = { eventName, at: now };
        if (hasCurrentTime) intent.lastTime = currentTime;
        logPlaybackDiagnostic("renderer-media-event-sending", { roomId: room.roomId, eventName, payload });
        socket.emit("playback-pause", payload);
      }
      if (eventName === "seeked") {
        const seekStart = intent.seekStart;
        intent.seekStart = null;
        const seekDistance = seekStart && hasCurrentTime ? Math.abs(currentTime - seekStart.fromTime) : 0;
        const recentToggle = intent.lastToggle && now - intent.lastToggle.at < 750;
        const isIntentionalSeek = Boolean(
          seekStart &&
          now - seekStart.startedAt < 3000 &&
          seekDistance >= (recentToggle ? 2 : 0.75)
        );
        if (hasCurrentTime) intent.lastTime = currentTime;
        if (isIntentionalSeek) {
          logPlaybackDiagnostic("renderer-media-event-sending", { roomId: room.roomId, eventName: "seek", payload });
          socket.emit("playback-seek", payload);
        }
      }
    } else if (["play", "pause", "seeked"].includes(eventName)) {
      const command = playbackCommandFromState(playbackApi?.playbackState, "permission-restore");
      logPlaybackDiagnostic("renderer-media-event-permission-restore", { roomId: room.roomId, eventName, command });
      if (event.video) mediaRef.current?.applyWebPlayback(event.video, command);
      else mediaRef.current?.applyPlayback(command);
    }

    if (eventName === "ended") {
      socket.emit("media-ended", payload);
    }
  }, [room, socket, user.id]);

  const media = useMediaDetection({ socket, room, user, onMediaEvent: handleMediaEvent });
  const playback = usePlaybackSync({
    socket,
    room,
    user,
    applyPlayback: media.applyPlayback,
    localCurrentTime: media.detectedMedia[0]?.currentTime,
    onPlaybackState: roomState.updatePlaybackSnapshot,
    suspended: room.roomExperience === "live-share"
  });
  const mediaRef = useRef(media);
  const screenShare = useScreenShare({
    socket,
    room,
    user,
    enabled: liveShareEnabled,
    browser: media.browser,
    detectedMedia: media.detectedMedia
  });

  useEffect(() => {
    mediaRef.current = media;
    playbackRef.current = playback;
  }, [media, playback]);

  const sharingBrowserRegion = screenShare.isHosting && ["browser-region", "browser-window-region", "browser-webframe"].includes(screenShare.captureMode);
  const showingLiveShare = Boolean(screenShare.localStream || screenShare.watching) && !sharingBrowserRegion;

  useEffect(() => {
    const isLive = room.roomExperience === "live-share";
    if (isLive && !wasLiveShareRef.current) {
      media.applyPlayback?.({
        action: "pause",
        currentTime: calculateProjectedTime(room.playbackState),
        playbackRate: room.playbackState?.playbackRate || 1,
        activeMediaFrameUrl: room.playbackState?.activeMediaFrameUrl,
        reason: "live-share-suspend"
      });
    }
    if (!isLive && wasLiveShareRef.current) {
      media.applyPlayback?.(playbackCommandFromState(room.playbackState, "live-share-restore"));
    }
    wasLiveShareRef.current = isLive;
  }, [media, room.playbackState, room.roomExperience]);

  useEffect(() => {
    if (!canUseFocusLayout && callLayout === "focus") setCallLayout("grid");
  }, [callLayout, canUseFocusLayout]);

  useEffect(() => {
    media.browser?.setVisible?.(!(guideOpen || devicesOpen || liveSharePickerOpen || showingLiveShare));
    return () => media.browser?.setVisible?.(true);
  }, [devicesOpen, guideOpen, liveSharePickerOpen, media.browser, showingLiveShare]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setFocusMode(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!focusMode) return undefined;
    const handleEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setFocusMode(false);
      setCinemaControlsOpen(false);
      setCinemaChatCollapsed(true);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [focusMode]);

  useEffect(() => {
    const handleSelected = ({ media: selected, playbackState: selectedState }) => {
      if (room.roomExperience === "live-share") return;
      manualBrowsingRef.current = false;
      pendingMediaPageRef.current = "";
      const playableUrl = sharedMediaPageUrl(selected);
      logPlaybackDiagnostic("room-media-selected-received", {
        roomId: room.roomId,
        currentUrl: media.currentUrl,
        playableUrl,
        selected: {
          url: selected?.url || "",
          pageUrl: selected?.pageUrl || "",
          frameUrl: selected?.frameUrl || ""
        }
      });
      if (playableUrl) {
        suppressMediaEventsUntilRef.current = Date.now() + 12_000;
        if (isOnSharedMediaPage(media.currentUrl, selected)) {
          media.scanMedia?.().then(() => {
            if (selectedState) {
              media.applyPlayback?.(playbackCommandFromState(selectedState, "media-selected"));
            }
          });
          return;
        }
        media.loadUrl(playableUrl).then(() => {
          window.setTimeout(() => media.scanMedia?.(), 700);
          window.setTimeout(() => {
            if (selectedState) {
              media.applyPlayback?.(playbackCommandFromState(selectedState, "media-selected"));
            }
          }, 1400);
        });
      }
    };
    socket.on("media-selected", handleSelected);
    return () => socket.off("media-selected", handleSelected);
  }, [media, room.roomExperience, socket]);

  useEffect(() => {
    if (room.roomExperience === "live-share") return;
    const activeUrl = playback.playbackState?.activeMediaPageUrl || playback.playbackState?.activeMediaUrl || room.playbackState?.activeMediaPageUrl || room.playbackState?.activeMediaUrl;
    if (!activeUrl) return;
    if (pendingMediaPageRef.current && sameBrowserPage(activeUrl, pendingMediaPageRef.current)) {
      manualBrowsingRef.current = false;
      pendingMediaPageRef.current = "";
    }
    if (manualBrowsingRef.current) return;
    const activeState = playback.playbackState || room.playbackState || {};
    const isOnActivePage = isOnSharedMediaPage(media.currentUrl, {
      url: activeUrl,
      pageUrl: activeState.activeMediaPageUrl,
      frameUrl: activeState.activeMediaFrameUrl
    });
    if (isOnActivePage) {
      autoLoadedMediaUrlRef.current = activeUrl;
      mediaPageRepairRef.current = { sourceKey: "", mismatchUrl: "" };
      return;
    }
    const sourceKey = `${activeUrl}|${activeState.activeMediaFrameUrl || ""}`;
    const mismatchUrl = media.currentUrl || "";
    if (
      mediaPageRepairRef.current.sourceKey === sourceKey &&
      mediaPageRepairRef.current.mismatchUrl === mismatchUrl
    ) {
      logPlaybackDiagnostic("room-media-page-repair-skipped", {
        roomId: room.roomId,
        activeUrl,
        currentUrl: mismatchUrl,
        reason: "duplicate-mismatch"
      });
      return;
    }
    // Repair a real top-level navigation away from the shared source once.
    // Repeated child-frame reports must never create a reload loop.
    mediaPageRepairRef.current = { sourceKey, mismatchUrl };
    autoLoadedMediaUrlRef.current = activeUrl;
    logPlaybackDiagnostic("room-media-page-repair", {
      roomId: room.roomId,
      activeUrl,
      currentUrl: mismatchUrl
    });
    suppressMediaEventsUntilRef.current = Date.now() + 12_000;
    media.loadUrl(activeUrl).then(() => {
      window.setTimeout(() => {
        socket.emit("playback-sync-request", { roomId: room.roomId, userId: user.id });
      }, 900);
    });
  }, [
    media,
    media.currentUrl,
    playback.playbackState?.activeMediaFrameUrl,
    playback.playbackState?.activeMediaPageUrl,
    playback.playbackState?.activeMediaUrl,
    room.playbackState?.activeMediaFrameUrl,
    room.playbackState?.activeMediaPageUrl,
    room.playbackState?.activeMediaUrl,
    room.roomExperience
  ]);

  useEffect(() => {
    if (room.roomExperience === "live-share") {
      autoSyncTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      autoSyncTimersRef.current = [];
      return;
    }
    const state = playback.playbackState || room.playbackState;
    const firstMedia = media.detectedMedia[0];
    if (!state?.activeMediaUrl || !firstMedia) return;
    const key = `${state.activeMediaUrl}|${firstMedia.id || firstMedia.index || 0}|${Math.round(firstMedia.duration || 0)}`;
    if (autoSyncKeyRef.current === key) return;
    autoSyncKeyRef.current = key;
    suppressMediaEventsUntilRef.current = Date.now() + 8000;
    autoSyncTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    autoSyncTimersRef.current = [350, 1200, 2400].map((delay) => (
      window.setTimeout(() => {
        socket.emit("playback-sync-request", { roomId: room.roomId, userId: user.id });
      }, delay)
    ));
  }, [media.detectedMedia, playback.playbackState, room.playbackState, room.roomExperience, room.roomId, socket, user.id]);

  useEffect(() => () => {
    autoSyncTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const selectRoomMedia = useCallback((selected) => {
    if (room.roomExperience === "live-share") return;
    const mediaForRoom = canonicalMediaSelection(selected, media.currentUrl);
    const playableUrl = mediaForRoom.pageUrl;
    if (!playableUrl) return;
    pendingMediaPageRef.current = playableUrl;
    logPlaybackDiagnostic("room-media-selected-sending", {
      roomId: room.roomId,
      currentUrl: media.currentUrl,
      selected: {
        url: selected?.url || "",
        pageUrl: selected?.pageUrl || "",
        frameUrl: selected?.frameUrl || ""
      },
      canonical: {
        url: mediaForRoom.url,
        pageUrl: mediaForRoom.pageUrl,
        frameUrl: mediaForRoom.frameUrl
      }
    });
    suppressMediaEventsUntilRef.current = Date.now() + 12_000;
    // Source selection establishes a paused baseline. Playback begins through a
    // separate controller action, avoiding blocked-autoplay retry loops.
    Object.assign(mediaForRoom, {
      paused: true,
      playbackRate: 1
    });
    playback.selectMedia(mediaForRoom);
    if (sameBrowserPage(media.currentUrl, playableUrl)) {
      media.applyPlayback?.({ action: "pause", playbackRate: 1, reason: "source-selected" });
      window.setTimeout(() => media.scanMedia?.(), 250);
      return;
    }
    media.loadUrl(playableUrl).then(() => {
      window.setTimeout(() => media.scanMedia?.(), 700);
      window.setTimeout(() => media.scanMedia?.(), 1600);
    }).catch(() => {});
  }, [media, playback, room.roomExperience, room.roomId]);

  const beginManualBrowsing = useCallback((nextUrl = "") => {
    manualBrowsingRef.current = true;
    pendingMediaPageRef.current = "";
    mediaPageRepairRef.current = { sourceKey: "", mismatchUrl: "" };
    autoLoadedMediaUrlRef.current = "";
    logPlaybackDiagnostic("room-manual-browsing", {
      roomId: room.roomId,
      nextUrl
    });
  }, [room.roomId]);

  useEffect(() => {
    const initialUrl = room.initialBrowserUrl;
    if (!initialUrl || room.roomExperience === "live-share") return;
    beginManualBrowsing(initialUrl);
    media.loadUrl(initialUrl).finally(() => roomState.clearInitialBrowserUrl?.());
  }, [beginManualBrowsing, media, room.initialBrowserUrl, room.roomExperience, roomState]);

  const resyncToRoom = useCallback(async () => {
    if (room.roomExperience === "live-share") return;
    const state = playbackRef.current?.playbackState || room.playbackState;
    const activeUrl = state?.activeMediaPageUrl || state?.activeMediaUrl;
    if (!activeUrl) return;
    manualBrowsingRef.current = false;
    pendingMediaPageRef.current = "";
    mediaPageRepairRef.current = { sourceKey: "", mismatchUrl: "" };
    autoLoadedMediaUrlRef.current = activeUrl;
    suppressMediaEventsUntilRef.current = Date.now() + 12_000;
    logPlaybackDiagnostic("room-manual-resync", {
      roomId: room.roomId,
      activeUrl,
      currentUrl: media.currentUrl
    });
    if (!sameBrowserPage(media.currentUrl, activeUrl)) {
      await media.loadUrl(activeUrl).catch(() => {});
    }
    await media.scanMedia?.().catch(() => {});
    const command = playbackCommandFromState(state, "manual-room-resync");
    if (command) media.applyPlayback?.(command);
    socket.emit("playback-sync-request", { roomId: room.roomId, userId: user.id });
    window.setTimeout(() => {
      media.scanMedia?.().catch(() => {});
      socket.emit("playback-sync-request", { roomId: room.roomId, userId: user.id });
    }, 1100);
  }, [media, room.playbackState, room.roomExperience, room.roomId, socket, user.id]);

  const inviteLink = `havyn://room/${room.roomId}`;
  const copyRoomCode = async () => {
    if (window.havyn?.clipboard?.writeText) window.havyn.clipboard.writeText(room.roomId);
    else await navigator.clipboard?.writeText(room.roomId).catch(() => {});
    setCopyNote("Room code copied");
    window.setTimeout(() => setCopyNote(""), 1800);
  };

  const watchGuideSteps = [
    {
      targetClass: "guide-browser-target",
      position: "right-center",
      title: "Browser",
      body: "Open the page you want to watch here. Each person loads the page locally in their own Havyn browser session.",
      note: "Havyn syncs playback state. It does not stream, copy, or redistribute the video."
    },
    {
      targetClass: "guide-source-target",
      position: "upper-left",
      title: "Sync source",
      body: "When Havyn detects a playable source, the host can sync it to the room. New participants will be brought to the active source automatically."
    },
    {
      targetClass: "guide-controls-target",
      position: "bottom-left",
      title: "Playback control",
      body: "This shows who can control playback based on the room mode. Host-only, cohost, and everyone modes are handled by the server."
    },
    {
      targetClass: "guide-call-target",
      position: "left-center",
      title: "Call",
      body: "Join optional voice/video here. You can resize this area and choose grid or focus layout for two-person calls."
    },
    {
      targetClass: "guide-chat-target",
      position: "left-center",
      title: "Chat and people",
      body: "Chat stays beside the movie. The People drawer shows who is in the room, who is host, and who is ready."
    }
  ];

  const roomMenu = roomMenuOpen ? createPortal(
    <div ref={roomMenuRef} className="profile-popover account-popover room-account-popover glass" role="menu" aria-label="Room account menu">
      <div className="profile-popover-head">
        <div>
          <strong>{user.displayName}</strong>
          <span>{user.username ? `@${user.username}` : "Havyn account"}</span>
        </div>
        <VersionNotice compact />
      </div>
      <div className="account-menu-actions">
        <button
          className="account-menu-row"
          type="button"
          role="menuitem"
          onClick={() => {
            setRoomMenuOpen(false);
            setGuideOpen(true);
          }}
        >
          <HelpCircle size={17} />
          <span>Room guide</span>
        </button>
        {social && <NotificationBell embedded user={user} social={social} onJoinRoom={roomState.joinRoom} />}
        {diagnosticsEnabled && (
          <button
            className="account-menu-row"
            type="button"
            role="menuitem"
            onClick={() => {
              setRoomMenuOpen(false);
              window.havyn?.diagnostics?.openFolder?.();
            }}
          >
            <FolderOpen size={17} />
            <span>Diagnostics</span>
          </button>
        )}
      </div>
      <button className="danger-button account-signout" type="button" role="menuitem" onClick={onSignOut}><LogOut size={16} /> Sign out</button>
    </div>,
    document.body
  ) : null;

  const liveShareCompatible = liveShareEnabled && room.participants.length <= 4 && room.participants.every((participant) => (
    participant.capabilities?.includes("live-share-v1")
  ));

  return (
    <main className={`watch-room ${focusMode ? "is-focus-mode" : ""} ${focusMode && !cinemaChatCollapsed ? "is-cinema-chat-open" : ""}`}>
      <header className="room-header">
        <Logo compact />
        <div className="room-title">
          <strong>{room.roomName}</strong>
          <span>Host: {room.participants.find((p) => p.userId === room.hostUserId)?.displayName || "Host"} - {room.playbackMode}</span>
        </div>
        <div className="header-actions">
          {liveShareEnabled && room.hostUserId === user.id && (
            <button
              className={`icon-text live-share-header-button ${room.roomExperience === "live-share" ? "is-live" : ""}`}
              type="button"
              disabled={!liveShareCompatible && room.roomExperience !== "live-share"}
              onClick={() => room.roomExperience === "live-share" ? screenShare.stopShare() : setLiveSharePickerOpen(true)}
              title={liveShareCompatible ? "Share a screen or window" : "Live Share requires up to 4 participants using a compatible Havyn build"}
            >
              <MonitorUp size={17} /> {room.roomExperience === "live-share" ? "Stop Live" : "Live Share"}
            </button>
          )}
          <button className="icon-button" onClick={toggleFocusMode} title={focusMode ? "Exit focus mode" : "Focus mode"}>
            {focusMode ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <select className="mode-select" value={room.playbackMode} disabled={room.roomExperience === "live-share"} onChange={(event) => roomState.setPlaybackMode(event.target.value)}>
            <option value="host-only">host-only</option>
            <option value="host-and-cohosts">host-and-cohosts</option>
            <option value="everyone">everyone</option>
          </select>
          <button className="icon-text" onClick={copyRoomCode} title="Copy room code"><Copy size={17} /> {room.roomId}</button>
          {copyNote && <span className="header-note">{copyNote}</span>}
          <button className="icon-button" onClick={roomState.leaveRoom} title="Leave room"><LogOut size={18} /></button>
          <button
            ref={roomMenuButtonRef}
            className={`account-menu-button room-account-button ${roomMenuOpen ? "is-open" : ""}`}
            type="button"
            onClick={() => setRoomMenuOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={roomMenuOpen}
            title="Account menu"
          >
            <UserCircle2 size={18} />
            <Menu size={17} />
          </button>
        </div>
      </header>
      {roomMenu}

      {roomState.permissionNotice && <div className="toast">{roomState.permissionNotice}</div>}
      {social?.socialNote && <div className="toast social-toast">{social.socialNote}</div>}
      {call.callNotice && <div className="toast">{call.callNotice}</div>}
      {roomState.actionNotice && <div className="action-toast">{roomState.actionNotice}</div>}
      {focusMode && (
        <>
          <button
            ref={cinemaControlsButtonRef}
            className={`cinema-controls-toggle ${cinemaControlsOpen ? "is-open" : ""}`}
            type="button"
            onClick={() => setCinemaControlsOpen((value) => !value)}
            title={cinemaControlsOpen ? "Hide fullscreen controls" : "Show fullscreen controls"}
          >
            <Maximize2 size={15} />
          </button>
          <div ref={cinemaControlsRef} className={`cinema-top-controls glass ${cinemaControlsOpen ? "is-open" : ""}`}>
            <button className="icon-text" type="button" onClick={toggleFocusMode}><Minimize2 size={16} /> Exit Fullscreen</button>
            <div>
              <strong>{room.playbackState?.activeMediaTitle || "Detected video"}</strong>
              <span>{room.playbackMode}</span>
            </div>
            {room.roomExperience === "live-share" ? (
              <button className="danger-button" type="button" onClick={screenShare.isHost ? screenShare.stopShare : screenShare.leaveShare}>
                {screenShare.isHost ? "Stop sharing" : "Leave Live Share"}
              </button>
            ) : (
              <button
                className="first-sync-button"
                type="button"
                disabled={!playback.canControl || !playback.playbackState?.activeMediaUrl}
                onClick={playback.play}
              >
                First Sync Play
              </button>
            )}
          </div>
        </>
      )}

      <section
        ref={watchLayoutRef}
        className="watch-layout"
        style={{ gridTemplateColumns: `minmax(0, 1fr) 5px minmax(260px, ${sideWidth}px)` }}
      >
        <div
          className="watch-main"
          style={viewerHeight ? { gridTemplateRows: `${viewerHeight}px 3px auto` } : undefined}
        >
          <div className="viewing-stage">
            <IntegratedBrowserPanel
              className={`guide-browser-target ${showingLiveShare && !sharingBrowserRegion ? "is-live-share-hidden" : ""}`}
              browser={media.browser}
              currentUrl={media.currentUrl}
              onLoadUrl={media.loadUrl}
              onUserNavigate={beginManualBrowsing}
              activeMediaTitle={room.playbackState?.activeMediaTitle}
              onWebMediaDetected={(items, video) => {
                webVideoRef.current = video;
                media.reportWebMedia(items);
              }}
              onWebMediaEvent={handleMediaEvent}
              webPlaybackState={playback.playbackState}
              layoutSignal={focusMode ? "cinema" : "normal"}
            />
            {showingLiveShare && (
              <LiveShareSurface share={screenShare} focusMode={focusMode} onToggleFocus={toggleFocusMode} />
            )}
            {sharingBrowserRegion && (
              <div className="live-share-browser-badge glass"><i /> LIVE <span>Sharing Havyn browser</span></div>
            )}
            {!showingLiveShare && screenShare.invitation && (
              <div className="live-share-invite glass">
                <span className="live-kicker">LIVE SHARE</span>
                <strong>{screenShare.invitation.hostDisplayName} started Live Share</strong>
                <div>
                  <button className="primary-button" type="button" onClick={screenShare.acceptShare}>Watch</button>
                  <button className="ghost-button" type="button" onClick={screenShare.declineShare}>Not now</button>
                </div>
              </div>
            )}
            {!showingLiveShare && screenShare.available && !screenShare.invitation && (
              <button className="live-share-available glass" type="button" onClick={screenShare.acceptShare}>
                <MonitorUp size={17} /> Live Share available <span>Watch</span>
              </button>
            )}
          </div>
          {!showingLiveShare && room.roomExperience !== "live-share" && <div className="viewer-resize-handle" title="Resize viewing area" onPointerDown={startViewerResize} onDoubleClick={() => setViewerHeight(null)} />}
          {!showingLiveShare && room.roomExperience !== "live-share" && <div className="viewer-toolbar">
            <div className="guide-source-target">
              <MediaDetectionPanel
                detectedMedia={media.detectedMedia}
                canControl={playback.canControl}
                onSelect={selectRoomMedia}
                onScan={media.scanMedia}
              />
            </div>
            <div className="guide-controls-target">
              <PlaybackControls
                canControl={playback.canControl}
                playbackMode={room.playbackMode}
                playbackState={playback.playbackState}
                onPlay={playback.play}
                onPause={playback.pause}
                canResync={room.visibility === "public" && room.hostUserId !== user.id}
                onResync={resyncToRoom}
              />
            </div>
          </div>}
        </div>
        <div
          className="watch-resize-handle"
          role="separator"
          aria-orientation="vertical"
          title="Resize panels"
          onPointerDown={startSideResize}
          onDoubleClick={() => setSideWidth(336)}
        />
        <aside
          className={`watch-side ${sideWidth < 310 ? "is-compact" : ""}`}
          style={{ gridTemplateRows: `${callHeight}px 5px minmax(0, 1fr) auto` }}
        >
          <section className="call-panel glass guide-call-target">
            <div className="side-heading">
              <div className="side-heading-text">
                <strong>Call</strong>
                <span>{call.joined ? "Connected" : "Optional"}</span>
              </div>
              <div className="layout-toggle" title="Video layout">
                <button className={callLayout === "grid" ? "is-active" : ""} onClick={() => setCallLayout("grid")} type="button">Grid</button>
                <button
                  className={callLayout === "focus" ? "is-active" : ""}
                  onClick={() => canUseFocusLayout && setCallLayout("focus")}
                  disabled={!canUseFocusLayout}
                  type="button"
                  title={canUseFocusLayout ? "Two-person focus layout" : "Focus works with 2 people"}
                >
                  Focus
                </button>
                {callLayout === "focus" && (
                  <button type="button" onClick={() => setFocusPrimary((value) => value === "remote" ? "local" : "remote")}>Swap</button>
                )}
              </div>
              <CallControls call={call} onDevicesOpenChange={setDevicesOpen} />
            </div>
            <VideoBubbleRail
              call={call}
              participants={room.participants}
              layout={callLayout}
              focusPrimary={focusPrimary}
              floating={focusMode}
              isPlaying={room.roomExperience === "live-share"
                ? Boolean(screenShare.localStream || screenShare.remoteStream)
                : Boolean(playback.playbackState?.isPlaying || room.playbackState?.isPlaying)}
              chatOpen={focusMode && !cinemaChatCollapsed}
            />
          </section>
          <div className="side-resize-handle" title="Resize call area" onPointerDown={startCallResize} onDoubleClick={() => setCallHeight(190)} />
          <div className="guide-chat-target side-stack">
            <ChatPanel
              messages={roomState.messages}
              onSend={roomState.sendMessage}
              className="focus-chat-overlay"
              collapsible={focusMode}
              collapsed={focusMode && cinemaChatCollapsed}
              onToggle={() => setCinemaChatCollapsed((value) => !value)}
              onFreshMessage={playMessageBeep}
              currentUserId={user.id}
            />
            <ParticipantsPanel
              participants={room.participants}
              currentUserId={user.id}
              onRoleChange={roomState.setParticipantRole}
            />
          </div>
        </aside>
      </section>

      <InteractiveGuide
        storageKey="havyn:guide:watch:v1"
        steps={watchGuideSteps}
        open={guideOpen}
        onClose={() => {
          localStorage.setItem("havyn:guide:watch:v1", "done");
          localStorage.removeItem("havyn:guide:watch:armed");
          setGuideOpen(false);
        }}
      />
      <LiveSharePicker
        open={liveSharePickerOpen}
        starting={screenShare.starting}
        onClose={() => {
          setLiveSharePickerOpen(false);
          window.havyn?.screenShare?.cancel?.().catch(() => {});
        }}
        onStart={(selection) => {
          const captureTarget = media.browser?.getCaptureTarget?.();
          const browserRect = captureTarget?.bounds
            || document.querySelector(".viewing-stage .browser-frame")?.getBoundingClientRect();
          return screenShare.startShare({
            ...selection,
            browserWebContentsId: captureTarget?.webContentsId || null,
            browserRect: browserRect ? {
              x: browserRect.x,
              y: browserRect.y,
              width: browserRect.width,
              height: browserRect.height
            } : null
          });
        }}
      />
      {createPortal(
        <>
          {screenShare.error && <div className="toast live-share-toast" onClick={screenShare.clearError}>{screenShare.error}</div>}
          {screenShare.notice && <div className="action-toast live-share-notice">{screenShare.notice}</div>}
        </>,
        document.body
      )}
    </main>
  );
}

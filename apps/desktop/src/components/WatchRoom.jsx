import { Copy, HelpCircle, LogOut, Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaDetection } from "../hooks/useMediaDetection";
import { usePlaybackSync } from "../hooks/usePlaybackSync";
import { useWebRTC } from "../hooks/useWebRTC";
import CallControls from "./CallControls";
import ChatPanel from "./ChatPanel";
import IntegratedBrowserPanel from "./IntegratedBrowserPanel";
import InteractiveGuide from "./InteractiveGuide";
import Logo from "./Logo";
import MediaDetectionPanel from "./MediaDetectionPanel";
import NotificationBell from "./NotificationBell";
import ParticipantsPanel from "./ParticipantsPanel";
import PlaybackControls from "./PlaybackControls";
import VideoBubbleRail from "./VideoBubbleRail";

const calculateProjectedTime = (state) => {
  if (!state) return 0;
  const base = Number(state.currentTime || 0);
  if (!state.isPlaying) return base;
  return base + ((Date.now() - Number(state.updatedAt || Date.now())) / 1000) * Number(state.playbackRate || 1);
};

const sameBrowserPage = (left = "", right = "") => {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.toString() === rightUrl.toString();
  } catch {
    return Boolean(left && right && left === right);
  }
};

const isCurrentPlayableSource = (currentUrl = "", selected = {}) => (
  sameBrowserPage(currentUrl, selected.url) ||
  sameBrowserPage(currentUrl, selected.frameUrl)
);

const playableSourceUrl = (selected = {}) => selected.frameUrl || selected.url || selected.pageUrl || "";

const playbackCommandFromState = (state, reason = "state-sync") => {
  if (!state) return null;
  return {
    action: state.isPlaying ? "play" : "pause",
    currentTime: calculateProjectedTime(state),
    playbackRate: state.playbackRate || 1,
    reason
  };
};

export default function WatchRoom({ user, roomState, social, onSignOut }) {
  const { room, socket } = roomState;
  const call = useWebRTC({ socket, room, user });
  const playbackRef = useRef(null);
  const webVideoRef = useRef(null);
  const watchLayoutRef = useRef(null);
  const autoLoadedMediaUrlRef = useRef("");
  const autoSyncKeyRef = useRef("");
  const autoSyncTimersRef = useRef([]);
  const suppressMediaEventsUntilRef = useRef(0);
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
  const audioNoticeRef = useRef(null);
  const [guideOpen, setGuideOpen] = useState(() => (
    localStorage.getItem("havyn:guide:watch:armed") === "true" ||
    localStorage.getItem("havyn:guide:watch:v1") !== "done"
  ));
  const callTileCount = (call.localStream ? 1 : 0) + call.streams.length;
  const canUseFocusLayout = call.joined && callTileCount === 2;

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
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
    const move = (moveEvent) => {
      if (moveEvent.buttons === 0) {
        stop();
        return;
      }
      const nextWidth = Math.round(layoutRight - moveEvent.clientX - 8);
      setSideWidth(Math.min(560, Math.max(260, nextWidth)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
  }

  function startViewerResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = event.currentTarget.parentElement
      ?.querySelector(".browser-shell")
      ?.getBoundingClientRect().height || 560;
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
    const move = (moveEvent) => {
      if (moveEvent.buttons === 0) {
        stop();
        return;
      }
      const nextHeight = Math.round(startHeight + (moveEvent.clientY - startY));
      setViewerHeight(Math.min(window.innerHeight - 180, Math.max(320, nextHeight)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
  }

  function startCallResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = event.currentTarget.previousElementSibling?.getBoundingClientRect().height || callHeight;
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
    const move = (moveEvent) => {
      if (moveEvent.buttons === 0) {
        stop();
        return;
      }
      const nextHeight = Math.round(startHeight + (moveEvent.clientY - startY));
      setCallHeight(Math.min(420, Math.max(132, nextHeight)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
  }

  const handleMediaEvent = useCallback((event) => {
    if (!room) return;
    if (event.controlledByHavyn) return;
    const isPlaybackEvent = ["play", "pause", "seeked", "ratechange"].includes(event.eventName);
    if (isPlaybackEvent && Date.now() < suppressMediaEventsUntilRef.current) return;
    const playbackApi = playbackRef.current;
    const payload = { roomId: room.roomId, userId: user.id, currentTime: event.media.currentTime };

    if (playbackApi?.canControl) {
      if (event.eventName === "play") socket.emit("playback-play", payload);
      if (event.eventName === "pause") socket.emit("playback-pause", payload);
      if (event.eventName === "seeked") socket.emit("playback-seek", payload);
      if (event.eventName === "ratechange") {
        socket.emit("playback-rate-change", { ...payload, playbackRate: event.media.playbackRate });
      }
    } else if (["play", "pause", "seeked", "ratechange"].includes(event.eventName)) {
      const command = playbackCommandFromState(playbackApi?.playbackState, "permission-restore");
      if (event.video) mediaRef.current?.applyWebPlayback(event.video, command);
      else mediaRef.current?.applyPlayback(command);
    }

    if (event.eventName === "ended") {
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
    onPlaybackState: roomState.updatePlaybackSnapshot
  });
  const mediaRef = useRef(media);

  useEffect(() => {
    mediaRef.current = media;
    playbackRef.current = playback;
  }, [media, playback]);

  useEffect(() => {
    if (!canUseFocusLayout && callLayout === "focus") setCallLayout("grid");
  }, [callLayout, canUseFocusLayout]);

  useEffect(() => {
    media.browser?.setVisible?.(!(guideOpen || devicesOpen));
    return () => media.browser?.setVisible?.(true);
  }, [devicesOpen, guideOpen, media.browser]);

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
      const playableUrl = playableSourceUrl(selected);
      if (playableUrl) {
        suppressMediaEventsUntilRef.current = Date.now() + 12_000;
        if (isCurrentPlayableSource(media.currentUrl, selected)) {
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
  }, [media, socket]);

  useEffect(() => {
    const activeUrl = playback.playbackState?.activeMediaFrameUrl || playback.playbackState?.activeMediaUrl || room.playbackState?.activeMediaFrameUrl || room.playbackState?.activeMediaUrl;
    if (!activeUrl || activeUrl === autoLoadedMediaUrlRef.current) return;
    const activeState = playback.playbackState || room.playbackState || {};
    if (isCurrentPlayableSource(media.currentUrl, {
      url: activeUrl,
      pageUrl: activeState.activeMediaPageUrl,
      frameUrl: activeState.activeMediaFrameUrl
    })) {
      autoLoadedMediaUrlRef.current = activeUrl;
      return;
    }
    autoLoadedMediaUrlRef.current = activeUrl;
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
    playback.playbackState?.activeMediaUrl,
    room.playbackState?.activeMediaFrameUrl,
    room.playbackState?.activeMediaUrl
  ]);

  useEffect(() => {
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
  }, [media.detectedMedia, playback.playbackState, room.playbackState, room.roomId, socket, user.id]);

  useEffect(() => () => {
    autoSyncTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const selectRoomMedia = useCallback((selected) => {
    const playableUrl = playableSourceUrl(selected);
    if (!playableUrl) return;
    suppressMediaEventsUntilRef.current = Date.now() + 12_000;
    const switchLocalSource = media.loadUrl(playableUrl).then(() => {
      window.setTimeout(() => media.scanMedia?.(), 700);
      window.setTimeout(() => media.scanMedia?.(), 1600);
    });

    Promise.resolve(switchLocalSource).finally(() => {
      playback.selectMedia({ ...selected, url: playableUrl });
    });
  }, [media, playback]);

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

  return (
    <main className={`watch-room ${focusMode ? "is-focus-mode" : ""} ${focusMode && !cinemaChatCollapsed ? "is-cinema-chat-open" : ""}`}>
      <header className="room-header">
        <Logo compact />
        <div className="room-title">
          <strong>{room.roomName}</strong>
          <span>Host: {room.participants.find((p) => p.userId === room.hostUserId)?.displayName || "Host"} - {room.playbackMode}</span>
        </div>
        <div className="header-actions">
          <button className="icon-button" onClick={() => setGuideOpen(true)} title="Room guide"><HelpCircle size={18} /></button>
          <button className="icon-button" onClick={toggleFocusMode} title={focusMode ? "Exit focus mode" : "Focus mode"}>
            {focusMode ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          {social && <NotificationBell user={user} social={social} onJoinRoom={roomState.joinRoom} />}
          <select className="mode-select" value={room.playbackMode} onChange={(event) => roomState.setPlaybackMode(event.target.value)}>
            <option value="host-only">host-only</option>
            <option value="host-and-cohosts">host-and-cohosts</option>
            <option value="everyone">everyone</option>
          </select>
          <button className="icon-text" onClick={copyRoomCode} title="Copy room code"><Copy size={17} /> {room.roomId}</button>
          {copyNote && <span className="header-note">{copyNote}</span>}
          <button className="icon-button" onClick={roomState.leaveRoom} title="Leave room"><LogOut size={18} /></button>
          <button className="ghost-button" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      {roomState.permissionNotice && <div className="toast">{roomState.permissionNotice}</div>}
      {social?.socialNote && <div className="toast social-toast">{social.socialNote}</div>}
      {call.callNotice && <div className="toast">{call.callNotice}</div>}
      {roomState.actionNotice && <div className="action-toast">{roomState.actionNotice}</div>}
      {focusMode && (
        <>
          <button
            className={`cinema-controls-toggle ${cinemaControlsOpen ? "is-open" : ""}`}
            type="button"
            onClick={() => setCinemaControlsOpen((value) => !value)}
            title={cinemaControlsOpen ? "Hide fullscreen controls" : "Show fullscreen controls"}
          >
            <Maximize2 size={15} />
          </button>
          <div className={`cinema-top-controls glass ${cinemaControlsOpen ? "is-open" : ""}`}>
            <button className="icon-text" type="button" onClick={toggleFocusMode}><Minimize2 size={16} /> Exit Fullscreen</button>
            <div>
              <strong>{room.playbackState?.activeMediaTitle || "Detected video"}</strong>
              <span>{room.playbackMode}</span>
            </div>
            <button
              className="first-sync-button"
              type="button"
              disabled={!playback.canControl || !playback.playbackState?.activeMediaUrl}
              onClick={playback.play}
            >
              First Sync Play
            </button>
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
          <IntegratedBrowserPanel
            className="guide-browser-target"
            browser={media.browser}
            currentUrl={media.currentUrl}
            onLoadUrl={media.loadUrl}
            activeMediaTitle={room.playbackState?.activeMediaTitle}
            onWebMediaDetected={(items, video) => {
              webVideoRef.current = video;
              media.reportWebMedia(items);
            }}
            onWebMediaEvent={handleMediaEvent}
            webPlaybackState={playback.playbackState}
            layoutSignal={focusMode ? "cinema" : "normal"}
          />
          <div className="viewer-resize-handle" title="Resize viewing area" onMouseDown={startViewerResize} onDoubleClick={() => setViewerHeight(null)} />
          <div className="viewer-toolbar">
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
              />
            </div>
          </div>
        </div>
        <div
          className="watch-resize-handle"
          role="separator"
          aria-orientation="vertical"
          title="Resize panels"
          onMouseDown={startSideResize}
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
              isPlaying={Boolean(playback.playbackState?.isPlaying || room.playbackState?.isPlaying)}
              chatOpen={focusMode && !cinemaChatCollapsed}
            />
          </section>
          <div className="side-resize-handle" title="Resize call area" onMouseDown={startCallResize} onDoubleClick={() => setCallHeight(190)} />
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
    </main>
  );
}

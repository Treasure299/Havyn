import { Copy, HelpCircle, LogOut } from "lucide-react";
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
import ParticipantsPanel from "./ParticipantsPanel";
import PlaybackControls from "./PlaybackControls";
import VideoBubbleRail from "./VideoBubbleRail";

export default function WatchRoom({ user, roomState, onSignOut }) {
  const { room, socket } = roomState;
  const call = useWebRTC({ socket, room, user });
  const playbackRef = useRef(null);
  const webVideoRef = useRef(null);
  const autoLoadedMediaUrlRef = useRef("");
  const [sideWidth, setSideWidth] = useState(336);
  const [viewerHeight, setViewerHeight] = useState(null);
  const [callHeight, setCallHeight] = useState(190);
  const [callLayout, setCallLayout] = useState("grid");
  const [focusPrimary, setFocusPrimary] = useState("remote");
  const [copyNote, setCopyNote] = useState("");
  const [guideOpen, setGuideOpen] = useState(() => localStorage.getItem("havyn:guide:watch:v1") !== "done");
  const callTileCount = (call.localStream ? 1 : 0) + call.streams.length;
  const canUseFocusLayout = call.joined && callTileCount === 2;

  function startSideResize(event) {
    event.preventDefault();
    const move = (moveEvent) => {
      const nextWidth = Math.round(window.innerWidth - moveEvent.clientX - 14);
      setSideWidth(Math.min(560, Math.max(260, nextWidth)));
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  }

  function startViewerResize(event) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = event.currentTarget.parentElement
      ?.querySelector(".browser-shell")
      ?.getBoundingClientRect().height || 560;
    const move = (moveEvent) => {
      const nextHeight = Math.round(startHeight + (moveEvent.clientY - startY));
      setViewerHeight(Math.min(window.innerHeight - 180, Math.max(320, nextHeight)));
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  }

  function startCallResize(event) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = event.currentTarget.previousElementSibling?.getBoundingClientRect().height || callHeight;
    const move = (moveEvent) => {
      const nextHeight = Math.round(startHeight + (moveEvent.clientY - startY));
      setCallHeight(Math.min(420, Math.max(132, nextHeight)));
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  }

  const handleMediaEvent = useCallback((event) => {
    if (!room) return;
    if (event.controlledByHavyn) return;
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
      if (event.video) mediaRef.current?.applyWebPlayback(event.video, playbackApi?.playbackState);
      else mediaRef.current?.applyPlayback(playbackApi?.playbackState);
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
    const handleSelected = ({ media: selected }) => {
      if (selected?.url) media.loadUrl(selected.url);
    };
    socket.on("media-selected", handleSelected);
    return () => socket.off("media-selected", handleSelected);
  }, [media, socket]);

  useEffect(() => {
    const activeUrl = playback.playbackState?.activeMediaUrl || room.playbackState?.activeMediaUrl;
    if (!activeUrl || activeUrl === autoLoadedMediaUrlRef.current) return;
    if (media.currentUrl === activeUrl) {
      autoLoadedMediaUrlRef.current = activeUrl;
      return;
    }
    autoLoadedMediaUrlRef.current = activeUrl;
    media.loadUrl(activeUrl);
  }, [media, media.currentUrl, playback.playbackState?.activeMediaUrl, room.playbackState?.activeMediaUrl]);

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
      position: "bottom-left",
      title: "Browser",
      body: "Open the page you want to watch here. Each person loads the page locally in their own Havyn browser session.",
      note: "Havyn syncs playback state. It does not stream, copy, or redistribute the video."
    },
    {
      targetClass: "guide-source-target",
      position: "bottom-left",
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
      position: "top-right",
      title: "Call",
      body: "Join optional voice/video here. You can resize this area and choose grid or focus layout for two-person calls."
    },
    {
      targetClass: "guide-chat-target",
      position: "top-right",
      title: "Chat and people",
      body: "Chat stays beside the movie. The People drawer shows who is in the room, who is host, and who is ready."
    }
  ];

  return (
    <main className="watch-room">
      <header className="room-header">
        <Logo compact />
        <div className="room-title">
          <strong>{room.roomName}</strong>
          <span>Host: {room.participants.find((p) => p.userId === room.hostUserId)?.displayName || "Host"} - {room.playbackMode}</span>
        </div>
        <div className="header-actions">
          <button className="icon-button" onClick={() => setGuideOpen(true)} title="Room guide"><HelpCircle size={18} /></button>
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
      {roomState.actionNotice && <div className="action-toast">{roomState.actionNotice}</div>}

      <section
        className="watch-layout"
        style={{ gridTemplateColumns: `minmax(520px, 1fr) 8px ${sideWidth}px` }}
      >
        <div
          className="watch-main"
          style={viewerHeight ? { gridTemplateRows: `${viewerHeight}px auto auto` } : undefined}
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
          />
          <div className="viewer-resize-handle" title="Resize viewing area" onMouseDown={startViewerResize} onDoubleClick={() => setViewerHeight(null)} />
          <div className="viewer-toolbar">
            <div className="guide-source-target">
              <MediaDetectionPanel
                detectedMedia={media.detectedMedia}
                canControl={playback.canControl}
                onSelect={playback.selectMedia}
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
          style={{ gridTemplateRows: `${callHeight}px 8px minmax(0, 1fr) auto` }}
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
              <CallControls call={call} />
            </div>
            <VideoBubbleRail call={call} participants={room.participants} layout={callLayout} focusPrimary={focusPrimary} />
          </section>
          <div className="side-resize-handle" title="Resize call area" onMouseDown={startCallResize} onDoubleClick={() => setCallHeight(190)} />
          <div className="guide-chat-target side-stack">
            <ChatPanel messages={roomState.messages} onSend={roomState.sendMessage} />
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
          setGuideOpen(false);
        }}
      />
    </main>
  );
}

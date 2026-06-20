import { Mic, MicOff, Video, VideoOff, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function VideoBubble({ label, stream, muted, cameraOff, remote, call, className = "", onCollapse }) {
  const ref = useRef(null);
  const [volume, setVolume] = useState(0.72);
  const isAudioMuted = muted || !stream?.getAudioTracks?.().some((track) => track.enabled && track.readyState === "live");
  const hasLiveVideo = stream?.getVideoTracks?.().some((track) => track.enabled && track.readyState === "live");

  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.volume = remote ? volume : 0;
  }, [remote, volume]);

  return (
    <div className={`video-bubble ${className}`}>
      <video ref={ref} autoPlay playsInline muted={!remote || muted} />
      <span>{label}</span>
      {cameraOff && !hasLiveVideo && <em>Camera off</em>}
      <div className="bubble-quick-controls" onPointerDown={(event) => event.stopPropagation()}>
        {!remote ? (
          <>
            <button type="button" onClick={call?.toggleMute} title={muted ? "Unmute mic" : "Mute mic"}>
              {muted ? <MicOff size={12} /> : <Mic size={12} />}
            </button>
            <button type="button" onClick={call?.toggleCamera} title={cameraOff ? "Turn camera on" : "Turn camera off"}>
              {cameraOff ? <VideoOff size={12} /> : <Video size={12} />}
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled title={isAudioMuted ? "Not transmitting audio" : "Audio active"}>
              {isAudioMuted ? <MicOff size={12} /> : <Mic size={12} />}
            </button>
            <button type="button" disabled title={cameraOff ? "Camera off" : "Camera on"}>
              {cameraOff ? <VideoOff size={12} /> : <Video size={12} />}
            </button>
          </>
        )}
      </div>
      {onCollapse && (
        <button
          className="bubble-collapse-button"
          type="button"
          title="Collapse tile"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onCollapse}
        >
          <X size={14} />
        </button>
      )}
      {remote && (
        <div className="volume-hover" onPointerDown={(event) => event.stopPropagation()}>
          <div>
            {isAudioMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            <small>{isAudioMuted ? "Not transmitting audio" : `${Math.round(volume * 100)}%`}</small>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            disabled={isAudioMuted}
            onChange={(event) => setVolume(Number(event.target.value))}
            aria-label={`${label} volume`}
          />
        </div>
      )}
    </div>
  );
}

function CollapsedStreamKeeper({ stream, muted, remote }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream;
  }, [stream]);

  return (
    <video
      className="collapsed-stream-keeper"
      ref={ref}
      autoPlay
      playsInline
      muted={!remote || muted}
    />
  );
}

function FloatingBubble({ tile, index, isPlaying, rightInset = 0 }) {
  const [frame, setFrame] = useState({ x: window.innerWidth - 326, y: 96 + index * 172, width: 276 });
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef(null);
  const movedRef = useRef(false);
  const previousRightInsetRef = useRef(rightInset);
  const restoreFrameRef = useRef(null);

  function clampFrame(nextFrame, nextCollapsed = collapsed) {
    const width = nextCollapsed ? Math.min(nextFrame.width, 210) : nextFrame.width;
    const height = nextCollapsed ? 38 : width * 9 / 16;
    const maxX = Math.max(18, window.innerWidth - rightInset - width - 18);
    const maxY = Math.max(18, window.innerHeight - height - 18);
    return {
      ...nextFrame,
      x: Math.min(maxX, Math.max(18, nextFrame.x)),
      y: Math.min(maxY, Math.max(18, nextFrame.y))
    };
  }

  useEffect(() => {
    const previousRightInset = previousRightInsetRef.current;
    previousRightInsetRef.current = rightInset;

    if (rightInset > previousRightInset) {
      setFrame((current) => {
        restoreFrameRef.current = current;
        return clampFrame(current);
      });
      return;
    }

    if (rightInset < previousRightInset && restoreFrameRef.current) {
      const restoreFrame = restoreFrameRef.current;
      restoreFrameRef.current = null;
      setFrame(clampFrame(restoreFrame));
    }
  }, [rightInset]);

  useEffect(() => {
    const clamp = () => setFrame((current) => clampFrame(current));
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [rightInset, collapsed]);

  function startDrag(event) {
    if (!event.isPrimary || event.button !== 0) return;
    if (!collapsed && event.target.closest?.(".bubble-quick-controls, .volume-hover, input, button")) return;
    if (collapsed && event.target.closest?.("input")) return;
    event.preventDefault();
    dragRef.current = {
      type: "move",
      startX: event.clientX,
      startY: event.clientY,
      frame,
      handle: event.currentTarget,
      pointerId: event.pointerId
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    movedRef.current = false;
    document.body.classList.add("is-resizing", "is-moving-tile");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  function startResize(event) {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      type: "resize",
      startX: event.clientX,
      frame,
      handle: event.currentTarget,
      pointerId: event.pointerId
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add("is-resizing", "is-resizing-tile");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  function move(event) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.type === "move") {
      movedRef.current = movedRef.current || Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3;
      setFrame(clampFrame({
        ...drag.frame,
        x: drag.frame.x + event.clientX - drag.startX,
        y: drag.frame.y + event.clientY - drag.startY
      }));
    } else {
      const availableWidth = Math.max(180, window.innerWidth - rightInset - drag.frame.x - 18);
      const width = Math.min(360, availableWidth, Math.max(180, drag.frame.width + event.clientX - drag.startX));
      setFrame(clampFrame({ ...drag.frame, width }, false));
    }
  }

  function stop() {
    const drag = dragRef.current;
    const shouldRestore = collapsed && !movedRef.current;
    if (movedRef.current && rightInset > 0) restoreFrameRef.current = null;
    if (drag?.handle?.hasPointerCapture?.(drag.pointerId)) {
      drag.handle.releasePointerCapture?.(drag.pointerId);
    }
    dragRef.current = null;
    document.body.classList.remove("is-resizing", "is-moving-tile", "is-resizing-tile");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("blur", stop);
    if (shouldRestore) setCollapsed(false);
  }

  return (
    <div
      className={`floating-video-bubble ${collapsed ? "is-collapsed" : ""} ${isPlaying ? "media-is-playing" : "media-is-paused"}`}
      style={{ width: collapsed ? Math.min(frame.width, 210) : frame.width, transform: `translate(${frame.x}px, ${frame.y}px)` }}
      onPointerDown={startDrag}
    >
      {collapsed ? (
        <>
          <CollapsedStreamKeeper stream={tile.stream} muted={tile.muted} remote={tile.remote} />
          <div
            className="collapsed-video-bar"
            role="button"
            tabIndex={0}
            title={`Restore ${tile.label}`}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setCollapsed(false);
              }
            }}
          >
            <button
              type="button"
              title={tile.muted ? "Unmute mic" : "Mute mic"}
              disabled={tile.remote}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                tile.call?.toggleMute?.();
              }}
            >
              {tile.muted ? <MicOff size={12} /> : <Mic size={12} />}
            </button>
            <button
              type="button"
              title={tile.cameraOff ? "Turn camera on" : "Turn camera off"}
              disabled={tile.remote}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                tile.call?.toggleCamera?.();
              }}
            >
              {tile.cameraOff ? <VideoOff size={12} /> : <Video size={12} />}
            </button>
            <span>{tile.label}</span>
          </div>
        </>
      ) : (
        <>
          <VideoBubble {...tile} onCollapse={() => setCollapsed(true)} />
          <i className="bubble-resize-handle" onPointerDown={startResize} />
        </>
      )}
    </div>
  );
}

export default function VideoBubbleRail({ call, participants, layout = "grid", focusPrimary = "remote", floating = false, isPlaying = false, chatOpen = false }) {
  if (!call.joined) {
    return (
      <div className="video-rail video-rail-empty">
        <div className="video-bubble placeholder-bubble"><span>Join call</span></div>
        <div className="video-bubble placeholder-bubble"><span>Up to 4</span></div>
      </div>
    );
  }
  const tiles = [
    call.localStream && {
      id: "local",
      kind: "local",
      label: "You",
      stream: call.localStream,
      muted: call.muted,
      cameraOff: call.cameraOff,
      call
    },
    ...call.streams.map((item) => {
      const participant = participants.find((person) => person.userId === item.userId);
      return {
        id: item.userId,
        kind: "remote",
        label: participant?.displayName || "Guest",
        stream: item.stream,
        muted: participant?.muted,
        cameraOff: participant?.cameraOff,
        remote: true
      };
    })
  ].filter(Boolean);
  const actualLayout = layout === "focus" && tiles.length === 2 ? "focus" : "grid";
  const orderedTiles = actualLayout === "focus"
    ? [...tiles].sort((a, b) => (a.kind === focusPrimary ? -1 : b.kind === focusPrimary ? 1 : 0))
    : tiles;

  if (floating) {
    const rightInset = chatOpen ? Math.min(378, window.innerWidth * 0.31) : 0;
    return (
      <div className="video-float-layer" data-count={tiles.length}>
        {orderedTiles.map((tile, index) => (
          <FloatingBubble key={tile.id} index={index} tile={tile} isPlaying={isPlaying} rightInset={rightInset} />
        ))}
      </div>
    );
  }

  return (
    <div className={`video-rail video-layout-${actualLayout}`} data-count={tiles.length}>
      {orderedTiles.map((tile, index) => (
        <div key={tile.id} className={actualLayout === "focus" ? (index === 0 ? "focus-primary" : "focus-secondary") : ""}>
          <VideoBubble {...tile} />
        </div>
      ))}
    </div>
  );
}

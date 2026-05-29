import { Mic, MicOff, Video, VideoOff, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function VideoBubble({ label, stream, muted, cameraOff, remote, call, className = "" }) {
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

function FloatingBubble({ children, index }) {
  const [frame, setFrame] = useState({ x: 0, y: index * 152, width: 250 });
  const dragRef = useRef(null);

  function startDrag(event) {
    if (event.target.closest?.(".bubble-quick-controls, .volume-hover, input, button")) return;
    event.preventDefault();
    dragRef.current = {
      type: "move",
      startX: event.clientX,
      startY: event.clientY,
      frame
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function startResize(event) {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      type: "resize",
      startX: event.clientX,
      frame
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function move(event) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.type === "move") {
      setFrame({
        ...drag.frame,
        x: Math.min(70, Math.max(-220, drag.frame.x + event.clientX - drag.startX)),
        y: Math.min(window.innerHeight - 180, Math.max(0, drag.frame.y + event.clientY - drag.startY))
      });
    } else {
      const width = Math.min(360, Math.max(180, drag.frame.width + event.clientX - drag.startX));
      setFrame({ ...drag.frame, width });
    }
  }

  function stop() {
    dragRef.current = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
  }

  return (
    <div
      className="floating-video-bubble"
      style={{ width: frame.width, transform: `translate(${frame.x}px, ${frame.y}px)` }}
      onPointerDown={startDrag}
    >
      {children}
      <i className="bubble-resize-handle" onPointerDown={startResize} />
    </div>
  );
}

export default function VideoBubbleRail({ call, participants, layout = "grid", focusPrimary = "remote", floating = false }) {
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
      node: <VideoBubble label="You" stream={call.localStream} muted={call.muted} cameraOff={call.cameraOff} call={call} />
    },
    ...call.streams.map((item) => {
      const participant = participants.find((person) => person.userId === item.userId);
      return {
        id: item.userId,
        kind: "remote",
        node: (
          <VideoBubble
            label={participant?.displayName || "Guest"}
            stream={item.stream}
            muted={participant?.muted}
            cameraOff={participant?.cameraOff}
            remote
          />
        )
      };
    })
  ].filter(Boolean);
  const actualLayout = layout === "focus" && tiles.length === 2 ? "focus" : "grid";
  const orderedTiles = actualLayout === "focus"
    ? [...tiles].sort((a, b) => (a.kind === focusPrimary ? -1 : b.kind === focusPrimary ? 1 : 0))
    : tiles;

  if (floating) {
    return (
      <div className="video-float-layer" data-count={tiles.length}>
        {orderedTiles.map((tile, index) => (
          <FloatingBubble key={tile.id} index={index}>{tile.node}</FloatingBubble>
        ))}
      </div>
    );
  }

  return (
    <div className={`video-rail video-layout-${actualLayout}`} data-count={tiles.length}>
      {orderedTiles.map((tile, index) => (
        <div key={tile.id} className={actualLayout === "focus" ? (index === 0 ? "focus-primary" : "focus-secondary") : ""}>
          {tile.node}
        </div>
      ))}
    </div>
  );
}

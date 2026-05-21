import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function VideoBubble({ label, stream, muted, cameraOff, remote, className = "" }) {
  const ref = useRef(null);
  const [volume, setVolume] = useState(0.72);
  const isAudioMuted = muted || !stream?.getAudioTracks?.().some((track) => track.enabled && track.readyState === "live");

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
      {cameraOff && <em>Camera off</em>}
      {remote && (
        <div className="volume-hover">
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

export default function VideoBubbleRail({ call, participants, layout = "grid", focusPrimary = "remote" }) {
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
      node: <VideoBubble label="You" stream={call.localStream} muted cameraOff={call.cameraOff} />
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

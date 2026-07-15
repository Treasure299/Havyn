import { Maximize2, Minimize2, MonitorUp, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export default function LiveShareSurface({ share, focusMode, onToggleFocus }) {
  const videoRef = useRef(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [fit, setFit] = useState("contain");
  const stream = share.isHosting ? share.localStream : share.remoteStream;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream || null;
    video.muted = share.isHosting || share.viewerMuted;
    video.volume = share.viewerVolume;
    if (!stream) return;
    video.play().then(() => setNeedsGesture(false)).catch(() => setNeedsGesture(true));
  }, [share.isHosting, share.viewerMuted, share.viewerVolume, stream]);

  return (
    <section className="live-share-surface">
      <video ref={videoRef} autoPlay playsInline className={`live-share-video fit-${fit}`} />
      {!stream && <div className="live-share-connecting"><MonitorUp size={30} /><strong>Connecting to Live Share...</strong></div>}
      <div className="live-share-badge"><i /> LIVE <span>{share.isHosting ? "You are sharing" : "Host screen"}</span></div>
      {needsGesture && (
        <button className="live-share-hear" type="button" onClick={() => videoRef.current?.play().then(() => setNeedsGesture(false))}>
          <Volume2 size={17} /> Click to hear Live Share
        </button>
      )}
      <div className="live-share-controls glass">
        {!share.isHosting && (
          <>
            <button className="icon-button" type="button" onClick={() => share.setViewerMuted(!share.viewerMuted)} title={share.viewerMuted ? "Unmute shared audio" : "Mute shared audio"}>
              {share.viewerMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </button>
            <input
              aria-label="Live Share volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={share.viewerVolume}
              onChange={(event) => share.setViewerVolume(Number(event.target.value))}
            />
          </>
        )}
        <button className="icon-button" type="button" onClick={() => setFit((value) => value === "contain" ? "cover" : "contain")} title="Change fit"><MonitorUp size={17} /></button>
        <button className="icon-button" type="button" onClick={onToggleFocus} title={focusMode ? "Exit fullscreen" : "Fullscreen"}>
          {focusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
        <button className="danger-button live-share-end-button" type="button" onClick={share.isHosting ? share.stopShare : share.leaveShare}>
          <X size={16} /> {share.isHosting ? "Stop sharing" : "Leave"}
        </button>
      </div>
    </section>
  );
}

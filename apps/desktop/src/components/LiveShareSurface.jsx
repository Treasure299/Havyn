import { GripHorizontal, Maximize2, Minimize2, MonitorUp, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

function clampPosition(position, surface, controls) {
  return {
    x: Math.max(8, Math.min(position.x, Math.max(8, surface.width - controls.width - 8))),
    y: Math.max(8, Math.min(position.y, Math.max(8, surface.height - controls.height - 8)))
  };
}

export default function LiveShareSurface({ share, focusMode, onToggleFocus }) {
  const videoRef = useRef(null);
  const surfaceRef = useRef(null);
  const controlsRef = useRef(null);
  const dragRef = useRef(null);
  const idleTimerRef = useRef(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [fit, setFit] = useState("contain");
  const [controlsPosition, setControlsPosition] = useState(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const stream = share.isHosting ? share.localStream : share.remoteStream;

  const showControls = useCallback(() => {
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    setControlsVisible(true);
    idleTimerRef.current = window.setTimeout(() => {
      if (!dragRef.current) setControlsVisible(false);
    }, 2200);
  }, []);

  useEffect(() => {
    showControls();
    return () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [showControls]);

  useEffect(() => {
    const move = (event) => {
      const drag = dragRef.current;
      const surface = surfaceRef.current?.getBoundingClientRect();
      const controls = controlsRef.current?.getBoundingClientRect();
      if (!drag || !surface || !controls) return;
      setControlsPosition(clampPosition({
        x: drag.originX + event.clientX - drag.pointerX,
        y: drag.originY + event.clientY - drag.pointerY
      }, surface, controls));
    };
    const end = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      showControls();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [showControls]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const controls = controlsRef.current;
    if (!surface || !controls) return undefined;
    const keepInBounds = () => {
      if (!controlsPosition) return;
      setControlsPosition((current) => current && clampPosition(
        current,
        surface.getBoundingClientRect(),
        controls.getBoundingClientRect()
      ));
    };
    const observer = new ResizeObserver(keepInBounds);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [controlsPosition]);

  const startDrag = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const surface = surfaceRef.current?.getBoundingClientRect();
    const controls = controlsRef.current?.getBoundingClientRect();
    if (!surface || !controls) return;
    const origin = controlsPosition || {
      x: controls.left - surface.left,
      y: controls.top - surface.top
    };
    setControlsPosition(origin);
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: origin.x,
      originY: origin.y
    };
    showControls();
  };

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
    <section className="live-share-surface" ref={surfaceRef}>
      <video ref={videoRef} autoPlay playsInline className={`live-share-video fit-${fit}`} />
      {!stream && <div className="live-share-connecting"><MonitorUp size={30} /><strong>Connecting to Live Share...</strong></div>}
      <div className="live-share-badge"><i /> LIVE <span>{share.isHosting ? "You are sharing" : "Host screen"}</span></div>
      {needsGesture && (
        <button className="live-share-hear" type="button" onClick={() => videoRef.current?.play().then(() => setNeedsGesture(false))}>
          <Volume2 size={17} /> Click to hear Live Share
        </button>
      )}
      <div
        ref={controlsRef}
        className={`live-share-controls glass ${controlsVisible ? "is-visible" : "is-idle"}`}
        style={controlsPosition ? { left: controlsPosition.x, top: controlsPosition.y, bottom: "auto", transform: "none" } : undefined}
        onPointerEnter={showControls}
        onFocusCapture={showControls}
      >
        <button className="live-share-drag-handle" type="button" title="Move controls" aria-label="Move Live Share controls" onPointerDown={startDrag}>
          <GripHorizontal size={17} />
        </button>
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

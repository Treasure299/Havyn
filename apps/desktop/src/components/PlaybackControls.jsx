import { Lock, Pause, Play } from "lucide-react";

function syncLabel({ canControl, playbackMode }) {
  if (playbackMode === "everyone") return "Everyone can control";
  if (playbackMode === "host-and-cohosts") return canControl ? "You can control" : "Host and cohosts control";
  return canControl ? "You control playback" : "Host controls playback";
}

export default function PlaybackControls({ canControl, playbackMode, playbackState, onPlay, onPause }) {
  const isPlaying = playbackState?.isPlaying;
  const hasMedia = Boolean(playbackState?.activeMediaUrl);

  return (
    <div className="sync-strip">
      <span><Lock size={14} /> {syncLabel({ canControl, playbackMode })}</span>
      <button
        className={`first-sync-button ${isPlaying ? "is-playing" : ""}`}
        disabled={!canControl || !hasMedia}
        onClick={isPlaying ? onPause : onPlay}
        title={isPlaying ? "Pause synced playback" : "First Sync Play"}
      >
        {isPlaying ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
        <strong>{isPlaying ? "Pause" : "First Sync Play"}</strong>
      </button>
    </div>
  );
}

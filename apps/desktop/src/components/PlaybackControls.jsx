import { Lock, Pause, Play, RefreshCw } from "lucide-react";

function syncLabel({ canControl, playbackMode }) {
  if (playbackMode === "everyone") return "Everyone can control";
  if (playbackMode === "host-and-cohosts") return canControl ? "You can control" : "Host and cohosts control";
  return canControl ? "You control playback" : "Host controls playback";
}

export default function PlaybackControls({ canControl, playbackMode, playbackState, onPlay, onPause, canResync = false, onResync }) {
  const isPlaying = playbackState?.isPlaying;
  const hasMedia = Boolean(playbackState?.activeMediaUrl);

  return (
    <div className="sync-strip">
      <span><Lock size={14} /> {syncLabel({ canControl, playbackMode })}</span>
      {canResync && (
        <button className="resync-room-button" type="button" disabled={!hasMedia} onClick={onResync} title="Load the room's current media and timestamp">
          <RefreshCw size={14} />
          <strong>Resync to room</strong>
        </button>
      )}
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

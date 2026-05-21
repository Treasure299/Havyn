import { Lock, Pause, Play } from "lucide-react";

export default function PlaybackControls({ canControl, playbackState, onPlay, onPause }) {
  const isPlaying = playbackState?.isPlaying;

  return (
    <div className="sync-strip">
      <span><Lock size={14} /> {canControl ? "Host sync ready" : "Synced by host"}</span>
      <button className="mini-play-button" disabled={!canControl} onClick={isPlaying ? onPause : onPlay} title={isPlaying ? "Pause room" : "Play room"}>
        {isPlaying ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
      </button>
    </div>
  );
}

import { CheckCircle2, Radar, Radio } from "lucide-react";

export default function MediaDetectionPanel({ detectedMedia, canControl, onSelect, onScan }) {
  const first = detectedMedia[0];
  return (
    <div className="glass media-detection">
      <div>
        <span className="eyebrow"><Radio size={14} /> Source</span>
        <strong>{first ? "Ready to sync" : "Looking for video"}</strong>
      </div>
      <button className="icon-button subtle-icon" type="button" title="Scan again" onClick={onScan}>
        <Radar size={16} />
      </button>
      {first && (
        <button className="secondary-button" disabled={!canControl} onClick={() => onSelect(first)}>
          <CheckCircle2 size={16} /> Sync source
        </button>
      )}
    </div>
  );
}

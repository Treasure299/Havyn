import { Monitor, Volume2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export default function LiveSharePicker({ open, starting, onClose, onStart }) {
  const [sources, setSources] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [withAudio, setWithAudio] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    window.havyn?.screenShare?.getSources?.()
      .then((items = []) => {
        setSources(items);
        setSelectedId(items[0]?.id || "");
        if (!items.length) setError("No screens or windows are available to share.");
      })
      .catch(() => setError("Havyn could not load the screen picker."))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="live-share-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="live-share-picker glass" role="dialog" aria-modal="true" aria-labelledby="live-share-title">
        <header>
          <div>
            <span className="live-kicker">LIVE SHARE</span>
            <h2 id="live-share-title">Choose what to share</h2>
            <p>Only the selected screen or window is captured.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close"><X size={18} /></button>
        </header>
        {loading ? <div className="live-share-picker-loading">Finding available screens...</div> : (
          <div className="live-share-source-grid">
            {sources.map((source) => (
              <button
                key={source.id}
                className={`live-share-source ${selectedId === source.id ? "is-selected" : ""}`}
                type="button"
                onClick={() => setSelectedId(source.id)}
              >
                <span className="live-share-source-preview">
                  {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <Monitor size={28} />}
                </span>
                <span><Monitor size={14} /> {source.name}</span>
                {source.type === "browser-region" && <small>Share only the embedded browser</small>}
              </button>
            ))}
          </div>
        )}
        <label className="live-share-audio-option">
          <input type="checkbox" checked={withAudio} onChange={(event) => setWithAudio(event.target.checked)} />
          <Volume2 size={17} />
          <span>Include system audio when available</span>
        </label>
        {selectedId === "havyn:browser-region" && (
          <p className="live-share-browser-note">System audio may include sound from other open apps.</p>
        )}
        {error && <p className="live-share-error">{error}</p>}
        <footer>
          <button className="ghost-button" type="button" onClick={onClose}>Cancel</button>
          <button
            className="primary-button"
            type="button"
            disabled={!selectedId || starting}
            onClick={async () => {
              const started = await onStart({ sourceId: selectedId, withAudio });
              if (started) onClose();
            }}
          >
            <Monitor size={17} /> {starting ? "Starting..." : "Start Live Share"}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

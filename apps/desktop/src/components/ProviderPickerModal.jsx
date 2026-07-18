import { Check, ExternalLink, Play, X } from "lucide-react";
import { createPortal } from "react-dom";
import { providerDestination } from "../lib/contentCatalog";

const accessLabels = {
  subscription: "Included with subscription",
  free: "Free or ad-supported",
  rent: "Rent",
  buy: "Buy"
};

export default function ProviderPickerModal({ movie, availability, busy, onCancel, onSelect }) {
  const providers = availability?.providers || [];
  return createPortal(
    <div className="modal-backdrop provider-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="modal glass provider-picker" role="dialog" aria-modal="true" aria-labelledby="provider-picker-title">
        <button className="icon-button provider-close" type="button" title="Close" onClick={onCancel}><X size={17} /></button>
        <span className="section-eyebrow">AVAILABLE IN {availability?.region || "YOUR REGION"}</span>
        <h2 id="provider-picker-title">Choose where to watch</h2>
        <p>Select a provider for <strong>{movie.title}</strong>. Everyone uses their own provider account.</p>
        <div className="provider-options">
          {providers.map((provider) => {
            const destination = providerDestination(provider, movie.title);
            return (
              <button
                className="provider-option"
                type="button"
                key={provider.id}
                disabled={busy || !destination}
                onClick={() => onSelect({ ...provider, destination })}
              >
                <span className="provider-logo-shell">
                  {provider.logoUrl ? <img src={provider.logoUrl} alt="" /> : <Play size={18} />}
                </span>
                <span>
                  <strong>{provider.name}</strong>
                  <small>{provider.accessTypes.map((type) => accessLabels[type] || type).join(" · ")}</small>
                </span>
                {destination ? <ExternalLink size={17} /> : <span className="provider-unavailable">Open manually</span>}
              </button>
            );
          })}
        </div>
        <div className="provider-picker-foot">
          <span><Check size={14} /> Availability data provided by JustWatch</span>
          <button className="ghost-button" type="button" disabled={busy} onClick={() => onSelect(null)}>Create room without a URL</button>
        </div>
      </section>
    </div>,
    document.body
  );
}


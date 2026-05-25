import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

export default function InteractiveGuide({ storageKey, steps, open, onClose }) {
  const [index, setIndex] = useState(0);
  const step = steps[index];

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const highlightClass = useMemo(() => step?.targetClass || "", [step]);

  useEffect(() => {
    if (!open || !highlightClass) return undefined;
    const nodes = Array.from(document.querySelectorAll(`.${highlightClass}`));
    nodes.forEach((node) => node.classList.add("guide-highlight"));
    return () => nodes.forEach((node) => node.classList.remove("guide-highlight"));
  }, [highlightClass, open]);

  if (!open || !step) return null;

  const done = () => {
    if (storageKey) localStorage.setItem(storageKey, "done");
    onClose();
  };

  const lastStep = index === steps.length - 1;

  return createPortal(
    <section className="guide-overlay">
      <button className="guide-scrim" type="button" onClick={done} aria-label="Skip guide" />
      <aside className={`guide-card glass guide-card-${step.position || "center"}`}>
        <div className="guide-card-head">
          <span>{index + 1} / {steps.length}</span>
          <button className="icon-button" type="button" onClick={done} title="Skip guide"><X size={15} /></button>
        </div>
        <h2>{step.title}</h2>
        <p>{step.body}</p>
        {step.note && <small>{step.note}</small>}
        <div className="guide-actions">
          <button className="ghost-button" type="button" onClick={done}>Skip</button>
          <button className="secondary-button" type="button" disabled={index === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))}>
            <ChevronLeft size={16} /> Back
          </button>
          <button className="primary-button" type="button" onClick={() => lastStep ? done() : setIndex((value) => value + 1)}>
            {lastStep ? "Done" : "Next"} {!lastStep && <ChevronRight size={16} />}
          </button>
        </div>
      </aside>
    </section>,
    document.body
  );
}

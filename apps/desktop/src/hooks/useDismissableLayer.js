import { useEffect } from "react";

export function useDismissableLayer(open, refs, onDismiss) {
  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      const target = event.target;
      const isInside = refs.some((ref) => ref.current?.contains(target));
      if (!isInside) onDismiss?.();
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") onDismiss?.();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, refs, onDismiss]);
}

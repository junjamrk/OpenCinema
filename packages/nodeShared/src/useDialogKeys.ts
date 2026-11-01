import { useEffect, useRef, type KeyboardEvent } from "react";

export function useDialogKeys(visible: boolean, onClose: () => void) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, [visible]);
  function onEscape(event: KeyboardEvent) {
    if (event.code !== "Escape" || event.defaultPrevented) return;
    if ((event.target as HTMLElement).matches("input, textarea, select")) dialog.current?.focus();
    else onClose();
  }
  return { dialog, onEscape };
}

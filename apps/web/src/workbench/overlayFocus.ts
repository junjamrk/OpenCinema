import type { KeyboardEvent } from "react";

export function trapOverlayFocus(event: { key: string; target: EventTarget | null; currentTarget: EventTarget | null; shiftKey: boolean; preventDefault(): void }) {
  if (event.key !== "Tab") return;
  if (!(event.currentTarget instanceof HTMLElement)) return;
  if (event.target instanceof Element && event.target.closest("dialog, [role='dialog']") !== event.currentTarget) return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1']), [contenteditable='true']"))
    .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" && !element.closest("[inert]"));
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

export function menuKeyDown(event: KeyboardEvent<HTMLElement>, close: () => void) {
  if (event.nativeEvent.isComposing) return;
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") event.preventDefault();
    event.stopPropagation(); close(); return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not(:disabled)"));
  if (!items.length) return;
  event.preventDefault(); event.stopPropagation();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

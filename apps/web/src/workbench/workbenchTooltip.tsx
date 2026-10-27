import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

type TooltipTarget = {
  element: HTMLElement;
  title: string;
  mode: "pointer" | "focus";
  description?: string | null;
  describedValue?: string;
};

type TooltipPosition = { text: string; left: number; top: number; positioned: boolean };

export default function WorkbenchTooltip({ containerRef }: { containerRef?: RefObject<HTMLElement | null> }) {
  const tooltipId = useId();
  const active = useRef<TooltipTarget | null>(null);
  const tooltipElement = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipPosition | null>(null);

  useEffect(() => {
    const root = containerRef?.current ?? document.querySelector<HTMLElement>(".openCinemaWorkbench");
    if (!root) return;
    setContainer(root);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    let pointerFocus = false;

    function clear() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      observer?.disconnect();
      observer = undefined;
      const target = active.current;
      active.current = null;
      if (target) {
        if (target.element.getAttribute("title") === "") target.element.setAttribute("title", target.title);
        if (target.describedValue !== undefined) {
          const current = target.element.getAttribute("aria-describedby");
          if (current === target.describedValue) {
            if (target.description === null) target.element.removeAttribute("aria-describedby");
            else target.element.setAttribute("aria-describedby", target.description ?? "");
          } else if (current?.split(/\s+/).includes(tooltipId)) {
            const remaining = current.split(/\s+/).filter(value => value && value !== tooltipId).join(" ");
            if (remaining) target.element.setAttribute("aria-describedby", remaining);
            else target.element.removeAttribute("aria-describedby");
          }
        }
      }
      setTooltip(null);
    }

    function available(element: HTMLElement) {
      return element.isConnected && root!.contains(element) && element.getClientRects().length > 0 &&
        !element.closest("[disabled], [aria-disabled='true'], [hidden], [inert]") && getComputedStyle(element).visibility !== "hidden";
    }

    function findTarget(value: EventTarget | null) {
      if (!(value instanceof Element)) return null;
      if (active.current?.element.contains(value)) return active.current.element;
      const preferred = value.closest("button[title], a[title]");
      const candidate = preferred ?? value.closest("[title]");
      const element = candidate instanceof HTMLElement ? candidate : candidate?.parentElement?.closest<HTMLElement>("[title]");
      return element && element.getAttribute("title")?.trim() && available(element) ? element : null;
    }

    function show(target: TooltipTarget) {
      timer = undefined;
      if (active.current !== target) return;
      if (!available(target.element)) { clear(); return; }
      if (target.describedValue === undefined) {
        target.description = target.element.getAttribute("aria-describedby");
        target.describedValue = `${target.description ? `${target.description} ` : ""}${tooltipId}`;
        target.element.setAttribute("aria-describedby", target.describedValue);
      }
      setTooltip({ text: target.title, left: 0, top: 0, positioned: false });
    }

    function activate(element: HTMLElement, mode: TooltipTarget["mode"]) {
      if (active.current?.element === element) {
        if (mode === "focus") { active.current.mode = mode; if (timer) clearTimeout(timer); show(active.current); }
        return;
      }
      clear();
      const title = element.getAttribute("title");
      if (!title?.trim()) return;
      const target: TooltipTarget = { element, title, mode };
      active.current = target;
      // Empty title also suppresses a parent's inherited native tooltip.
      element.setAttribute("title", "");
      observer = new MutationObserver(() => {
        if (active.current !== target) return;
        if (!available(element)) { clear(); return; }
        const changedTitle = element.getAttribute("title");
        if (changedTitle === "") return;
        if (!changedTitle?.trim()) { clear(); return; }
        target.title = changedTitle;
        element.setAttribute("title", "");
        if (!timer) show(target);
      });
      observer.observe(element, { attributes: true, attributeFilter: ["title", "disabled", "aria-disabled", "hidden"] });
      observer.observe(root!, { childList: true, subtree: true });
      if (mode === "focus") show(target);
      else timer = setTimeout(() => show(target), 350);
    }

    function pointerOver(event: PointerEvent) {
      if (event.pointerType === "touch") return;
      const target = findTarget(event.target);
      if (target) activate(target, "pointer");
    }

    function pointerOut(event: PointerEvent) {
      const target = active.current;
      if (target?.mode === "pointer" && event.target instanceof Node && target.element.contains(event.target) &&
          !(event.relatedTarget instanceof Node && target.element.contains(event.relatedTarget))) clear();
    }

    function focusIn(event: FocusEvent) {
      if (pointerFocus) return;
      const target = findTarget(event.target);
      if (target) activate(target, "focus");
    }

    function focusOut(event: FocusEvent) {
      const target = active.current;
      if (target && event.target instanceof Node && target.element.contains(event.target) &&
          !(event.relatedTarget instanceof Node && target.element.contains(event.relatedTarget))) clear();
    }

    function keyDown() { pointerFocus = false; clear(); }
    function pointerDown() { pointerFocus = true; clear(); }

    root.addEventListener("pointerover", pointerOver);
    root.addEventListener("pointerout", pointerOut);
    root.addEventListener("focusin", focusIn);
    root.addEventListener("focusout", focusOut);
    document.addEventListener("scroll", clear, true);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("resize", clear);
    window.addEventListener("blur", clear);
    window.visualViewport?.addEventListener("resize", clear);
    window.visualViewport?.addEventListener("scroll", clear);
    return () => {
      clear();
      root.removeEventListener("pointerover", pointerOver);
      root.removeEventListener("pointerout", pointerOut);
      root.removeEventListener("focusin", focusIn);
      root.removeEventListener("focusout", focusOut);
      document.removeEventListener("scroll", clear, true);
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("resize", clear);
      window.removeEventListener("blur", clear);
      window.visualViewport?.removeEventListener("resize", clear);
      window.visualViewport?.removeEventListener("scroll", clear);
    };
  }, [containerRef, tooltipId]);

  useLayoutEffect(() => {
    if (!tooltip || tooltip.positioned || !tooltipElement.current || !active.current) return;
    const anchor = active.current.element.getBoundingClientRect();
    const bounds = tooltipElement.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
    const topEdge = (viewport?.offsetTop ?? 0) + 8;
    const rightEdge = leftEdge + (viewport?.width ?? document.documentElement.clientWidth) - 16;
    const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
    const left = Math.max(leftEdge, Math.min(rightEdge - bounds.width, anchor.left + (anchor.width - bounds.width) / 2));
    const preferredTop = anchor.bottom + 8 + bounds.height <= bottomEdge ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
    const top = Math.max(topEdge, Math.min(bottomEdge - bounds.height, preferredTop));
    setTooltip(current => current ? { ...current, left, top, positioned: true } : null);
  }, [tooltip]);

  if (!tooltip || !container) return null;
  const dialog = active.current?.element.closest<HTMLElement>("dialog[open]");
  return createPortal(<div ref={tooltipElement} id={tooltipId} className="workbenchTooltip" role="tooltip" style={{ position: "fixed", left: tooltip.left, top: tooltip.top, maxWidth: "min(280px, calc(100vw - 16px))", maxHeight: "calc(100vh - 16px)", overflow: "hidden", pointerEvents: "none", visibility: tooltip.positioned ? "visible" : "hidden" }}>{tooltip.text}</div>, dialog && container.contains(dialog) ? dialog : container);
}

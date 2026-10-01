import { useEffect, useRef } from "react";
import type { PropsWithChildren } from "react";
import { LazyMotion, MotionConfig, useIsPresent, useReducedMotion } from "motion/react";
import type { HTMLMotionProps } from "motion/react";
import * as m from "motion/react-m";

const loadFeatures = () => import("./motionFeatures").then(module => module.default);
const enterEase = [0.16, 1, 0.3, 1] as const;
const exitEase = [0.4, 0, 1, 1] as const;

function overlayReturnTarget() {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const menuLabel = active?.closest("[role='menu']")?.getAttribute("aria-labelledby");
  return menuLabel ? document.getElementById(menuLabel) ?? active : active;
}

export function WorkbenchMotion({ children }: PropsWithChildren) {
  return <MotionConfig reducedMotion="user"><LazyMotion features={loadFeatures} strict>{children}</LazyMotion></MotionConfig>;
}

type MotionLayerProps = Omit<HTMLMotionProps<"div">, "initial" | "animate" | "exit" | "transition" | "ref"> & {
  kind?: "backdrop" | "panel" | "menu" | "fade";
};

export function MotionLayer({ children, kind = "panel", ...props }: MotionLayerProps) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const element = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(overlayReturnTarget());
  const moves = kind === "panel" || kind === "menu";
  const offset = reduced ? 0 : kind === "menu" ? -4 : 8;
  const duration = reduced ? 0 : 0.2;

  useEffect(() => {
    const layer = element.current;
    if (!layer || !["dialog", "menu"].includes(props.role ?? "")) return;
    const previous = returnFocus.current;
    if (!layer.contains(document.activeElement)) {
      const first = layer.querySelector<HTMLElement>("[autofocus], input:not(:disabled):not([type='hidden']), button:not(:disabled), select:not(:disabled), [tabindex='0']");
      (first ?? layer).focus();
    }
    return () => {
      const active = document.activeElement;
      if (active !== document.body && !layer.contains(active)) return;
      const target = previous?.isConnected && !previous.closest("[inert]") && !previous.hasAttribute("disabled") ? previous : document.querySelector<HTMLElement>(".openCinemaWorkbench .canvasSurface:not([inert])");
      target?.focus();
    };
  }, [props.role]);

  return <m.div {...props} ref={element} tabIndex={props.tabIndex ?? (props.role === "dialog" ? -1 : undefined)} inert={!present || props.inert} data-motion-state={present ? "entered" : "exiting"}
    initial={{ opacity: 0, ...(moves ? { y: offset } : {}) }} animate={{ opacity: 1, ...(moves ? { y: 0 } : {}) }}
    exit={{ opacity: 0, ...(moves ? { y: offset } : {}), transition: { duration: reduced ? 0 : 0.1, ease: exitEase } }}
    transition={{ duration, ease: enterEase }}>{children}</m.div>;
}

import { useEffect, useRef, type ReactNode } from "react";
import NodeIcon from "./reactIcon";
import "../theme/mediaInteractions.scss";

export default function MediaDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="nodeMediaDialog nodrag nopan nowheel" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section><header><strong>{title}</strong><button type="button" title="关闭" aria-label="关闭预览" onClick={onClose}><NodeIcon name="close" /></button></header>{children}</section></dialog>;
}

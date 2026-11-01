import { useEffect, useState } from "react";
import NodeIcon from "./reactIcon";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import { mediaLabels, useMediaUrl, type MediaType, type NodeViewProps } from "../reactNode";
import "../theme/generationControls.scss";

export default function GenerationLoading({ controller, prior, startedAt, mediaType, status, disabled, cancelLabel, onCancel }: { controller: NodeViewProps["controller"]; prior?: NodeMediaValue; startedAt?: string; status?: string; mediaType: MediaType; disabled?: boolean; cancelLabel?: string; onCancel(): void }) {
  const { url } = useMediaUrl(controller, prior);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const start = startedAt ? Date.parse(startedAt) : NaN; const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : undefined;
  const elapsed = seconds === undefined ? "" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const label = mediaLabels[mediaType];
  const copy = ({
    delegated: { badge: "等待 Agent", title: "等待 Agent 返回产物", detail: "写入产物后自动回填" },
    cancelRequested: { badge: "取消中", title: "正在取消任务", detail: "等待服务确认已停止" },
    unknown: { badge: "待确认", title: "任务结果未确认", detail: "可能仍在运行，也可能已扣费" },
    interrupted: { badge: "已中断", title: "上次生成已中断", detail: "可以重新核对或放弃" },
    resultReady: { badge: "待采用", title: `${label}已生成`, detail: "采用后写入节点" },
  } as Record<string, { badge: string; title: string; detail: string }>)[status ?? ""] ?? { badge: "生成中", title: `正在生成${label}`, detail: "完成后自动回填" };
  const active = ["running", "delegated", "cancelRequested"].includes(status ?? "");
  return <div className="nodeGenerationLoading" aria-busy={active}>
    <div className="nodeGenerationPrior" aria-hidden="true">{url && <img src={url} alt="" />}</div><div className="nodeGenerationAmbient" aria-hidden="true" />{active && <><div className="nodeGenerationBeam" aria-hidden="true" /><div className="nodeGenerationScan" aria-hidden="true" /></>}
    <span className="nodeGenerationBadge">{copy.badge}</span>
    <div className="nodeGenerationCapsule">{active && <span className="nodeGenerationRadial" aria-hidden="true"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.9155" /><circle cx="18" cy="18" r="15.9155" className="nodeGenerationArc" /></svg><i /></span>}<span className="nodeGenerationCopy" role="status"><strong>{copy.title}</strong><small>{copy.detail}</small></span>{cancelLabel && <button type="button" disabled={disabled} aria-label={cancelLabel} title={cancelLabel} onClick={onCancel}><NodeIcon name="close" /></button>}</div>
    {elapsed && <span className="nodeGenerationElapsed">已用时 {elapsed}</span>}
  </div>;
}

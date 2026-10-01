import { useEffect, useState } from "react";
import NodeIcon from "./reactIcon";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import { useMediaUrl, type MediaType, type NodeViewProps } from "../reactNode";
import "../theme/generationControls.scss";

export default function GenerationLoading({ controller, prior, startedAt, mediaType, status, disabled, onCancel }: { controller: NodeViewProps["controller"]; prior?: NodeMediaValue; startedAt?: string; status?: string; mediaType: MediaType; disabled?: boolean; onCancel(): void }) {
  const { url } = useMediaUrl(controller, prior);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const start = startedAt ? Date.parse(startedAt) : NaN; const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : undefined;
  const elapsed = seconds === undefined ? "" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const confirming = status === "unknown" || status === "cancelRequested";
  const title = confirming ? "正在确认任务状态" : status === "delegated" ? "等待 Agent 返回产物" : mediaType === "video" ? "正在生成视频" : mediaType === "image" ? "正在生成图像" : "正在生成音频";
  const detail = confirming ? "确认后自动更新" : "完成后自动回填";
  const cancelLabel = status === "unknown" || status === "cancelRequested" ? "确认任务终态" : "取消生成";
  return <div className="nodeGenerationLoading" aria-busy="true">
    <div className="nodeGenerationPrior" aria-hidden="true">{url && <img src={url} alt="" />}</div><div className="nodeGenerationAmbient" aria-hidden="true" /><div className="nodeGenerationBeam" aria-hidden="true" /><div className="nodeGenerationScan" aria-hidden="true" />
    <span className="nodeGenerationBadge">{confirming ? "确认中" : status === "delegated" ? "等待 Agent" : "生成中"}</span>
    <div className="nodeGenerationCapsule"><span className="nodeGenerationRadial" aria-hidden="true"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.9155" /><circle cx="18" cy="18" r="15.9155" className="nodeGenerationArc" /></svg><i /></span><span className="nodeGenerationCopy" role="status"><strong>{title}</strong><small>{detail}</small></span><button type="button" disabled={disabled} aria-label={cancelLabel} title={cancelLabel} onClick={onCancel}><NodeIcon name="close" /></button></div>
    {elapsed && <span className="nodeGenerationElapsed">已用时 {elapsed}</span>}
  </div>;
}

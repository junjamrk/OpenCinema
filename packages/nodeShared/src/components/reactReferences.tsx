import { useRef, useState } from "react";
import type { NodeInputValue } from "@toonflow/nodes-scaffold/values";
import { errorText, mediaValueSchema, useMediaUrl, type NodeViewProps } from "../reactNode";
import { readReferences, referenceKey } from "../reactReferences";
import MediaDialog from "./reactMediaDialog";
import NodeIcon from "./reactIcon";
import VideoPreview from "./reactVideoPreview";
import "../theme/mediaInteractions.scss";
import { readReferenceRole, referenceRoleLabels, type ReferenceRole } from "../videoShot";

function ReferenceCard({ input, index, total, controller, readOnly, actionError, onMove, onRemove, onMention, role, onRole }: { input: NodeInputValue; index: number; total: number; controller: NodeViewProps["controller"]; readOnly?: boolean; actionError?: string; onMove(offset: number): void; onRemove(): void; onMention?(): void; role?: ReferenceRole; onRole?(role: ReferenceRole): void }) {
  const media = mediaValueSchema.safeParse(input.value);
  const { url, error } = useMediaUrl(controller, media.success ? media.data : undefined);
  const [expanded, setExpanded] = useState(false);
  const title = typeof input.value === "string" ? input.value : media.success ? media.data.url : "暂无输出";
  return <div className="nodeReferenceCard">
    <button type="button" className="nodeReferencePreview" title={`参考 ${index + 1}${role ? ` · ${referenceRoleLabels[role]}` : ""} · ${title.slice(0, 160)}`} aria-label={`预览与管理参考 ${index + 1}`} aria-haspopup="dialog" onClick={() => setExpanded(true)} onKeyDown={event => { if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (!readOnly) onMove(event.key === "ArrowLeft" ? -1 : 1); } }}>
      {url && input.dataType === "IMAGE" ? <img src={url} alt={`参考 ${index + 1}`} loading="lazy" draggable={false} /> : url && input.dataType === "VIDEO" ? <VideoPreview key={url} url={url} label={`视频参考 ${index + 1}`} controls={false} /> : <span>{input.dataType === "AUDIO" ? "音频" : input.dataType === "STRING" ? "文本" : "文件"}</span>}
      <span className="nodeReferenceBadge">{index + 1}</span>
    </button>
    {expanded && <MediaDialog title={`连线参考 ${index + 1}`} onClose={() => setExpanded(false)}>
      {error ? <p className="nodeError" role="alert">{error}</p> : url && input.dataType === "IMAGE" ? <img src={url} alt={`参考 ${index + 1}`} /> : url && input.dataType === "VIDEO" ? <video src={url} controls autoPlay playsInline /> : url && input.dataType === "AUDIO" ? <audio src={url} controls /> : <pre>{title}</pre>}
      {role && onRole && <label className="nodeField"><span>生成职责</span><select value={role} disabled={readOnly} onChange={event => onRole(event.target.value as ReferenceRole)}>{Object.entries(referenceRoleLabels).filter(([key]) => ["general", "exclude"].includes(key) || key === "instruction" && input.dataType === "STRING" || key === "identity" && input.dataType === "IMAGE" || key === "motion" && input.dataType === "VIDEO" || key === "composition" && ["IMAGE", "VIDEO"].includes(String(input.dataType))).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
      {role === "motion" && <p className="nodeStatus">普通视频参考不能锁定深度或运动，生成后仍需逐镜审阅。</p>}
      <div className="nodeActions nodeReferenceActions" role="toolbar" aria-label={`参考 ${index + 1} 操作`}>
        {onMention && <button type="button" disabled={readOnly} onClick={event => { event.currentTarget.closest("dialog")?.close(); setExpanded(false); onMention(); }}><NodeIcon name="text" />插入 {`{{ref ${index + 1}}}`}</button>}
        <button type="button" title="也可在缩略图上按 Alt + ←" disabled={readOnly || !index} onClick={() => onMove(-1)}><NodeIcon name="arrowLeft" />前移</button>
        <button type="button" title="也可在缩略图上按 Alt + →" disabled={readOnly || index >= total - 1} onClick={() => onMove(1)}><NodeIcon name="arrowRight" />后移</button>
        {url && media.success && <a href={url} download={media.data.url.split("/").at(-1)}><NodeIcon name="download" />下载参考</a>}
        <button type="button" className="nodeReferenceDisconnect" disabled={readOnly} onClick={onRemove}><NodeIcon name="unlink" />断开参考</button>
      </div>
      {actionError && <p className="nodeError" role="alert">{actionError}</p>}
    </MediaDialog>}
  </div>;
}

export default function ReferenceList({ node, controller, readOnly, handleId = "in", onMention, videoRoles = false }: NodeViewProps & { handleId?: string; onMention?(text: string): void; videoRoles?: boolean }) {
  const values = readReferences(controller.getNodeService(node.id), node.data ?? {}, handleId);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  async function perform(name: string, args: Record<string, unknown>) { setBusy(true); setError(""); try { await controller.callNodeTool(node.id, name, args); return true; } catch (error) { setError(errorText(error)); return false; } finally { setBusy(false); } }
  async function remove(input: NodeInputValue) {
    const fallback = list.current?.closest(".nodeControls")?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (await perform("removeReference", { source: input.source, sourceHandle: input.sourceHandle })) requestAnimationFrame(() => (list.current ?? fallback)?.focus());
  }
  function move(from: number, offset: number) {
    const target = from + offset; if (target < 0 || target >= values.length) return;
    const sorted = [...values]; const [entry] = sorted.splice(from, 1); sorted.splice(target, 0, entry!);
    void perform("setReferenceOrder", { sources: sorted.map(({ source, sourceHandle }) => ({ source, sourceHandle })) });
  }
  if (!values.length) return null;
  return <div className="nodeReferences" ref={list} role="group" aria-label="连线参考" tabIndex={-1}><div className="nodeReferenceStrip"><span className="nodeReferenceCaption">参考 {values.length}</span><div className="nodeReferenceCards">{values.map((input, index) => <ReferenceCard key={referenceKey(input)} input={input} index={index} total={values.length} controller={controller} readOnly={readOnly || busy} actionError={error} onMove={offset => move(index, offset)} onRemove={() => void remove(input)} onMention={onMention ? () => onMention(`{{ref ${index + 1}}}`) : undefined} role={videoRoles ? readReferenceRole(node.data ?? {}, input) : undefined} onRole={videoRoles ? role => void perform("setReferenceRoles", { references: [{ source: input.source, sourceHandle: input.sourceHandle, role }] }) : undefined} />)}</div></div>{error && <p className="nodeError" role="alert">{error}</p>}</div>;
}

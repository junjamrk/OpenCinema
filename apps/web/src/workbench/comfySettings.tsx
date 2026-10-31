import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { analyzeComfyWorkflow, buildComfyModel, comfyDefaults, type ComfyAnalysis, type ComfyLoader, type ComfyMediaType, type ComfyRole } from "@/lib/comfyWorkflow";
import { localVideoConnectionInspectionSchema, localVideoConnectionSchema, mediaProviderSchema, providerModelSchema, workbenchSettingsClient } from "@/lib/workbenchSettingsClient";

type Draft = { analysis: ComfyAnalysis; label: string; type: ComfyMediaType; promptNode: string; loaders: ComfyLoader[]; parameters: string[]; ratios: string; durations: string };
type ComfySettingsProps = { provider: z.infer<typeof mediaProviderSchema>; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onStatus: (message: string) => void; onSaved: (provider?: z.infer<typeof mediaProviderSchema>) => Promise<void> };
const roleLabels: Record<ComfyRole, string> = { firstFrame: "首帧", lastFrame: "尾帧", reference: "参考素材", keep: "保持工作流原值" };
const statusLabels = { disabled: "未启用", unreachable: "无法连接", incompatible: "服务不兼容", dependenciesMissing: "已连接，缺少节点", ready: "已连接" };

function inspectionSummary(value: z.infer<typeof localVideoConnectionInspectionSchema>) {
  const device = value.system?.devices[0]?.name;
  return [statusLabels[value.status], value.system?.comfyVersion && `ComfyUI ${value.system.comfyVersion}`, device].filter(Boolean).join(" · ");
}

function parameterSummary({ size, frames, fps }: ComfyAnalysis) {
  return [size ? `原始尺寸 ${size.width}×${size.height}` : "尺寸由工作流决定", frames && fps ? `${frames.count} 帧 · ${fps} fps` : "时长由工作流决定"].join(" · ");
}

const splitOptions = (value: string) => value.split(/[,，\s]+/).filter(Boolean);

export default function ComfySettings({ provider, busy, perform, onStatus, onSaved }: ComfySettingsProps) {
  const [connection, setConnection] = useState<z.infer<typeof localVideoConnectionSchema>>();
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [inspection, setInspection] = useState<z.infer<typeof localVideoConnectionInspectionSchema>>();
  const [draft, setDraft] = useState<Draft>();
  const workflowFile = useRef<HTMLInputElement>(null);
  const builtin = provider.id === "comfyui";
  useEffect(() => {
    if (builtin) void perform(async () => {
      const value = await workbenchSettingsClient.localVideoConnection(new AbortController().signal);
      setConnection(value); setEnabled(value.config.enabled); setEndpoint(value.config.endpoint);
    });
  }, []);
  const saveConnection = () => void perform(async () => {
    if (!connection) return;
    const signal = new AbortController().signal;
    const next = await workbenchSettingsClient.saveLocalVideoConnection({ enabled, endpoint: endpoint.trim() }, connection.configRevision, signal);
    setConnection(next);
    const result = await workbenchSettingsClient.inspectLocalVideoConnection({ expectedRevision: next.configRevision }, signal);
    setInspection(result); await onSaved();
    onStatus(result.status === "disabled" ? "ComfyUI 连接已保存，当前未启用" : "ComfyUI 连接已保存");
  });
  const readWorkflow = (file: File) => void perform(async () => {
    if (file.size > 2 * 1024 ** 2) throw new Error("工作流超过 2 MiB");
    const analysis = analyzeComfyWorkflow(await file.text());
    const defaults = comfyDefaults(analysis);
    setDraft({ analysis, label: file.name.replace(/\.json$/i, ""), type: analysis.type, promptNode: analysis.promptNode, loaders: analysis.loaders, parameters: [], ratios: defaults.ratios.join(", "), durations: defaults.durations.join(", ") });
  });
  const saveWorkflow = () => void perform(async () => {
    if (!draft) return;
    const model = providerModelSchema.parse(buildComfyModel(draft.analysis, { id: `workflow${crypto.randomUUID().slice(0, 8)}`, label: draft.label.trim(), type: draft.type, promptNode: draft.promptNode, loaders: draft.loaders, parameters: draft.parameters, ratios: splitOptions(draft.ratios), durations: splitOptions(draft.durations).map(Number) }));
    await onSaved(await workbenchSettingsClient.saveProviderModels(provider.id, [...provider.models, model], provider.revision, new AbortController().signal));
    setDraft(undefined); onStatus("工作流已添加，可以在生成节点里选择");
  });
  return <>
    {builtin && <form className="settingEditor" onSubmit={event => { event.preventDefault(); saveConnection(); }}>
      <strong>ComfyUI 连接</strong>
      <label className="settingToggle"><span>启用此连接</span><input type="checkbox" checked={enabled} disabled={busy || !connection} onChange={event => setEnabled(event.target.checked)} /></label>
      <label>服务地址<input value={endpoint} disabled={busy || !connection} required onChange={event => setEndpoint(event.target.value)} /></label>
      <p>仅支持本机或局域网地址。工作流会在 ComfyUI 上执行，请只导入你信任的工作流。</p>
      <div className="settingsActions"><button type="submit" disabled={busy || !connection}>保存并检测</button></div>
      {inspection && <p role="status">{inspectionSummary(inspection)}{inspection.status !== "ready" && inspection.message ? ` · ${inspection.message}` : ""}</p>}
      {inspection?.workflows.filter(item => item.missingNodes.length).map(item => <p key={item.modelId} role="alert">{item.label} 缺少节点：{item.missingNodes.join("、")}</p>)}
    </form>}
    <div className="settingsActions"><button type="button" disabled={busy} onClick={() => workflowFile.current?.click()}>导入工作流</button></div>
    <input ref={workflowFile} type="file" accept="application/json,.json" hidden aria-label="ComfyUI 工作流文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) readWorkflow(file); }} />
    <p>在 ComfyUI 中选择“导出（API）”，得到的 JSON 就可以在这里导入。</p>
    {draft && <form className="settingEditor" onSubmit={event => { event.preventDefault(); saveWorkflow(); }}>
      <strong>确认工作流输入</strong>
      <label>显示名称<input value={draft.label} required maxLength={200} disabled={busy} onChange={event => setDraft({ ...draft, label: event.target.value })} /></label>
      <label>生成类型<select value={draft.type} disabled={busy} onChange={event => setDraft({ ...draft, type: event.target.value as ComfyMediaType })}><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select></label>
      <label>提示词写入<select value={draft.promptNode} disabled={busy} required onChange={event => setDraft({ ...draft, promptNode: event.target.value })}><option value="" disabled>选择节点</option>{draft.analysis.textNodes.map(item => <option key={item.node} value={item.node}>{item.title}</option>)}</select></label>
      {draft.loaders.map((loader, index) => <label key={`${loader.node}:${loader.field}`}>{loader.title}<select value={loader.role} disabled={busy} onChange={event => setDraft({ ...draft, loaders: draft.loaders.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value as ComfyRole } : item) })}>{(loader.type === "image" ? ["firstFrame", "lastFrame", "reference", "keep"] as const : ["reference", "keep"] as const).map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label>)}
      {draft.analysis.size && draft.type !== "audio" && <label>可选画幅（逗号分隔）<input value={draft.ratios} disabled={busy} onChange={event => setDraft({ ...draft, ratios: event.target.value })} /></label>}
      {draft.analysis.frames && draft.analysis.fps && draft.type === "video" && <label>可选时长（秒，逗号分隔）<input value={draft.durations} disabled={busy} onChange={event => setDraft({ ...draft, durations: event.target.value })} /></label>}
      {draft.analysis.parameters.filter(item => item.node !== draft.promptNode).map(item => <label key={item.key} className="settingToggle"><span>节点可调：{item.schema.title}</span><input type="checkbox" checked={draft.parameters.includes(item.key)} disabled={busy} onChange={event => setDraft({ ...draft, parameters: event.target.checked ? [...draft.parameters, item.key] : draft.parameters.filter(key => key !== item.key) })} /></label>)}
      <p>{parameterSummary(draft.analysis)}。没勾选的字段保持工作流原值；种子留空时每次生成自动更换。</p>
      <div className="settingsActions"><button type="submit" disabled={busy || !draft.label.trim() || !draft.promptNode}>添加工作流</button><button type="button" disabled={busy} onClick={() => setDraft(undefined)}>取消</button></div>
    </form>}
  </>;
}

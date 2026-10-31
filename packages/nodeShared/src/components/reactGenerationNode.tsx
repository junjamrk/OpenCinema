import { useEffect, useState, type ReactNode } from "react";
import { createMediaAiClient, type NodeMediaCost, type NodeMediaModel, type NodeModelParameter } from "@toonflow/nodes-scaffold/nodeAiClient";
import MediaNode from "./reactMediaNode";
import { errorText, mediaLabels, readMedia, type MediaType, type NodeViewProps } from "../reactNode";
import { matchingVideoModes, normalizeParameters, parameterIssue } from "../reactGeneration";
import { readReferences } from "../reactReferences";
import ReferenceList from "./reactReferences";
import GenerationLoading from "./reactGenerationLoading";
import NodeIcon from "./reactIcon";
import { groupNodeModels } from "../groupNodeModels";
import VideoShotControls from "./videoShotControls";
import { activeVideoReferences, readVideoReview } from "../videoShot";

export default function GenerationNode(props: NodeViewProps & { mediaType: MediaType; children?: ReactNode; cardAction?: ReactNode; onVideoReady?(video: HTMLVideoElement): void; onAudioReady?(audio: HTMLAudioElement): void }) {
  const { node, controller, mediaType, readOnly } = props;
  const [models, setModels] = useState<NodeMediaModel[]>();
  const [error, setError] = useState("");
  const [observeError, setObserveError] = useState("");
  const [busy, setBusy] = useState(false);
  const [price, setPrice] = useState("");
  const [runtimeState, setRuntimeState] = useState<string>();
  const [progress, setProgress] = useState<number>();
  const [warning, setWarning] = useState<string>();
  const [cost, setCost] = useState<NodeMediaCost>();
  const [parameterIssues, setParameterIssues] = useState<Record<string, string | undefined>>({});
  const workbench = controller.getNodeService(node.id);
  const prompt = String(node.data?.prompt ?? "");
  const value = readMedia(node.data, mediaType);
  const generation = node.data?.generation as { status?: string; taskId?: string; error?: string; startedAt?: string; finishedAt?: string; abandoned?: boolean } | undefined;
  const generationState = runtimeState ?? generation?.status;
  const running = ["running", "delegated", "unknown", "cancelRequested"].includes(generationState ?? "");
  const blocked = running || generationState === "interrupted";
  // ACT: 错误文本第一行是给用户的结论，其余行是供应商原文。两段沿用一个字符串，Agent 读到的状态也带着原文。
  const failure = error || (generationState === "running" || generationState === "resultReady" ? undefined : generation?.error);
  const abandonable = ["unknown", "interrupted", "resultReady", "delegated"].includes(generationState ?? "") && generation?.status !== "failed";
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRuntimeState(undefined); setProgress(undefined); setWarning(undefined); setCost(undefined); setObserveError("");
    async function observe() {
      try {
        const value = await controller.callNodeTool(node.id, "getGenerationStatus", {});
        if (!active || !value || typeof value !== "object" || !("status" in value)) return;
        const state = String(value.status);
        setRuntimeState(state); setObserveError("");
        setProgress("progress" in value && typeof value.progress === "number" ? value.progress : undefined);
        setWarning("warning" in value && typeof value.warning === "string" ? value.warning : undefined);
        setCost("cost" in value ? value.cost as NodeMediaCost | undefined : undefined);
        if (["running", "unknown", "cancelRequested"].includes(state)) timer = setTimeout(observe, 3000);
      } catch (reason) {
        // 服务断开时继续查，恢复后节点自己回到真实状态。
        if (active) { setObserveError(errorText(reason)); timer = setTimeout(observe, 3000); }
      }
    }
    void observe();
    return () => { active = false; clearTimeout(timer); };
  }, [controller, node.id, mediaType, generation?.taskId, generation?.status, generation?.finishedAt]);
  useEffect(() => {
    const lifetime = new AbortController();
    const refresh = () => void createMediaAiClient(lifetime.signal).getMediaModels().then(values => setModels(values.filter(value => value.type === mediaType))).catch(reason => { if (!lifetime.signal.aborted) setError(errorText(reason)); });
    refresh();
    window.addEventListener("toonflow:provider-config-changed", refresh);
    return () => { lifetime.abort(); window.removeEventListener("toonflow:provider-config-changed", refresh); };
  }, [mediaType]);
  const model = models?.find(value => JSON.stringify([value.providerId, value.modelId]) === node.data?.model);
  const modelGone = !!models && !!node.data?.model && !model;
  // 已配置的排前面。同名模型来自不同供应商，下拉收起时只显示选项文字，要带上供应商才分得清。
  const modelGroups = groupNodeModels(models ?? []).toSorted((left, right) => Number(!!left.models[0]!.credentialMissing) - Number(!!right.models[0]!.credentialMissing));
  const modelOption = (item: NodeMediaModel) => `${item.label}${models!.filter(other => other.label === item.label).length > 1 ? ` · ${item.providerLabel}` : ""}${item.credentialMissing ? "（未配置 Key）" : ""}`;
  const inputs = readReferences(workbench, node.data ?? {});
  const videoInputs = mediaType === "video" ? activeVideoReferences(node.data ?? {}, inputs) : inputs;
  const shotReview = mediaType === "video" ? readVideoReview(node.data ?? {}) : null;
  const guide = (node.data?.inpaint as { guide?: string } | undefined)?.guide;
  const referenceImage = inputs.find(input => input.dataType === "IMAGE" && input.value)?.value;
  const prior = mediaType === "image" ? readMedia(node.data, "image") ?? (guide ? { url: guide, mimeType: "image/png" } : undefined) : referenceImage && typeof referenceImage === "object" && "url" in referenceImage ? referenceImage : undefined;
  function focusComposer(input: { prompt?: string; insertText?: string }) {
    try { workbench.focusComposer(input); }
    catch (reason) { setError(errorText(reason)); }
  }
  const compose = (insertText?: string) => focusComposer(insertText ? { insertText } : {});
  async function call(name: string, args: Record<string, unknown> = {}) {
    setBusy(true); setError("");
    try { return await controller.callNodeTool(node.id, name, args); } catch (failure) { setError(errorText(failure)); return false; } finally { setBusy(false); }
  }
  function callStatusTool(name: string) {
    void call(name).then(value => { if (value && typeof value === "object" && "status" in value) setRuntimeState(String(value.status)); });
  }
  function abandon() {
    if (window.confirm("放弃后节点会解锁，但原任务可能仍在运行。可能已扣费，重新生成可能重复计费。确定放弃此任务吗？")) callStatusTool("abandonGeneration");
  }
  const field = (key: string, title: string, choices: readonly unknown[] | undefined) => choices?.length ? <label className="nodeField"><span>{title}</span><select disabled={readOnly || blocked || busy} value={String(node.data?.[key] ?? "")} onChange={event => void call("setConfig", { [key]: key === "duration" ? Number(event.target.value) : event.target.value })}>
    <option value="" disabled>跟随模型</option>{choices.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
  </select></label> : null;
  const parameters = model ? normalizeParameters(node.data ?? {}, model) : {};
  const locked = !!readOnly || blocked || busy;
  function setParameter(key: string, value: string | number | boolean | undefined) {
    const { [key]: _previous, ...others } = parameters;
    void call("setConfig", { parameters: value === undefined ? others : { ...others, [key]: value } });
  }
  function parameterField(key: string, schema: NodeModelParameter) {
    const current = parameters[key], title = schema.title ?? key;
    const choices = schema.enum ?? (schema.type === "boolean" ? [true, false] : undefined);
    if (choices) return <label key={key} className="nodeField"><span>{title}</span><select disabled={locked} value={current === undefined ? "" : choices.indexOf(current)} onChange={event => setParameter(key, choices[Number(event.target.value)])}>
      <option value="" disabled>跟随模型</option>{choices.map((value, index) => <option key={String(value)} value={index}>{value === true ? "开启" : value === false ? "关闭" : String(value)}</option>)}
    </select></label>;
    const text = schema.type === "string", issue = parameterIssues[key];
    return <label key={key} className="nodeField"><span>{title}</span><input key={String(current)} type={text ? "text" : "number"} min={schema.minimum} max={schema.maximum} step={schema.type === "integer" ? 1 : "any"} defaultValue={current === undefined ? "" : String(current)} readOnly={locked} aria-invalid={!!issue} onBlur={event => {
      const input = event.target, value = input.value === "" ? schema.default : text ? input.value : Number(input.value);
      const problem = value === undefined ? undefined : parameterIssue(schema, value);
      setParameterIssues(issues => ({ ...issues, [key]: problem }));
      // 不合法的值不保存，恢复原值并就地提示：输入框显示的始终是下次生成会发送的值。
      if (problem || value === current) input.value = current === undefined ? "" : String(current);
      else setParameter(key, value);
    }} />{issue && <span className="nodeError" role="alert">{issue}</span>}</label>;
  }
  const toolbarAction = props.cardAction || !blocked && (value || guide) ? <>{props.cardAction}{!blocked && (value || guide) && <button type="button" className="nodeMediaTool nodeMediaToolPrimary" disabled={busy || readOnly} title={value ? "在底部继续创作" : "在底部描述重绘要求"} aria-label={value ? "在底部继续创作" : "在底部描述重绘要求"} onClick={() => compose()}><NodeIcon name="generate" /></button>}</> : undefined;
  return <MediaNode {...props} compact disabled={blocked || busy} toolbarAction={toolbarAction} emptyAction={<div className="nodeComposerEmpty"><NodeIcon name="generate" size={20} /><span>在下方描述创作要求</span></div>} fallbackPreview={mediaType === "image" && guide ? { url: guide, mimeType: "image/png" } : undefined} fallbackCaption="红色标注为重绘区域" stageOverlay={running ? <GenerationLoading controller={controller} mediaType={mediaType} status={generationState} prior={prior} startedAt={generation?.startedAt} disabled={busy || readOnly} onCancel={() => void call("cancelGeneration")} /> : undefined}>
    <ReferenceList {...props} readOnly={readOnly || blocked || busy} videoRoles={mediaType === "video"} onMention={compose} />
    <div className="nodeGenerationDetails">
    <section className="nodeGenerationSettings"><h4>生成设置</h4><div className="nodeGenerationSettingsBody">
    <label className="nodeField"><span>{mediaType === "video" ? "视频专项模型" : "执行方式"}</span><select value={String(node.data?.model ?? "")} disabled={readOnly || blocked || busy} onChange={event => {
      if (!event.target.value) { void call("useHost"); return; }
      const choice = models?.find(value => JSON.stringify([value.providerId, value.modelId]) === event.target.value);
      if (choice) void call("setConfig", { providerId: choice.providerId, modelId: choice.modelId });
    }}><option value="">宿主 Agent</option>{modelGone && <option value={String(node.data?.model)} disabled>已失效的模型，请重新选择</option>}{modelGroups.map(group => <optgroup key={group.id} label={group.models[0]!.credentialMissing ? `${group.label}（未配置 Key）` : group.label}>{group.models.map(model => <option key={model.modelId} value={JSON.stringify([model.providerId, model.modelId])}>{modelOption(model)}</option>)}</optgroup>)}</select></label>
    <div className="nodeActions"><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("openCinema:open-settings", { detail: { tab: "models" } }))}>配置模型</button></div>
    {model && <div className="nodeFields">
      {field("ratio", "画幅", mediaType === "video" ? model.imageRatios?.length ? model.imageRatios : model.execution?.protocol === "comfyui" ? undefined : ["16:9", "9:16", "1:1", "4:3", "3:4"] : model.imageRatios)}{field("size", "分辨率", model.imageSizes)}{field("resolution", "分辨率", [...new Set(model.durationResolutionMap?.filter(item => item.duration.includes(Number(node.data?.duration))).flatMap(item => item.resolution))])}{field("duration", "时长（秒）", [...new Set(model.durationResolutionMap?.flatMap(item => item.duration))])}
      {mediaType === "video" && model.mode?.length ? <label className="nodeField"><span>参考模式</span><select value={String(node.data?.mode ?? "")} disabled={readOnly || blocked || busy} onChange={event => void call("setConfig", { mode: JSON.parse(event.target.value) })}><option value="" disabled>选择模式</option>{matchingVideoModes(model, videoInputs).map(mode => <option key={JSON.stringify(mode)} value={JSON.stringify(mode)}>{Array.isArray(mode) ? mode.join(" · ") : ({ text: "文生视频", singleImage: "单图参考", startEndRequired: "首尾帧", startFrameOptional: "尾帧 / 首尾帧", endFrameOptional: "首帧 / 首尾帧" } as Record<string, string>)[mode] ?? mode}</option>)}</select></label> : null}
      {mediaType === "video" && model.audio === "optional" && <label className="nodeField"><span>音轨</span><select value={node.data?.generateAudio ? "1" : "0"} disabled={readOnly || blocked || busy} onChange={event => void call("setConfig", { generateAudio: event.target.value === "1" })}><option value="0">无声</option><option value="1">生成声音</option></select></label>}
      {Object.entries(model.parameters?.properties ?? {}).map(([key, schema]) => parameterField(key, schema))}
    </div>}
    {model?.execution && <p className="nodeStatus">{({ local: "本地 / 局域网执行", remote: "远程模型服务", platform: "平台执行" })[model.execution.location]}{model.execution.cancelMode === "none" ? " · 服务未声明中止能力" : ""}</p>}
    {mediaType === "audio" && <div className="nodeFields">
      <label className="nodeField"><span>音色</span><input defaultValue={String(node.data?.voice ?? "")} key={String(node.data?.voice ?? "")} readOnly={readOnly || blocked || busy} onBlur={event => { if (event.target.value !== node.data?.voice) void call("setConfig", { voice: event.target.value }); }} /></label>
      {field("language", "语种", ["zh-CN", "en"])}{field("format", "格式", ["wav", "mp3", "pcm", "ogg_opus"])}
      <label className="nodeField"><span>采样率</span><select value={Number(node.data?.sampleRate ?? 24000)} disabled={readOnly || blocked || busy} onChange={event => void call("setConfig", { sampleRate: Number(event.target.value) })}>{[8000,16000,24000,48000].map(rate => <option key={rate} value={rate}>{rate / 1000} kHz</option>)}</select></label>
    </div>}
    {model?.supportsPrice && <div className="nodeActions"><button type="button" disabled={busy || blocked} onClick={() => void call("getPrice").then(value => { if (value && typeof value === "object" && "price" in value) setPrice([String(value.price ?? "暂未取得报价"), "tips" in value ? String(value.tips ?? "") : ""].filter(Boolean).join(" · ")); })}><NodeIcon name="cost" />费用</button>{price && <span className="nodeStatus">{price}</span>}</div>}
    </div></section>
    {prompt && <details className="nodeDetails"><summary>创作指令</summary><p className="nodeSavedInstruction">{prompt}</p></details>}
    {mediaType === "video" && <VideoShotControls {...props} disabled={blocked || busy} />}
    {props.children}
    </div>
    {generationState && generationState !== "idle" && <div className="nodeActions">
      {(generationState === "interrupted" || generationState === "failed" && generation?.taskId && !!node.data?.model) && <button type="button" disabled={busy || readOnly} onClick={() => callStatusTool("getGenerationStatus")}>重新核对</button>}
      {generationState === "resultReady" && <button type="button" disabled={busy || readOnly} onClick={() => callStatusTool("applyGenerationResult")}>采用已完成{mediaLabels[mediaType]}</button>}
      {abandonable && <button type="button" disabled={busy || readOnly} onClick={abandon}>放弃此任务</button>}
      {(["failed", "cancelled"].includes(generationState) || generationState === "completed" && !value) && <button type="button" disabled={busy || readOnly} title="回填提示词到底部输入框，确认后发送" onClick={() => focusComposer({ prompt })}>重新生成</button>}
      <span className="nodeStatus" data-state={generationState} role="status">{({ running: "生成中", delegated: "已交给宿主，等待产物", completed: value ? "产物已保存" : "任务已结束，节点没有产物", resultReady: `${mediaLabels[mediaType]}已生成，待采用`, cancelled: "已取消", failed: generation?.abandoned ? "已放弃此任务" : "生成失败", interrupted: "上次生成已中断", unknown: "任务终态尚未确认", cancelRequested: "正在确认取消" } as Record<string, string>)[generationState] ?? generationState}{progress !== undefined && running ? ` · ${Math.round(progress)}%` : ""}</span>
      {cost && <span className="nodeStatus">预估 {cost.estimate?.price ?? "无报价"} · 实际 {cost.actual ? `${cost.actual.amount} ${cost.actual.unit}（${cost.actual.source === "vendor" ? "厂商返回" : "余额差"}）` : "未知"}</span>}
      {mediaType === "video" && generationState === "completed" && value && <span className="nodeStatus" data-state={shotReview?.status === "rejected" ? "failed" : "pending"} title="审片记录绑定源文件版本；打开审片或合成时会重新核对当前版本">{shotReview?.source === value.url ? shotReview.status === "approved" ? `通过记录 · ${shotReview.start}–${shotReview.end}s（合成前核版本）` : "候选已拒收" : "视频候选 · 待审"}</span>}
    </div>}
    {warning && running && <p className="nodeStatus" role="status">正在重试：{warning}</p>}
    {observeError && <p className="nodeStatus" role="status">暂时读不到任务状态，正在重试：{observeError}</p>}
    {failure && <p className="nodeError" role="alert">{failure.split("\n")[0]}</p>}
    {failure?.includes("\n") && <details className="nodeDetails"><summary>错误详情</summary><p className="nodeSavedInstruction">{failure.split("\n").slice(1).join("\n")}</p></details>}
  </MediaNode>;
}

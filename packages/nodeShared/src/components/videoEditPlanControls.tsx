import { useEffect, useRef, useState } from "react";
import { errorText, isExecutionUnknown, readMedia, type NodeViewProps } from "../reactNode";
import type { VideoEditPlan, VideoEditPlanSnapshot } from "../videoEditPlan";
import MediaDialog from "./reactMediaDialog";
import NodeIcon from "./reactIcon";

type Props = NodeViewProps & { disabled?: boolean; percent?: number };
function seconds(value: number) { return `${Number(value.toFixed(3))}s`; }

function VideoEditPlanDialog({ node, controller, readOnly, disabled, percent, onClose }: Props & { onClose(): void }) {
  const [snapshot, setSnapshot] = useState<VideoEditPlanSnapshot>();
  const [plan, setPlan] = useState<VideoEditPlan | null>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false);
  const [error, setError] = useState(""), [resultId, setResultId] = useState("");
  const [renderState, setRenderState] = useState<"idle" | "rendering" | "cancelled">("idle");
  const cancelling = useRef(false);
  const locked = disabled || readOnly || busy || unknown;
  useEffect(() => {
    const lifetime = new AbortController();
    setBusy(true);
    void controller.callNodeTool(node.id, "getVideoEditPlan", {}, lifetime.signal).then(value => {
      if (lifetime.signal.aborted) return;
      const next = value as VideoEditPlanSnapshot; setSnapshot(next); setPlan(next.plan);
    }).catch(reason => { if (!lifetime.signal.aborted) { if (isExecutionUnknown(reason)) setUnknown(true); setError(errorText(reason)); } }).finally(() => { if (!lifetime.signal.aborted) setBusy(false); });
    return () => lifetime.abort();
  }, [controller, node.id]);
  const candidates = controller.getNodeService(node.id).readNodes().flatMap(candidate => {
    const outputs = candidate.data?.outputs as { video?: { value?: { controlType?: unknown } } } | undefined;
    if (outputs?.video?.value?.controlType) return [];
    const media = readMedia(candidate.data, "video");
    return media && candidate.id !== node.id ? [{ id: candidate.id, label: String(candidate.data?.label ?? candidate.id), path: media.url }] : [];
  });
  function changeRange(index: number, key: "start" | "end", value: string) {
    if (!plan) return;
    const clips = plan.clips.map((clip, position) => {
      if (position !== index) return clip;
      const next = { ...clip };
      if (value === "") delete next[key]; else next[key] = Number(value);
      return next;
    });
    setPlan({ ...plan, clips }); setDirty(true); setResultId("");
  }
  function move(index: number, offset: number) {
    if (!plan || index + offset < 0 || index + offset >= plan.clips.length) return;
    const clips = [...plan.clips]; [clips[index], clips[index + offset]] = [clips[index + offset]!, clips[index]!];
    setPlan({ ...plan, clips }); setDirty(true); setResultId("");
  }
  async function replace(index: number, candidateId: string) {
    if (!plan || !candidateId) return;
    const clip = plan.clips[index]!, sourceReport = snapshot?.clips.find(value => value.path === clip.path && value.sourceRevision === clip.sourceRevision), report = snapshot?.clips.find(value => value.path === clip.path && value.sourceRevision === clip.sourceRevision && (snapshot.plan?.clips[value.index]?.start ?? 0) === (clip.start ?? 0) && snapshot.plan?.clips[value.index]?.end === clip.end);
    const end = clip.end ?? report?.end;
    if (end == null) { setError("当前镜头出点尚未解析，请先明确采用出点再换镜。"); return; }
    const candidate = candidates.find(value => value.id === candidateId);
    if (!candidate) { setError("候选节点已变化，请重新选择。"); return; }
    setBusy(true); setError("");
    try {
      const current = await controller.callNodeTool(candidate.id, "getVideoReview", {}) as { current?: { url: string }; sourceRevision?: string };
      if (current.current?.url !== candidate.path || !current.sourceRevision) throw new Error("候选视频已变化，请重新选择当前版本。");
      const clips = plan.clips.map((value, position) => position === index ? { ...value, label: value.label ?? sourceReport?.label ?? `镜头 ${index + 1}`, path: candidate.path, sourceRevision: current.sourceRevision!, start: value.start ?? 0, end } : value);
      setPlan({ ...plan, clips }); setDirty(true); setResultId("");
    } catch (reason) { if (isExecutionUnknown(reason)) setUnknown(true); setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true); setError("");
    try {
      const next = await controller.callNodeTool(node.id, "getVideoEditPlan", {}) as VideoEditPlanSnapshot;
      setSnapshot(next); setPlan(next.plan); setDirty(false);
    } catch (reason) { if (isExecutionUnknown(reason)) setUnknown(true); setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function save() {
    if (!plan || !snapshot) return;
    setBusy(true); setError("");
    try {
      const next = await controller.callNodeTool(node.id, "setVideoEditPlan", { expectedPlanRevision: snapshot.planRevision, plan }) as VideoEditPlanSnapshot;
      setSnapshot(next); setPlan(next.plan); setDirty(false); setResultId("");
    } catch (reason) { if (isExecutionUnknown(reason)) setUnknown(true); setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function render() {
    if (!snapshot?.canRender || !plan || dirty) return;
    setBusy(true); setError(""); setResultId(""); setRenderState("rendering"); cancelling.current = false;
    try {
      const result = await controller.callNodeTool(node.id, "renderVideoEditPlan", { expectedPlanRevision: snapshot.planRevision }) as { nodeId: string };
      setResultId(result.nodeId); setRenderState("idle");
    } catch (reason) {
      setRenderState(cancelling.current ? "cancelled" : "idle");
      if (!cancelling.current) { if (isExecutionUnknown(reason)) setUnknown(true); setError(errorText(reason)); }
    } finally { setBusy(false); }
  }
  function cancelRender() {
    cancelling.current = true;
    void controller.callNodeTool(node.id, "cancelMediaOperation", {}).catch(reason => setError(errorText(reason)));
  }
  return <MediaDialog title="剪辑计划" onClose={onClose}><div className="nodeShotDialog nodeVideoEditPlan">
    {busy && !snapshot && <p className="nodeStatus" role="status">正在读取镜头版本、采用范围和审片状态…</p>}
    {plan ? <>
      <div className="nodeEditPlanSummary"><strong>{plan.clips.length} 镜{!dirty && snapshot?.totalDuration != null ? ` · ${seconds(snapshot.totalDuration)}` : ""}</strong><span>{plan.resolution} · {plan.fps} fps · 修订 {snapshot?.planRevision}</span><button type="button" disabled={busy || unknown} onClick={() => void refresh()}><NodeIcon name="reset" />{dirty ? "放弃修改并刷新" : "刷新预检"}</button></div>
      <p className="nodeStatus" role="status">{({ unrendered: "计划已保存，尚未渲染对应视频。", current: "当前视频对应此计划。", modified: "计划已修改，当前视频仍是旧版本。", sourceChanged: "计划源文件已变化或不可读，需协调后重新渲染。", outputChanged: "当前视频与已渲染记录不同，原记录保留。" } as Record<string, string>)[snapshot?.status ?? ""]}</p>
      <p className="nodeStatus">{dirty ? "本地修改待保存，预检需保存后更新；原视频未改变。" : snapshot?.canRender ? "技术与已审区间预检通过。镜间身份、方向和动作连续性仍须实际审片。" : "尚不能渲染，请处理下面具体镜头或音轨的阻塞。"}</p>
      <div className="nodeEditPlanClips">{plan.clips.map((clip, index) => {
        const report = !dirty ? snapshot?.clips[index] : undefined;
        const label = clip.label ?? snapshot?.clips.find(value => value.path === clip.path && value.sourceRevision === clip.sourceRevision)?.label ?? candidates.find(value => value.path === clip.path)?.label ?? `镜头 ${index + 1}`;
        return <section className={`nodeEditPlanClip${report?.blockers.length ? " nodeEditPlanClipBlocked" : ""}`} key={index}>
          <div className="nodeActions"><strong>{String(index + 1).padStart(2, "0")} · {label}</strong><button type="button" disabled={locked || index === 0} aria-label={`上移镜头${index + 1}`} onClick={() => move(index, -1)}><NodeIcon name="arrowUp" /></button><button type="button" disabled={locked || index === plan.clips.length - 1} aria-label={`下移镜头${index + 1}`} onClick={() => move(index, 1)}><NodeIcon name="arrowDown" /></button></div>
          {report && <p className="nodeStatus">{report.timelineStart != null && report.timelineEnd != null ? `成片 ${seconds(report.timelineStart)}–${seconds(report.timelineEnd)} · ${report.frames} 帧` : "成片时段待有效范围确定"} · {report.sourceStatus === "ready" ? "源版本一致" : report.sourceStatus === "stale" ? "源版本变化" : "素材不可用"} · {report.reviewStatus === "notRequired" ? "普通导入，未要求生成审片" : report.reviewStatus === "rejected" ? "已拒收" : report.reviewAllowsRange ? "采用区间已通过审片" : report.reviewStatus === "approved" ? "审片不适用当前采用" : "待审片"}</p>}
          <div className="nodeFields"><label className="nodeField"><span>源入点（秒；空为 0）</span><input type="number" min={0} step="any" disabled={locked} value={clip.start ?? ""} onChange={event => changeRange(index, "start", event.target.value)} /></label><label className="nodeField"><span>源出点（秒；空为片尾）</span><input type="number" min={0} step="any" disabled={locked} value={clip.end ?? ""} onChange={event => changeRange(index, "end", event.target.value)} /></label></div>
          <label className="nodeField"><span>替换此镜（保留入出点，保存后检查新素材范围）</span><select value="" disabled={locked} onChange={event => void replace(index, event.target.value)}><option value="">选择画布中的已有视频…</option>{candidates.filter(value => value.path !== clip.path).map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
          <details className="nodeEditPlanSource"><summary>素材与版本</summary><input readOnly value={clip.path} title={clip.path} /><p className="nodeStatus">计划源版本：{clip.sourceRevision}</p>{report?.sourceDuration != null && <p className="nodeStatus">源时长 {seconds(report.sourceDuration)} · 实际采用 {seconds(report.start)}–{report.end != null ? seconds(report.end) : "片尾"}</p>}{report?.review && <p className="nodeStatus">最新审片：{report.review.notes}</p>}</details>
          {report?.blockers.map(blocker => <p className="nodeError" key={blocker.code}>{blocker.message}</p>)}
          {report?.nodeId && <button type="button" className="nodeEditPlanLocate" disabled={busy || unknown} onClick={() => { controller.getNodeService(node.id).selectNodes([report.nodeId!]); onClose(); }}><NodeIcon name="arrowRight" />定位源节点</button>}
        </section>;
      })}</div>
      {plan.audio && <p className="nodeStatus">外部音轨：{plan.audio.path.split("/").at(-1)} · {plan.audio.mode === "mix" ? "混合" : "替换"}</p>}
      {!dirty && snapshot?.blockers.map(blocker => <p className="nodeError" key={blocker.code}>{blocker.message}</p>)}
      <div className="nodeActions"><button type="button" disabled={locked || !dirty} onClick={() => void save()}>保存计划并预检</button><button type="button" className="nodePrimary" disabled={locked || dirty || !snapshot?.canRender} onClick={() => void render()}>{busy ? "处理中…" : "渲染为新成片"}</button></div>
      {renderState === "rendering" && <><progress className="nodeProgress" aria-label="渲染进度" value={percent} max={100} /><div className="nodeActions"><span className="nodeStatus" role="status">正在渲染{percent === undefined ? "…" : ` · ${percent}%`}</span><button type="button" onClick={cancelRender}>取消渲染</button></div></>}
      {renderState === "cancelled" && <p className="nodeStatus" role="status">已取消渲染，原视频保留。</p>}
      {dirty && <p className="nodeStatus">保存后重新核对版本、时长和审片；原区间若超出候选长度会明确阻塞，不自动裁切。新成片须另行渲染，旧片保留。</p>}
      {resultId && <div className="nodeActions"><span className="nodeStatus">已生成新成片，旧片保留。</span><button type="button" onClick={() => { controller.getNodeService(node.id).selectNodes([resultId]); onClose(); }}>选择新成片</button></div>}
    </> : snapshot && <p className="nodeStatus">此视频没有保存的剪辑计划。可让 Agent 用实际镜头、源版本和入出点建立计划，原视频保持不变。</p>}
    {unknown && <div className="nodeActions"><span className="nodeStatus">操作结果尚未确认。请先在节点的媒体编辑区查看任务状态，再决定是否重试，避免重复渲染。</span><button type="button" onClick={() => { setUnknown(false); setError(""); }}>已确认，继续编辑</button></div>}
    {error && <p className="nodeError" role="alert">{error}</p>}
  </div></MediaDialog>;
}

export default function VideoEditPlanControls(props: Props) {
  const [open, setOpen] = useState(false);
  return <><button type="button" disabled={props.disabled || props.readOnly} onClick={() => setOpen(true)}><NodeIcon name="list" />剪辑计划</button>{open && <VideoEditPlanDialog {...props} onClose={() => setOpen(false)} />}</>;
}

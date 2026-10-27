import { useEffect, useRef, useState, type RefObject } from "react";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import { errorText, mediaValueSchema, readMedia, useMediaUrl, type NodeViewProps } from "../reactNode";
import { activeVideoReferences, readShotBrief, referenceRoleLabels, reviewCheckLabels, shotBriefSchema, type ShotBrief, type VideoReview } from "../videoShot";
import { readReferences } from "../reactReferences";
import { readMediaSourceSnapshot } from "../mediaEditor";
import MediaDialog from "./reactMediaDialog";
import NodeIcon from "./reactIcon";
import VideoPreview from "./reactVideoPreview";

type GenerationPlan = { prompt: string; characterCount: number; warnings: string[]; references: { index: number; role: keyof typeof referenceRoleLabels; active: boolean; path?: string; requestSlot?: string; providerRole?: string }[] };
type VideoReviewState = { current?: { url: string; mimeType: string }; sourceRevision?: string; duration?: number; status: string; review: VideoReview | null };
type Props = NodeViewProps & { disabled?: boolean };
type ReviewReference = { value: NodeMediaValue; label: string; frozen: boolean; expectedRevision?: string };
const requestSlotLabels: Record<string, string> = { firstFrame: "首帧", lastFrame: "尾帧", images: "图片参考", videos: "视频参考", audios: "音频参考", references: "宿主参考" };

function primaryReviewReference({ node, controller }: Props, candidate?: string): { reference?: ReviewReference; frozen: boolean } {
  const generation = node.data?.generation as { status?: string; output?: NodeMediaValue; request?: Record<string, unknown>; referenceVersions?: Record<string, string> } | undefined;
  const request = generation?.request;
  const frozen = !!request && typeof request === "object" && !Array.isArray(request) && (generation.output ? generation.output.url === candidate : generation.status === "completed");
  function media(value: unknown, type: "image" | "video", label: string): ReviewReference | undefined {
    if (!value || typeof value !== "object") return;
    const source = value as { path?: unknown; url?: unknown; mimeType?: unknown };
    const parsed = mediaValueSchema.safeParse({ url: source.path ?? source.url, mimeType: source.mimeType });
    const expectedRevision = parsed.success && frozen ? generation?.referenceVersions?.[parsed.data.url] : undefined;
    return parsed.success && parsed.data.mimeType.startsWith(`${type}/`) ? { value: parsed.data, label, frozen, ...(typeof expectedRevision === "string" && expectedRevision ? { expectedRevision } : {}) } : undefined;
  }
  function first(values: unknown, type: "image" | "video", label: string) { return Array.isArray(values) ? values.map(value => media(value, type, label)).find(Boolean) : undefined; }
  if (frozen) {
    const references = Array.isArray(request.references) ? request.references.map(input => input && typeof input === "object" && "value" in input ? input.value : undefined) : [];
    return { frozen, reference: media(request.firstFrame, "image", "首帧") ?? first(request.videos, "video", "视频参考") ?? first(request.images, "image", "图片参考") ?? media(request.lastFrame, "image", "尾帧") ?? first(references, "video", "视频参考") ?? first(references, "image", "图片参考") };
  }
  const inputs = activeVideoReferences(node.data ?? {}, readReferences(controller.getNodeService(node.id), node.data ?? {}));
  return { frozen, reference: first(inputs.filter(input => input.dataType === "VIDEO").map(input => input.value), "video", "视频参考") ?? first(inputs.filter(input => input.dataType === "IMAGE").map(input => input.value), "image", "图片参考") };
}

function ReviewReferencePreview({ reference, nodeId, controller, player, onReady }: { reference: ReviewReference; nodeId: string; controller: Props["controller"]; player: RefObject<HTMLVideoElement | null>; onReady(): void }) {
  const [verifiedUrl, setVerifiedUrl] = useState("");
  const { url, error: mediaError } = useMediaUrl(controller, reference.expectedRevision ? undefined : reference.value);
  const [error, setError] = useState("");
  useEffect(() => {
    const lifetime = new AbortController();
    let objectUrl = "";
    // 复用版本绑定的分段读取，避免普通路径URL缓存命中其他版本；源版本不是内容SHA。
    if (reference.expectedRevision) void readMediaSourceSnapshot(controller.getNodeService(nodeId).files, reference.value.url, (reference.value.mimeType.startsWith("video/") ? 2 * 1024 : 100) * 1024 ** 2, lifetime.signal, reference.expectedRevision).then(({ content }) => {
      if (lifetime.signal.aborted) return;
      objectUrl = URL.createObjectURL(new Blob([content], { type: reference.value.mimeType })); setVerifiedUrl(objectUrl);
    }).catch(reason => { if (!lifetime.signal.aborted) setError(`参考文件版本已变化或无法核验，未展示为本次输入：${errorText(reason)}`); });
    return () => { lifetime.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [controller, nodeId, reference.value.url, reference.value.mimeType, reference.expectedRevision]);
  const previewUrl = reference.expectedRevision ? verifiedUrl : url;
  return <div className="nodeReviewReferenceBody">
    {previewUrl && (reference.value.mimeType.startsWith("video/") ? <VideoPreview key={previewUrl} url={previewUrl} label={reference.frozen ? "本次请求视频参考" : "当前连线视频参考"} playerRef={player} muted onReady={onReady} onError={setError} /> : <img src={previewUrl} alt={reference.frozen ? "本次请求图片参考" : "当前连线图片参考"} onError={() => setError("参考图片无法显示，请检查素材文件")} />)}
    {!previewUrl && !mediaError && !error && <p className="nodeStatus" role="status">{reference.expectedRevision ? "正在读取并核验参考文件版本…" : "正在读取参考…"}</p>}
    <p className="nodeStatus" data-state={reference.frozen && reference.expectedRevision ? undefined : "unknown"}>{reference.frozen ? `本次请求参考 · ${reference.label} · ${reference.expectedRevision ? previewUrl ? "文件版本已核验" : error ? "未通过文件版本核验" : "文件版本待核验" : "仅保存路径，无文件版本"}` : "当前连线，非本次请求输入"}</p>
    <span className="nodeReviewReferenceFile" title={reference.value.url}>{reference.value.url.split("/").at(-1)}</span>
    {(error || mediaError) && <p className="nodeError" role="alert">{error || mediaError}</p>}
  </div>;
}

function ShotBriefDialog({ node, controller, disabled, onClose }: Props & { onClose(): void }) {
  const [brief, setBrief] = useState<ShotBrief>(() => readShotBrief(node.data ?? {}) ?? shotBriefSchema.parse({}));
  const [plan, setPlan] = useState<GenerationPlan>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(preview = false) {
    setBusy(true); setError("");
    try {
      await controller.callNodeTool(node.id, "setShotBrief", { brief });
      if (preview) setPlan(await controller.callNodeTool(node.id, "getGenerationPlan", {}) as GenerationPlan);
      else onClose();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  const field = (key: Exclude<keyof ShotBrief, "continuousShot">, label: string) => <label className="nodeField"><span>{label}</span><textarea rows={2} maxLength={key === "action" ? 3000 : ["screenDirection", "framing"].includes(key) ? 1000 : 2000} value={brief[key]} disabled={busy || disabled} onChange={event => { setBrief({ ...brief, [key]: event.target.value }); setPlan(undefined); }} /></label>;
  return <MediaDialog title="本镜头计划" onClose={onClose}><div className="nodeShotDialog">
    <p className="nodeStatus">先确定单一动作与方向，再让模型完成画面。参考缩略图中的「生成职责」可明确排除无关全片指令，或只保留主体外观。</p>
    <div className="nodeFields">{field("subject", "主体与身份")}{field("action", "本镜主要动作")}{field("subjectDirection", "主体相对地面／车身的运动")}{field("cameraMotion", "摄影机如何运动")}</div>
    <details className="nodeDetails"><summary>画面方向与连续性</summary><div className="nodeFields">{field("screenDirection", "主体在画面中的运动方向")}{field("framing", "景别与构图")}{field("continuity", "接续上一镜／下一镜")}</div></details>
    <label><input type="checkbox" checked={brief.continuousShot} disabled={busy || disabled} onChange={event => { setBrief({ ...brief, continuousShot: event.target.checked }); setPlan(undefined); }} /> 保持一个连续镜头，不自行切镜</label>
    <div className="nodeActions"><button type="button" disabled={busy || disabled} onClick={() => void save(true)}>保存并预览实际请求</button><button type="button" className="nodePrimary" disabled={busy || disabled} onClick={() => void save()}>保存计划</button></div>
    {plan && <details className="nodeDetails" open><summary>实际请求 · {plan.characterCount} 字符</summary><div className="nodeShotPlanReferences">{plan.references.map(item => <span key={item.index} title={item.providerRole ? `供应商输入职责：${item.providerRole}` : undefined}>{item.index} · {referenceRoleLabels[item.role]}{item.active ? item.requestSlot ? ` → ${requestSlotLabels[item.requestSlot] ?? item.requestSlot}` : "" : "（已排除）"}{item.path ? ` · ${item.path.split("/").at(-1)}` : ""}</span>)}</div>{plan.warnings.map(message => <p className="nodeStatus" key={message}>{message}</p>)}<pre className="nodeReport">{plan.prompt}</pre></details>}
    {error && <p className="nodeError" role="alert">{error}</p>}
  </div></MediaDialog>;
}

export function VideoReviewDialog({ node, controller, disabled, onClose }: Props & { onClose(): void }) {
  const [snapshot, setSnapshot] = useState<VideoReviewState>();
  const [checks, setChecks] = useState<VideoReview["checks"]>({ direction: "unreviewed", action: "unreviewed", identity: "unreviewed", continuity: "unreviewed", unwantedCuts: "unreviewed", artifacts: "unreviewed" });
  const [start, setStart] = useState(0), [end, setEnd] = useState(0), [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const player = useRef<HTMLVideoElement>(null);
  const referencePlayer = useRef<HTMLVideoElement>(null);
  const comparisonOperation = useRef(0);
  const [comparisonOpen, setComparisonOpen] = useState(false), [candidateReady, setCandidateReady] = useState(false), [referenceReady, setReferenceReady] = useState(false);
  const { url, error: mediaError } = useMediaUrl(controller, snapshot?.current);
  const { reference, frozen } = primaryReviewReference({ node, controller }, snapshot?.current?.url);
  const videoReference = reference?.value.mimeType.startsWith("video/");
  useEffect(() => { setCandidateReady(false); }, [url]);
  useEffect(() => { comparisonOperation.current++; setReferenceReady(false); }, [reference?.value.url, reference?.expectedRevision, comparisonOpen]);
  useEffect(() => {
    let active = true;
    void controller.callNodeTool(node.id, "getVideoReview", {}).then(value => {
      if (!active) return;
      const state = value as VideoReviewState; setSnapshot(state); setEnd(state.review?.end ?? state.duration ?? 0); setStart(state.review?.start ?? 0);
      if (state.review) { setChecks(state.review.checks); setNotes(state.review.notes); }
    }).catch(reason => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [controller, node.id]);
  useEffect(() => () => { comparisonOperation.current++; }, []);
  async function compare(action: "play" | "pause" | "restart") {
    const operation = ++comparisonOperation.current;
    const candidate = player.current, prior = referencePlayer.current;
    if (!candidate || !prior) return;
    candidate.pause(); prior.pause(); setError("");
    if (action === "pause") return;
    const duration = Math.min(candidate.duration, prior.duration);
    const time = action === "restart" || !Number.isFinite(duration) || candidate.currentTime >= duration ? 0 : candidate.currentTime;
    candidate.currentTime = time; prior.currentTime = time; candidate.playbackRate = 1; prior.playbackRate = 1; prior.muted = true;
    try { await Promise.all([candidate.play(), prior.play()]); }
    catch (reason) { if (operation === comparisonOperation.current) { candidate.pause(); prior.pause(); setError(`对照播放失败：${errorText(reason)}`); } }
  }
  async function review(status: "approved" | "rejected") {
    if (!snapshot?.current || !snapshot.sourceRevision) return;
    setBusy(true); setError("");
    try {
      const value = await controller.callNodeTool(node.id, "reviewVideo", { source: snapshot.current.url, sourceRevision: snapshot.sourceRevision, status, start, end, checks, notes }) as VideoReviewState;
      setSnapshot(value);
      onClose();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  function currentTime(fallback: number) { return Math.max(0, Math.min(snapshot?.duration ?? fallback, player.current?.currentTime ?? fallback)); }
  const invalid = disabled || busy || !snapshot?.current || !snapshot.sourceRevision || !notes.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > (snapshot.duration ?? 0);
  return <MediaDialog title="审阅视频候选" onClose={onClose}><div className="nodeShotDialog">
    <div className={`nodeReviewComparison${comparisonOpen ? " nodeReviewComparisonOpen" : ""}`}>
      {reference && <details className="nodeReviewReference" onToggle={event => setComparisonOpen(event.currentTarget.open)}><summary>主参考对照 · {reference.frozen ? "本次请求参考" : "当前连线"}</summary>{comparisonOpen && <ReviewReferencePreview key={JSON.stringify([reference.value.url, reference.value.mimeType, reference.expectedRevision])} reference={reference} nodeId={node.id} controller={controller} player={referencePlayer} onReady={() => setReferenceReady(true)} />}</details>}
      <section className="nodeReviewCandidate"><h4>当前视频候选</h4>{url ? <VideoPreview key={url} url={url} label="当前视频候选" playerRef={player} onReady={() => setCandidateReady(true)} onError={setError} /> : !mediaError && !error && <p className="nodeStatus" role="status">正在读取候选…</p>}</section>
    </div>
    {comparisonOpen && videoReference && <div className="nodeReviewCompareControls"><div className="nodeActions" role="toolbar" aria-label="参考与候选对照播放"><button type="button" disabled={!candidateReady || !referenceReady} onClick={() => void compare("play")}><NodeIcon name="play" />同播</button><button type="button" disabled={!candidateReady || !referenceReady} onClick={() => void compare("pause")}><NodeIcon name="pause" />暂停对照</button><button type="button" disabled={!candidateReady || !referenceReady} onClick={() => void compare("restart")}><NodeIcon name="reset" />从头对照</button></div><p className="nodeStatus">原速按秒对照，参考静音；长度不同时，较短的视频先播放结束。</p></div>}
    {!reference && snapshot && <p className="nodeStatus">{frozen ? "本次请求没有保存图像或视频参考。" : "当前候选没有可用的本次请求参考或有效连线参考。"}</p>}
    <p className="nodeStatus">实际播放并检查所选范围。这里记录你的判断，不会自动识别倒行、切镜或变形；生成成功不代表可用于成片。</p>
    <div className="nodeFields"><label className="nodeField"><span>采用入点（秒）</span><input type="number" min={0} max={snapshot?.duration} step="any" value={start} disabled={busy || disabled} onChange={event => setStart(Number(event.target.value))} /></label><label className="nodeField"><span>采用出点（秒）</span><input type="number" min={0} max={snapshot?.duration} step="any" value={end} disabled={busy || disabled} onChange={event => setEnd(Number(event.target.value))} /></label></div>
    <div className="nodeActions"><button type="button" disabled={!url || busy || disabled} onClick={() => setStart(currentTime(start))}>以当前帧为入点</button><button type="button" disabled={!url || busy || disabled} onClick={() => setEnd(currentTime(end))}>以当前帧为出点</button></div>
    <div className="nodeFields">{Object.entries(reviewCheckLabels).map(([key, label]) => <label className="nodeField" key={key}><span>{label}</span><select value={checks[key as keyof typeof checks]} disabled={busy || disabled} onChange={event => setChecks({ ...checks, [key]: event.target.value })}><option value="unreviewed">尚未检查</option><option value="pass">通过</option><option value="fail">有问题</option><option value="notApplicable">此镜不适用</option></select></label>)}</div>
    <label className="nodeField"><span>审阅证据与取舍</span><textarea rows={3} maxLength={10000} value={notes} disabled={busy || disabled} onChange={event => setNotes(event.target.value)} /></label>
    <div className="nodeActions"><button type="button" disabled={invalid} onClick={() => void review("rejected")}>拒收，保留原片</button><button type="button" className="nodePrimary" disabled={invalid || Object.values(checks).some(value => value === "unreviewed" || value === "fail")} onClick={() => void review("approved")}>通过并采用此范围</button></div>
    {(error || mediaError) && <p className="nodeError" role="alert">{error || mediaError}</p>}
  </div></MediaDialog>;
}

export default function VideoShotControls(props: Props) {
  const [open, setOpen] = useState<"brief" | "review">();
  return <div className="nodeActions"><button type="button" disabled={props.disabled || props.readOnly} onClick={() => setOpen("brief")}><NodeIcon name="text" />镜头计划</button><button type="button" disabled={props.disabled || props.readOnly || !readMedia(props.node.data, "video")} onClick={() => setOpen("review")}><NodeIcon name="movie" />审阅候选</button>
    {open === "brief" && <ShotBriefDialog {...props} onClose={() => setOpen(undefined)} />}{open === "review" && <VideoReviewDialog {...props} onClose={() => setOpen(undefined)} />}
  </div>;
}

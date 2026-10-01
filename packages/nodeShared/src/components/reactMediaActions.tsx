import { useEffect, useRef, useState } from "react";
import { errorText, readMedia, type NodeViewProps } from "../reactNode";
import { mediaEditor, mediaView, readMediaSourceRevision } from "../mediaEditor";
import { useEditorSession } from "../editorSession";
import AudioClipEditor from "./reactAudioClipEditor";
import NodeIcon from "./reactIcon";
import { VideoReviewDialog } from "./videoShotControls";
import VideoEditPlanControls from "./videoEditPlanControls";

export default function MediaActions({ node, controller, readOnly, mediaType, currentTime }: NodeViewProps & { mediaType: "video" | "audio"; currentTime?: () => number }) {
  readOnly = readOnly || ["running", "delegated", "cancelRequested", "unknown"].includes(String((node.data?.generation as { status?: string } | undefined)?.status));
  const draft = mediaEditor(controller.getNodeService(node.id));
  const view = mediaView(controller.getNodeService(node.id));
  const { value: editorView } = useEditorSession(view);
  const { value } = useEditorSession(draft);
  const { start, end } = value;
  const setStart = (start: number) => draft.replace({ ...draft.read().value, start });
  const setEnd = (end: number) => draft.replace({ ...draft.read().value, end });
  const segments = value.groups.flat();
  const setSegments = (next: typeof segments | ((current: typeof segments) => typeof segments)) => draft.replace({ ...draft.read().value, groups: (typeof next === "function" ? next(draft.read().value.groups.flat()) : next).map(range => [range]), selected: 0 });
  const source = readMedia(node.data, mediaType)?.url ?? "";
  useEffect(() => {
    const value = draft.read().value; if (value.source !== source) draft.replace({ source, sourceRevision: null, start: 0, end: 5, groups: [], selected: 0, playhead: 0 });
    const operation = new AbortController();
    if (source && draft.read().value.sourceRevision === null) void readMediaSourceRevision(controller.getNodeService(node.id).files, source, undefined, operation.signal).then(head => { const current = draft.read().value; if (!operation.signal.aborted && current.source === source && current.sourceRevision === null) draft.replace({ ...current, sourceRevision: head.revision }); }).catch(reason => { if (!operation.signal.aborted) setError(errorText(reason)); });
    return () => operation.abort();
  }, [draft, source]);
  const [speed, setSpeed] = useState(1);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [operationState, setOperationState] = useState("idle");
  useEffect(() => { let active = true; const update = () => void controller.callNodeTool(node.id, "getMediaOperationStatus", {}).then(result => { if (active) setOperationState((result as { status: string }).status); }).catch(() => {}); update(); const timer = setInterval(update, 1000); return () => { active = false; clearInterval(timer); }; }, [controller, node.id]);
  const running = busy || ["running", "delegated"].includes(operationState);
  readOnly = readOnly || operationState === "delegated";
  readOnly = readOnly || operationState === "unknown";
  const lifetime = useRef<AbortController | undefined>(undefined);
  async function call(name: string, args: Record<string, unknown> = {}) {
    if (running || readOnly) return;
    setBusy(true); setError("");
    const operation = new AbortController(); lifetime.current = operation;
    try {
      const sourceRevision = draft.read().value.sourceRevision;
      if (name === "clipMedia" && !sourceRevision) throw new Error("素材版本仍在读取，请稍后重试");
      await controller.callNodeTool(node.id, name, { ...args, ...(name === "clipMedia" ? { sourceRevision } : {}) }, operation.signal);
    }
    catch (reason) { if (!operation.signal.aborted) setError(errorText(reason)); }
    finally { if (lifetime.current === operation) lifetime.current = undefined; setBusy(false); }
  }
  return <details className="nodeDetails" open={editorView.open} onToggle={event => { const open = event.currentTarget.open; view.replace({ ...view.read().value, open, ...(!open ? { clipOpen: false } : {}) }); }}><summary>媒体编辑</summary><div className="nodeControls">
    {mediaType === "video" && <div className="nodeActions"><VideoEditPlanControls {...{ node, controller, readOnly }} disabled={running || readOnly} /></div>}
    <div className="nodeFields">
      <label className="nodeField"><span>起点（秒）</span><input type="number" min="0" step=".1" value={start} disabled={busy || readOnly} onChange={event => setStart(Number(event.target.value))} /></label>
      <label className="nodeField"><span>终点（秒）</span><input type="number" min="0" step=".1" value={end} disabled={busy || readOnly} onChange={event => setEnd(Number(event.target.value))} /></label>
    </div>
    <div className="nodeActions"><button type="button" disabled={busy || readOnly} onClick={() => void call("clipMedia", { start, end })}><NodeIcon name="cut" />截取为新节点</button>
      {mediaType === "audio" && <button type="button" disabled={busy || readOnly || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start} onClick={() => setSegments([...segments, { start, end }])}><NodeIcon name="merge" />加入拼接</button>}
      {mediaType === "video" && <><button type="button" disabled={running || readOnly} onClick={() => void call("captureFrame", { time: currentTime?.() ?? start })}><NodeIcon name="camera" />当前帧截图</button><button type="button" disabled={running || readOnly} onClick={() => void call("captureFrame", { position: "first" })}>截取首帧</button><button type="button" disabled={running || readOnly} onClick={() => void call("captureFrame", { position: "last" })}>截取尾帧</button><button type="button" disabled={running || readOnly} onClick={() => void call("extractAudio")}>提取音轨</button><button type="button" disabled={running || readOnly} onClick={() => void call("separateMedia")}>分离音视频</button><button type="button" disabled={running || readOnly} onClick={() => void call("createFrameAnalysis")}>逐帧拉片</button>{!("model" in (node.data ?? {})) && <button type="button" disabled={running || readOnly || !source} onClick={() => setReviewOpen(true)}>审阅视频</button>}</>}
    </div>
    {mediaType === "audio" && segments.length > 0 && <div className="nodeFields">{segments.map((segment, index) => <div className="nodeActions" key={index}><span>{index + 1}. {segment.start}–{segment.end}s</span><button type="button" disabled={busy || readOnly || index === 0} aria-label={`上移片段${index + 1}`} onClick={() => setSegments(items => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>上移</button><button type="button" disabled={busy || readOnly} aria-label={`移除片段${index + 1}`} onClick={() => setSegments(items => items.filter((_item, position) => position !== index))}>移除</button></div>)}<button type="button" disabled={busy || readOnly} onClick={() => void call("clipMedia", { segments })}>按顺序拼接为新节点</button></div>}
    {mediaType === "audio" && <details className="nodeDetails" open={editorView.clipOpen} onToggle={event => view.replace({ ...view.read().value, clipOpen: event.currentTarget.open })}><summary>波形剪辑</summary>{editorView.open && editorView.clipOpen && <AudioClipEditor {...{ node, controller }} readOnly={readOnly || running} />}</details>}
    <label className="nodeField"><span>变速</span><input type="number" min={mediaType === "audio" ? .1 : .25} max="4" step=".1" value={speed} disabled={busy || readOnly} onChange={event => setSpeed(Number(event.target.value))} /></label>
    <div className="nodeActions"><button type="button" disabled={busy || readOnly} onClick={() => void call("changeSpeed", { speed })}><NodeIcon name="copy" />生成变速副本</button><button type="button" disabled={busy || readOnly} onClick={() => void call("transcribeAudio")}><NodeIcon name="microphone" />语音转文本</button>
      {running && <button type="button" onClick={() => { lifetime.current?.abort(new Error("用户取消操作")); void controller.callNodeTool(node.id, "cancelMediaOperation", {}).catch(() => {}); }}>取消</button>}
    </div>{reviewOpen && <VideoReviewDialog {...{ node, controller, readOnly }} disabled={running || readOnly} onClose={() => setReviewOpen(false)} />}{error && <p role="alert" className="nodeError">{error}</p>}
  </div></details>;
}

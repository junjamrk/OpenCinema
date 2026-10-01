import { useEffect, useRef, useState } from "react";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import { errorText, useMediaUrl, mediaValueSchema, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import type { AnalysisResult } from "./videoAnalysis";
import AnalysisReport from "./reactAnalysisReport";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import "@toonflow/node-shared/nodeControls";

export default function FrameAnalysisNodeView({ node, controller, readOnly }: NodeViewProps) {
  const settings: Record<string, unknown> = { method: "adaptive", threshold: 3, minSceneSeconds: .6, frames: true, clips: true, audio: true, aiEnabled: false, focus: "", ...(node.data?.frameAnalysis as Record<string, unknown> ?? {}) };
  const workbench = controller.getNodeService(node.id);
  const inputs = workbench.getInputs("in");
  const source = mediaValueSchema.safeParse(inputs.length ? inputs[0]?.value : settings.source);
  const { url, error: mediaError } = useMediaUrl(controller, source.success ? source.data : undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const player = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<{ status: string; label?: string; percent?: number; error?: string }>();
  const result = settings.lastResult as AnalysisResult | undefined;
  const hostReport = settings.hostReport as { text?: string; manifest?: string } | undefined;
  const resultMatches = result && source.success && settings.resultSource === source.data.url;
  const savedProgress = node.data?.analysisProgress as { status?: string; phase?: string; percent?: number; label?: string } | undefined;
  const currentStatus = savedProgress?.status === "running" && status?.status === "interrupted" ? "interrupted" : savedProgress?.status ?? status?.status;
  const running = ["running", "delegated", "unknown", "interrupted"].includes(currentStatus ?? "");
  useEffect(() => { setPreviewError(""); }, [url]);
  useEffect(() => {
    let active = true;
    const update = () => void controller.callNodeTool(node.id, "getAnalysisStatus", {}).then(value => { if (active) setStatus(value as typeof status); }).catch(reason => { if (active) setError(errorText(reason)); });
    update(); const timer = setInterval(update, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [node.id, controller]);
  async function call(name: string, args: Record<string, unknown> = {}) { setBusy(true); setError(""); try { await controller.callNodeTool(node.id, name, args); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); } }
  function compose() {
    if (readOnly || busy || running || !resultMatches) return;
    try { workbench.focusComposer({}); } catch (reason) { setError(errorText(reason)); }
  }
  const percent = savedProgress?.percent ?? status?.percent;
  return <div className="nodeControls nodrag nopan nowheel">
    {url && <video ref={player} className="nodeMedia" src={url} controls playsInline preload="metadata" onError={() => setPreviewError("当前格式无法预览，仍可尝试本地处理")} />}
    {url && <button type="button" onClick={() => void player.current?.requestFullscreen().catch(reason => setError(errorText(reason)))}><NodeIcon name="expand" />全屏视频</button>}
    <label className="nodeField"><span>{url ? "替换视频" : "视频素材"}</span><input type="file" accept="video/*,.mkv,.mov,.avi,.m4v,.ts" disabled={readOnly || busy || running || inputs.length > 0} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      setBusy(true); setError(""); void (async () => { const extension = file.name.split(".").at(-1)?.toLowerCase() ?? ""; const types: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo", ts: "video/mp2t" }; const mimeType = file.type.startsWith("video/") ? file.type : types[extension]; if (!file.size || !mimeType) throw new Error("请选择非空视频文件"); const path = await uploadNodeFile(controller.getNodeService(node.id).files, node.id, file); await controller.callNodeTool(node.id, "setSource", { url: path, mimeType }); })().catch(reason => setError(errorText(reason))).finally(() => setBusy(false));
    }} /></label>
    <div className="nodeActions">{([['frames','分镜'],['clips','动态'],['audio','原音轨']] as const).map(([key,label]) => <label key={key}><input type="checkbox" checked={!!settings[key]} disabled={readOnly || busy || running} onChange={event => void call("setAnalysisConfig", { [key]: event.target.checked })} />{label}</label>)}</div>
    <div className="nodeFields"><label className="nodeField"><span>检测算法</span><select value={String(settings.method)} disabled={readOnly || running} onChange={event => void call("setAnalysisConfig", { method: event.target.value, threshold: event.target.value === "adaptive" ? 3 : 27 })}><option value="adaptive">自适应变化</option><option value="content">固定变化阈值</option></select></label>
      <label className="nodeField"><span>切镜阈值</span><input type="number" min=".1" max="255" step=".1" value={Number(settings.threshold)} disabled={readOnly || running} onChange={event => void call("setAnalysisConfig", { threshold: Number(event.target.value) })} /></label>
      <label className="nodeField"><span>最短镜头（秒）</span><input type="number" min="0" max="60" step=".1" value={Number(settings.minSceneSeconds)} disabled={readOnly || running} onChange={event => void call("setAnalysisConfig", { minSceneSeconds: Number(event.target.value) })} /></label></div>
    <div className="nodeActions"><button type="button" className="nodePrimary" disabled={readOnly || busy || !source.success} onClick={() => void call(running ? "cancelAnalysis" : "analyzeVideo", running ? {} : { aiEnabled: false })}><NodeIcon name={running ? "close" : "movie"} />{running ? ["unknown", "interrupted"].includes(currentStatus ?? "") ? "确认任务终态" : "取消拉片" : "开始本地拉片"}</button>
      <button type="button" className="nodeComposerAction" disabled={readOnly || busy || running || !resultMatches} onClick={compose} title={resultMatches ? "在底部描述分析重点" : "先完成当前视频的本地拉片"}><NodeIcon name="generate" />交给 Agent 分析</button>
      {(savedProgress?.label || status?.label) && <span className="nodeStatus">{savedProgress?.label || status?.label}</span>}</div>
    {running && <progress className="nodeProgress" aria-label={savedProgress?.phase === "host" ? "宿主分析进度" : "本地拉片进度"} value={savedProgress?.phase !== "host" && typeof percent === "number" && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined} max={100} />}
    {!!settings.focus && <details className="nodeDetails"><summary>分析重点</summary><p className="nodeSavedInstruction">{String(settings.focus)}</p></details>}
    {result && !resultMatches && <span className="nodeStatus">输入已变化，下面保留上次拉片报告</span>}
    {result && <AnalysisReport result={result} controller={controller} hostText={hostReport?.manifest === result.manifest ? hostReport.text : undefined} />}
    {previewError && <span className="nodeStatus">{previewError}</span>}
    {(error || status?.error || mediaError) && <p className="nodeError" role="alert">{error || status?.error || mediaError}</p>}
  </div>;
}

import { useEffect, useState } from "react";
import MediaNode from "@toonflow/node-shared/reactMediaNode";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import NodeError from "@toonflow/node-shared/reactNodeNotice";
import { errorText, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import type { createVideoDepthService } from "./reactService";

export default function VideoDepthView(props: NodeViewProps) {
  const service = props.controller.getPluginService(props.node.id) as ReturnType<typeof createVideoDepthService>;
  const [state, setState] = useState<Awaited<ReturnType<typeof service.getStatus>>>();
  const [error, setError] = useState<unknown>(""), [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [settings, setSettings] = useState({ start: 0, end: 1, sampleFps: 6 });
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const value = await service.getStatus(); if (active) { setState(value); setStatusError(""); } }
      catch (failure) { if (active) setStatusError(errorText(failure)); }
      if (active) timer = setTimeout(refresh, 1500);
    }
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, [service]);
  useEffect(() => { const value = props.node.data?.analysisSettings; if (value) setSettings(value as typeof settings); }, [JSON.stringify(props.node.data?.analysisSettings)]);
  async function call(name: string, args: Record<string, unknown> = {}) {
    setBusy(true); setError("");
    try { await props.controller.callNodeTool(props.node.id, name, args); setState(await service.getStatus()); }
    catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  const running = !!state?.status && !state.status.executionSettled;
  const locked = props.readOnly || busy || running;
  let input; try { input = service.source(); } catch {}
  const adopted = state?.result?.operationId === state?.status?.operationId;
  return <MediaNode {...props} mediaType="video" disabled compact fallbackPreview={input} fallbackCaption="原视频" emptyAction={<span className="nodeStatus">连接原视频后提取深度</span>}
    toolbarAction={<><button type="button" className="nodeMediaTool nodeMediaToolPrimary" title="提取深度" aria-label="提取深度" aria-busy={busy} disabled={props.readOnly || busy || running || !input} onClick={() => void call("runDepth")}><NodeIcon name="movie" /></button>
      {running && <button type="button" className="nodeMediaTool" title="取消深度任务" aria-label="取消深度任务" disabled={props.readOnly || busy} onClick={() => void call("cancelDepth")}><NodeIcon name="close" /></button>}
      {state?.status?.state === "succeeded" && !adopted && <button type="button" className="nodeMediaTool nodeMediaToolPrimary" title="采用深度结果" aria-label="采用深度结果" disabled={props.readOnly || busy} onClick={() => void call("applyDepthResult")}><NodeIcon name="check" /></button>}</>}>
    <div className="nodeStatus" role="status">{state?.status ? ({ running: "正在提取深度", preparing: "正在准备", cancelling: "正在取消", succeeded: adopted ? "深度结果已保存" : "深度结果可采用", failed: "提取失败", cancelled: state.result ? "已取消，保留已保存结果" : "已取消", unknown: "原任务终态未知" }[state.status.state] ?? state.status.state) : "Video Depth Anything Small"}</div>
    <NodeError error={error || statusError || (state?.status?.state !== "cancelled" && state?.status?.error)} />
    <details><summary>处理范围</summary><div className="nodeFields">
      <label>开始（秒）<input type="number" min="0" step="0.1" disabled={locked} value={settings.start} onChange={event => setSettings({ ...settings, start: Number(event.target.value) })} /></label>
      <label>结束（秒）<input type="number" min="0.1" step="0.1" disabled={locked} value={settings.end} onChange={event => setSettings({ ...settings, end: Number(event.target.value) })} /></label>
      <label>采样帧率<input type="number" min="2" max="12" disabled={locked} value={settings.sampleFps} onChange={event => setSettings({ ...settings, sampleFps: Number(event.target.value) })} /></label>
      <button type="button" disabled={props.readOnly || busy || running || !state} onClick={() => void call("setDepthSettings", { ...settings, expectedRevision: state?.revision })}>应用范围</button>
    </div></details>
  </MediaNode>;
}

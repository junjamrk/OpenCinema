import { useEffect, useRef, useState } from "react";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import { errorText, useMediaUrl, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import "@toonflow/node-shared/nodeControls";
import { maximumSplatBytes, splatFileAccept, splatFormatOf } from "./splatFile";
import { createSplatStage, type SplatCamera, type SplatStage } from "./splatStage";
import type { RenderStatus, SplatSource } from "./reactPlugin";
import "./styles.css";

type Media = { url: string; mimeType: string };

// 节点内的交互查看器：拖动旋转、滚轮缩放、右键平移。已保存机位变化时跟随。
function Viewport({ nodeId, controller, source, camera, stageRef }: { nodeId: string; controller: NodeViewProps["controller"]; source: SplatSource; camera?: SplatCamera; stageRef: { current: SplatStage | undefined } }) {
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<{ phase: "loading" | "ready" | "error"; message?: string }>({ phase: "loading" });
  const initialCamera = useRef(camera);
  useEffect(() => {
    const lifetime = new AbortController();
    const stage = createSplatStage({ canvas: canvas.current!, interactive: true });
    stageRef.current = stage;
    const observer = new ResizeObserver(() => {
      const width = Math.round(host.current?.getBoundingClientRect().width ?? 0);
      if (width > 0) stage.setSize(width, Math.round(width * 9 / 16));
    });
    observer.observe(host.current!);
    void (async () => {
      try {
        const content = await controller.getNodeService(nodeId).files.read(source.path, maximumSplatBytes, lifetime.signal);
        await stage.load(content, source.format, lifetime.signal);
        if (initialCamera.current) stage.setCamera(initialCamera.current); else stage.frame();
        setState({ phase: "ready" });
      } catch (error) { if (!lifetime.signal.aborted) setState({ phase: "error", message: errorText(error) }); }
    })();
    return () => { lifetime.abort(); observer.disconnect(); if (stageRef.current === stage) stageRef.current = undefined; void stage.dispose(); };
  }, [source.path, source.sha256]);
  const cameraKey = JSON.stringify(camera ?? null);
  useEffect(() => { if (camera && state.phase === "ready") stageRef.current?.setCamera(camera); }, [cameraKey, state.phase]);
  return <div ref={host} className="gaussianSplatViewport nodrag nopan nowheel">
    <canvas ref={canvas} tabIndex={0} aria-label="Gaussian Splat 三维视图" />
    {state.phase !== "ready" && <div className="gaussianSplatOverlay" role={state.phase === "error" ? "alert" : "status"}>{state.phase === "loading" ? `正在加载 ${source.splatCount.toLocaleString("en-US")} 个 Gaussian…` : state.message}</div>}
  </div>;
}

export default function GaussianSplatNodeView({ node, controller, readOnly }: NodeViewProps) {
  const service = controller.getNodeService(node.id);
  const data = node.data ?? {};
  const source = (data.splat ?? undefined) as SplatSource | undefined;
  const camera = (data.camera ?? undefined) as SplatCamera | undefined;
  const render = (data.splatRender ?? { status: "idle" }) as RenderStatus;
  const outputs = data.outputs as { image?: { value?: Media }; video?: { value?: Media } } | undefined;
  const connected = service.getInputs("source").some(input => input.value);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const stageRef = useRef<SplatStage>(undefined);
  const image = useMediaUrl(controller, outputs?.image?.value), video = useMediaUrl(controller, outputs?.video?.value);
  const running = render.status === "running";
  const locked = readOnly || busy || running;
  const call = (name: string, args: Record<string, unknown> = {}) => controller.callNodeTool(node.id, name, args);
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function upload(file: File) {
    if (!splatFormatOf(file.name)) throw new Error("仅支持 .ply / .splat / .ksplat / .spz 扫描文件");
    if (!file.size || file.size > maximumSplatBytes) throw new Error("扫描文件须非空且不超过 100 MiB");
    const path = await uploadNodeFile(service.files, node.id, file);
    await call("setSplatSource", { path });
  }
  return <div className="nodeControls gaussianSplatNode nodrag nopan nowheel">
    <input ref={fileInput} className="nodeFileInput" type="file" accept={splatFileAccept} aria-label="选择 Gaussian 扫描文件" disabled={locked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void act(() => upload(file)); }} />
    {!source ? <>
      <button type="button" className="nodeUploadArea" disabled={locked} onClick={() => fileInput.current?.click()}><NodeIcon name="upload" size={20} />选择 Gaussian 扫描（.ply / .splat / .ksplat / .spz）</button>
      {connected && <div className="nodeActions"><button type="button" disabled={locked} onClick={() => void act(() => call("setSplatSource", {}))}><NodeIcon name="link" />使用上游文件</button></div>}
    </> : <>
      <Viewport key={source.sha256} nodeId={node.id} controller={controller} source={source} camera={camera} stageRef={stageRef} />
      <span className="nodeStatus gaussianSplatMeta" title={source.path}>{source.name} · {source.format.toUpperCase()} · {source.splatCount.toLocaleString("en-US")} splats · {(source.bytes / 1024 ** 2).toFixed(1)} MiB</span>
      <div className="nodeActions">
        <button type="button" disabled={locked} title="把当前查看机位保存到节点；渲染与 Agent 默认使用它" onClick={() => void act(async () => { const current = stageRef.current?.getCamera(); if (!current) throw new Error("视图尚未就绪"); await call("setCamera", { camera: current }); })}><NodeIcon name="camera" />保存机位</button>
        <button type="button" disabled={locked} title="按扫描包围球自动取景并保存" onClick={() => void act(() => call("frameCamera", {}))}><NodeIcon name="reset" />自动取景</button>
        <button type="button" className="nodePrimary" disabled={locked} title="渲染 1280×720 PNG 到 image 端口" onClick={() => void act(() => call("renderStill", {}))}><NodeIcon name="camera" />渲染静帧</button>
        <button type="button" disabled={locked} title="后台渲染 4 秒 24fps 环绕视频到 video 端口（需要 FFmpeg）" onClick={() => void act(() => call("renderTurntable", {}))}><NodeIcon name="movie" />环绕视频</button>
        {running && <button type="button" disabled={busy} onClick={() => void act(() => call("cancelRender", {}))}>取消</button>}
        <button type="button" disabled={locked} title="更换扫描文件" onClick={() => fileInput.current?.click()}><NodeIcon name="upload" />更换</button>
      </div>
      {running && <span className="nodeStatus" role="status">{render.phase ?? "正在渲染"}{typeof render.progress === "number" ? ` · ${render.progress}%` : ""}</span>}
      {render.status === "interrupted" && <span className="nodeStatus">上次渲染已中断，未发布产物</span>}
      {(render.status === "failed" || render.status === "cancelled") && render.error && <p className="nodeError" role="alert">{render.error}</p>}
      {(image.url || video.url) && <div className="gaussianSplatOutputs">
        {image.url && <img src={image.url} alt="渲染静帧" />}
        {video.url && <video src={video.url} controls muted playsInline preload="metadata" />}
      </div>}
    </>}
    {(error || image.error || video.error) && <p className="nodeError" role="alert">{error || image.error || video.error}</p>}
  </div>;
}

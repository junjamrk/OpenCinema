import NodeIcon from "@toonflow/node-shared/reactIcon";
import { useEffect, useState } from "react";
import { errorText, useMediaUrl, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import type { AnalysisResult } from "./videoAnalysis";

export default function AnalysisReport({ result, controller, hostText }: { result: AnalysisResult; controller: NodeViewProps["controller"]; hostText?: string }) {
  const [selected, setSelected] = useState(result.scenes[0]?.index ?? 0);
  const [kind, setKind] = useState("image");
  const [error, setError] = useState("");
  const scene = result.scenes.find(scene => scene.index === selected) ?? result.scenes[0];
  const path = kind === "video" && scene?.video ? scene.video : scene?.image ?? scene?.video;
  const mimeType = path === scene?.image ? "image/jpeg" : "video/mp4";
  const { url, error: mediaError } = useMediaUrl(controller, path ? { url: path, mimeType } : undefined);
  useEffect(() => { setSelected(result.scenes[0]?.index ?? 0); setError(""); }, [result.manifest]);
  async function download() {
    try {
      const media = await controller.acquireMedia(result.manifest, "application/json");
      const link = document.createElement("a"); link.href = media.url; link.download = "sceneManifest.json"; link.click(); setTimeout(media.release, 1000);
    } catch (reason) { setError(errorText(reason)); }
  }
  return <details className="nodeDetails"><summary>{result.scenes.length} 个镜头 · {result.duration.toFixed(2)} 秒 · {result.width} × {result.height}{result.audio ? " · 原音轨" : ""}</summary>
    <div className="nodeControls">
      <button type="button" onClick={() => void download()}><NodeIcon name="download" />下载拉片清单</button>
      {result.warning && <p className="nodeStatus">{result.warning}</p>}
      {result.ai?.overviewError && <p className="nodeError" role="alert">整段归纳未完成：{result.ai.overviewError}</p>}
      {result.overview && <details className="nodeDetails" open><summary>整段分析</summary>{([['summary','整体概述'],['narrative','叙事结构'],['rhythm','节奏分析'],['editing','剪辑方式'],['focusResponse','分析重点']] as const).map(([key,label]) => result.overview?.[key] ? <section key={key}><strong>{label}</strong><p style={{ whiteSpace: "pre-wrap" }}>{result.overview[key]}</p></section> : null)}</details>}
      {hostText && <details className="nodeDetails" open><summary>宿主分析报告</summary><pre className="nodeReport">{hostText}</pre></details>}
      {scene && <>
        <label className="nodeField"><span>镜头明细</span><select value={scene.index} onChange={event => { setSelected(Number(event.target.value)); setError(""); }}>{result.scenes.map(item => <option key={item.index} value={item.index}>S{String(item.index).padStart(2, "0")} · {item.start.toFixed(3)}–{item.end.toFixed(3)}s · {(item.end - item.start).toFixed(2)}秒</option>)}</select></label>
        {scene.image && scene.video && <div className="nodeActions"><button type="button" aria-pressed={kind === "image"} onClick={() => setKind("image")}>关键帧</button><button type="button" aria-pressed={kind === "video"} onClick={() => setKind("video")}>视频片段</button></div>}
        {url && (mimeType === "image/jpeg" ? <img className="nodeMedia" src={url} alt={`镜头S${scene.index}关键帧`} onError={() => setError("关键帧无法预览，请检查素材文件")} /> : <video key={url} className="nodeMedia" src={url} controls playsInline preload="metadata" onError={() => setError("镜头片段无法预览，请检查素材文件")} />)}
        {scene.annotation && <div className="nodeControls"><strong>{scene.annotation.shotSize} · {scene.annotation.cameraAngle}</strong><p>{scene.annotation.description}</p><strong>镜头运动</strong><p>{scene.annotation.movement}</p></div>}
      </>}
      {(error || mediaError) && <p className="nodeError" role="alert">{error || mediaError}</p>}
    </div>
  </details>;
}

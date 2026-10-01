import NodeIcon from "@toonflow/node-shared/reactIcon";
import { useEffect, useRef, useState } from "react";
import { createPanoramaRenderer, type PanoramaSettings } from "./panoramaRenderer";

export default function PanoramaPreview({ url, settings, disabled, onChange }: { url: string; settings: PanoramaSettings; disabled?: boolean; onChange(value: PanoramaSettings): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const projector = useRef<ReturnType<typeof createPanoramaRenderer> | undefined>(undefined);
  const latest = useRef(settings); latest.current = settings;
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | undefined>(undefined);
  const [error, setError] = useState("");
  const [original, setOriginal] = useState(false);
  const [grid, setGrid] = useState(false);
  const compare = useRef(original); compare.current = original;
  function render() { if (projector.current && host.current) { const width = Math.max(1, host.current.clientWidth); projector.current.render(latest.current, width, Math.round(width * 9 / 16), compare.current); } }
  useEffect(() => {
    let disposed = false;
    const image = new Image(); image.src = url;
    let observer: ResizeObserver | undefined;
    void image.decode().then(() => {
      if (disposed || !canvas.current || !host.current) return;
      const source = document.createElement("canvas"); source.width = image.naturalWidth; source.height = image.naturalHeight;
      if (source.width * source.height > 32 * 1024 ** 2) throw new Error("全景预览支持最多 3200 万像素");
      source.getContext("2d")!.drawImage(image, 0, 0);
      projector.current = createPanoramaRenderer(source, settings.mode, canvas.current); observer = new ResizeObserver(render); observer.observe(host.current); render(); setError("");
    }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : "当前设备无法显示全景预览"); });
    return () => { disposed = true; observer?.disconnect(); projector.current?.dispose(); projector.current = undefined; };
  }, [url, settings.mode]);
  useEffect(render, [settings, original]);
  return <><div className="nodeActions"><button type="button" aria-pressed={original} onClick={() => setOriginal(!original)}>对比原图</button><button type="button" aria-pressed={grid} onClick={() => setGrid(!grid)}><NodeIcon name="grid" />参考线</button><button type="button" disabled={disabled} onClick={() => onChange({ ...settings, yaw: 0, pitch: 0, fov: 60 })}><NodeIcon name="reset" />重置视角</button></div>
    <div ref={host} className="imagePanoramaStage" tabIndex={0} role="application" aria-label="全景预览，拖动或方向键旋转，滚轮缩放，Home重置"
      onPointerDown={event => { if (disabled || event.button !== 0) return; event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, yaw: settings.yaw ?? 0, pitch: settings.pitch ?? 0 }; }}
      onPointerMove={event => { const current = drag.current; if (!current || disabled) return; event.stopPropagation(); const scale = (settings.fov ?? 60) / Math.max(1, event.currentTarget.clientHeight); onChange({ ...settings, yaw: ((current.yaw - (event.clientX - current.x) * scale) % 360 + 360) % 360, pitch: Math.max(-85, Math.min(85, current.pitch + (event.clientY - current.y) * scale)) }); }}
      onPointerUp={event => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}
      onWheel={event => { if (disabled) return; event.stopPropagation(); onChange({ ...settings, fov: Math.max(20, Math.min(projector.current?.maxFov ?? 100, (settings.fov ?? 60) + Math.sign(event.deltaY) * 3)) }); }}
      onKeyDown={event => { if (disabled || !["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","+","=","-","Home"].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 1 : 5;
        if (event.key === "Home") { onChange({ ...settings, yaw: 0, pitch: 0, fov: 60 }); return; }
        if (["+","=","-"].includes(event.key)) { onChange({ ...settings, fov: Math.max(20, Math.min(100, (settings.fov ?? 60) + (event.key === "-" ? 3 : -3))) }); return; }
        onChange({ ...settings, yaw: (((settings.yaw ?? 0) + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0)) % 360 + 360) % 360, pitch: Math.max(-85, Math.min(85, (settings.pitch ?? 0) + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0))) });
      }}><canvas key={`${url}:${settings.mode}`} ref={canvas} style={{ display: "block", width: "100%", aspectRatio: "16 / 9" }} />{grid && <span className="imagePanoramaGrid" aria-hidden="true" />}</div>
    {error && <p role="alert" className="nodeError">{error}</p>}
  </>;
}
